import type { Redacted } from "effect";
import { Effect, Schedule } from "effect";
import { Client } from "pg";

import { addChannelAuthForeignKeysSql, CELL_AUTH_DDL } from "./auth-schema.js";
import type { CellPostgresConnection } from "./connection.js";
import { formatCellDatabaseUrl } from "./connection.js";

const schemaRetry = Schedule.exponential("200 millis").pipe(
  Schedule.upTo({ times: 20 })
);

function applyStatements(
  client: Client,
  statements: readonly string[]
): Effect.Effect<void, Error> {
  return Effect.forEach(
    statements,
    (sql) =>
      Effect.tryPromise({
        catch: (cause) =>
          new Error(
            `Cell auth schema statement failed: ${cause instanceof Error ? cause.message : String(cause)}`
          ),
        try: () => client.query(sql),
      }),
    { concurrency: 1, discard: true }
  );
}

export const applyCellAuthSchema = Effect.fn("applyCellAuthSchema")(function* (
  connection: CellPostgresConnection,
  password: Redacted.Redacted<string>
) {
  const url = formatCellDatabaseUrl(connection, password);
  const client = new Client({ connectionString: url });
  yield* Effect.tryPromise({
    catch: (cause) =>
      new Error(
        `Cell Postgres is not ready on ${connection.host}:${connection.port}: ${cause instanceof Error ? cause.message : String(cause)}`
      ),
    try: () => client.connect(),
  }).pipe(
    Effect.flatMap(() => applyStatements(client, CELL_AUTH_DDL)),
    Effect.flatMap(() =>
      applyStatements(client, addChannelAuthForeignKeysSql())
    ),
    Effect.ensuring(Effect.promise(() => client.end()).pipe(Effect.asVoid))
  );
});

export const applyCellAuthSchemaWhenReady = Effect.fn(
  "applyCellAuthSchemaWhenReady"
)(function* (
  connection: CellPostgresConnection,
  password: Redacted.Redacted<string>
) {
  yield* applyCellAuthSchema(connection, password).pipe(
    Effect.retry(schemaRetry)
  );
});
