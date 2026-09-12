import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { NativeSqliteDriver, StorageError } from "@operon/runtime";
import { Effect, Schema } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

import type { DatabaseTarget } from "./state.js";

const ddl =
  "CREATE TABLE IF NOT EXISTS operon_workspace_state (workspace_id TEXT PRIMARY KEY, payload TEXT NOT NULL)";
const select =
  "SELECT payload FROM operon_workspace_state WHERE workspace_id = $1";
const upsert =
  "INSERT INTO operon_workspace_state (workspace_id, payload) VALUES ($1, $2) ON CONFLICT (workspace_id) DO UPDATE SET payload = excluded.payload";
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Tuple([Schema.String]))
);
const storageError = (cause: unknown) =>
  new StorageError({
    message: "The workspace state could not be read or persisted.",
    cause,
  });

/** One writer per workspace; each acknowledged checkpoint is a single atomic database write. */
export const openWorkspaceState = Effect.fn("openWorkspaceState")(function* (
  target: DatabaseTarget,
  workspaceId: string
) {
  if (target.kind === "memory") {
    return yield* new StorageError({
      message: "Workspace MCP requires --db or OPERON_DATABASE_URL.",
    });
  }
  if (target.kind === "sqlite") {
    const lease = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(path.dirname(target.path), {
            recursive: true,
            mode: 0o700,
          });
          const db = new NativeSqliteDriver(`${target.path}.lease`);
          chmodSync(`${target.path}.lease`, 0o600);
          return db;
        },
        catch: storageError,
      }),
      (db) => Effect.sync(() => db.close())
    );
    yield* lease.execute("PRAGMA busy_timeout = 25000");
    yield* lease.execute("BEGIN IMMEDIATE");
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new NativeSqliteDriver(target.path),
        catch: storageError,
      }),
      (database) => Effect.sync(() => database.close())
    );
    yield* Effect.try({
      try: () => {
        chmodSync(target.path, 0o600);
      },
      catch: storageError,
    });
    yield* db.execute(ddl);
    return {
      load: db.execute(select.replace("$1", "?"), [workspaceId]).pipe(
        Effect.map((result) => result.rows[0]),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.UndefinedOr(Schema.Struct({ payload: Schema.String }))
          )
        ),
        Effect.map((row) => row?.payload),
        Effect.mapError(storageError)
      ),
      save: (payload: string) =>
        db
          .execute(upsert.replaceAll(/\$\d+/gu, "?"), [workspaceId, payload])
          .pipe(Effect.asVoid),
    };
  }
  const sql = yield* PgClient.make({
    url: target.url,
    maxConnections: 1,
    applicationName: "operon-workspace",
  }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(storageError));
  const connection = yield* sql.reserve.pipe(Effect.mapError(storageError));
  const execute = (query: string, values: readonly unknown[] = []) =>
    connection.executeValues(query, values).pipe(Effect.mapError(storageError));
  // Serialize first-time DDL independently of the workspace writer lock.
  yield* execute(
    "SELECT pg_advisory_lock(hashtextextended('operon:workspace-schema', 0))"
  );
  yield* execute(ddl).pipe(
    Effect.ensuring(
      execute(
        "SELECT pg_advisory_unlock(hashtextextended('operon:workspace-schema', 0))"
      ).pipe(Effect.orDie)
    )
  );
  yield* Effect.acquireRelease(
    execute("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      `operon:workspace:${workspaceId}`,
    ]),
    () =>
      execute("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `operon:workspace:${workspaceId}`,
      ]).pipe(Effect.orDie)
  );
  return {
    load: execute(select, [workspaceId]).pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows[0]?.[0]),
      Effect.mapError(storageError)
    ),
    save: (payload: string) =>
      execute(upsert, [workspaceId, payload]).pipe(Effect.asVoid),
  };
});
