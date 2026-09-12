import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Config, Effect, Layer } from "effect";

import { CellStagePolicy } from "./src/cell-stage.ts";
import {
  CELL_POSTGRES_HOST,
  CELL_POSTGRES_USER,
  cellDatabaseUrlTemplate,
} from "./src/connection.ts";

const providers = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.RemoteImage, Docker.Volume])
).pipe(
  Layer.provide(
    Layer.mergeAll(
      Docker.ContainerProvider(),
      Docker.RemoteImageProvider(),
      Docker.VolumeProvider()
    )
  ),
  Layer.provideMerge(Docker.DockerLive)
);

/**
 * Operon cell: PostgreSQL 17 in Docker, one stack instance per `--stage`.
 *
 * Three resources: a cached image reference, a named data volume and a
 * running container with a healthcheck, published on loopback at the
 * stage's deterministic port. Alchemy state lives in the ignored
 * `.alchemy/` directory next to this file. The password comes from
 * `OPERON_POSTGRES_PASSWORD` and is never returned or logged; the output
 * carries a URL template with a placeholder instead.
 */
export default Alchemy.Stack(
  "OperonCell",
  {
    providers,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const policy = yield* CellStagePolicy;
    const password = yield* Config.redacted("OPERON_POSTGRES_PASSWORD");

    const image = yield* Docker.RemoteImage("PostgresImage", {
      alwaysPull: false,
      name: "postgres",
      tag: "17-alpine",
    });

    const data = yield* Docker.Volume("PostgresData", {}).pipe(
      RemovalPolicy.retain(policy.retainPostgresData)
    );

    const postgres = yield* Docker.Container("Postgres", {
      environment: {
        POSTGRES_DB: policy.database,
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: CELL_POSTGRES_USER,
      },
      healthcheck: {
        cmd: `pg_isready -U ${CELL_POSTGRES_USER} -d ${policy.database}`,
        interval: "2 seconds",
        retries: 10,
        timeout: "5 seconds",
      },
      image,
      ports: [
        { external: `${CELL_POSTGRES_HOST}:${policy.port}`, internal: 5432 },
      ],
      restart: "unless-stopped",
      start: true,
      volumes: [
        { containerPath: "/var/lib/postgresql/data", hostPath: data.name },
      ],
    });

    return {
      container: postgres.name,
      database: policy.database,
      databaseUrlTemplate: cellDatabaseUrlTemplate(
        policy.database,
        policy.port
      ),
      documented: policy.documented,
      host: CELL_POSTGRES_HOST,
      port: policy.port,
      retainPostgresData: policy.retainPostgresData,
      stage: policy.stage,
      tier: policy.tier,
      user: CELL_POSTGRES_USER,
      volume: data.name,
    };
  }).pipe(Effect.provide(CellStagePolicy.layer))
);
