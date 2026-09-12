import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Config, Effect } from "effect";

import { applyCellAuthSchemaWhenReady } from "./apply-schema.js";
import { cellPostgresConnection, publishedPostgresPort } from "./connection.js";
import { CellStagePolicy } from "./stage.js";

/**
 * Operon cell Alchemy composition: Postgres 17 on the local Docker context.
 *
 * One Better Auth store lives in this database. Companion remains the only
 * interactive auth host. This program never prints the database password.
 */
const cellStack = Alchemy.Stack(
  "OperonCell",
  {
    providers: Docker.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const policy = yield* CellStagePolicy;
    const password = yield* Config.redacted("OPERON_POSTGRES_PASSWORD");
    const volumeName = `operon-cell-pgdata-${policy.stage}`;
    const containerName = `operon-cell-postgres-${policy.stage}`;
    yield* Docker.RemoteImage("PostgresImage", {
      alwaysPull: false,
      name: "postgres",
      tag: "17-alpine",
    });
    yield* Docker.Volume("PostgresData", { name: volumeName }).pipe(
      RemovalPolicy.retain(policy.retainPostgresData)
    );
    yield* Docker.Container("Postgres", {
      environment: {
        POSTGRES_DB: policy.database,
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: "postgres",
      },
      healthcheck: {
        cmd: `pg_isready -U postgres -d ${policy.database}`,
        interval: "2 seconds",
        retries: 10,
        timeout: "5 seconds",
      },
      image: "postgres:17-alpine",
      name: containerName,
      ports: [{ external: "127.0.0.1:", internal: 5432 }],
      start: true,
      volumes: [
        {
          containerPath: "/var/lib/postgresql/data",
          hostPath: volumeName,
        },
      ],
    });
    const runtime = yield* Docker.inspectContainer(containerName).pipe(
      Effect.orDie
    );
    const port = publishedPostgresPort(runtime.ports);
    if (port === undefined) {
      return yield* Effect.die(
        "Cell Postgres published 5432/tcp is missing after deploy"
      );
    }
    const connection = cellPostgresConnection({
      container: runtime.name,
      database: policy.database,
      port,
      stage: policy.stage,
      volume: volumeName,
    });
    yield* applyCellAuthSchemaWhenReady(connection, password).pipe(
      Effect.orDie
    );
    return {
      connection,
      database: policy.database,
      documented: policy.documented,
      envFileHint: policy.envFileHint,
      retainPostgresData: policy.retainPostgresData,
      stage: policy.stage,
      tier: policy.tier,
    };
  }).pipe(Effect.provide(CellStagePolicy.layer))
);

export default cellStack;
