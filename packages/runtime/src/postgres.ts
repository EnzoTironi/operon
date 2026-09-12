import { PgClient } from "@effect/sql-pg";
import type { Redacted } from "effect";
import { Effect } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { isSqlError } from "effect/unstable/sql/SqlError";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Pg from "pg";

import { StorageError } from "./errors.js";
import type { SqlDialect, SqlDriver, SqlQueryResult } from "./sql-store.js";
import { SqlSchemaGenerator } from "./sql-store.js";

export interface PostgresDriverConfig {
  /** Full connection URL, usually `OPERON_DATABASE_URL`. */
  readonly url: Redacted.Redacted<string>;
  /** Pool size. Defaults to 10. */
  readonly maxConnections?: number;
}

/**
 * Column decoding at the database boundary so rows match `SqlBitemporalRecord`:
 * `BIGINT` epoch milliseconds become numbers (they stay under 2^53) and
 * `JSONB` payloads stay serialized strings, which the store parses itself.
 */
const bitemporalTypes: Pg.CustomTypesConfig = {
  getTypeParser: (oid: number, format?: "text" | "binary") => {
    if (oid === Pg.types.builtins.INT8) {
      return Number;
    }
    if (oid === Pg.types.builtins.JSONB || oid === Pg.types.builtins.JSON) {
      return (value: string) => value;
    }
    return format === "binary"
      ? Pg.types.getTypeParser(oid, format)
      : Pg.types.getTypeParser(oid);
  },
};

const toStorageError = (error: SqlError): StorageError =>
  new StorageError({
    cause: error.reason,
    message: `PostgreSQL ${error.reason._tag}: ${error.message}`,
  });

/**
 * Writers take a table lock for the duration of a transaction so optimistic
 * version checks and the slice inserts that follow them cannot interleave.
 * Readers are not blocked. This mirrors the single-writer semantics the
 * SQLite driver gets from `BEGIN IMMEDIATE`.
 */
const WRITER_LOCK =
  "LOCK TABLE operon_objects, operon_links IN SHARE ROW EXCLUSIVE MODE;";

/**
 * PostgreSQL driver for `SqlBitemporalStore`, backed by `@effect/sql-pg`.
 *
 * `PostgresDriver.connect` is scoped: the pool closes when the scope does.
 * Connecting applies the bitemporal DDL (`CREATE ... IF NOT EXISTS`), so a
 * fresh cell database is usable immediately and reconnecting is idempotent.
 */
export class PostgresDriver implements SqlDriver {
  public readonly dialect: SqlDialect = "postgres";

  private constructor(private readonly sql: PgClient.PgClient) {}

  static readonly connect = Effect.fn("PostgresDriver.connect")(function* (
    config: PostgresDriverConfig
  ) {
    const client = yield* PgClient.make({
      applicationName: "operon-cell",
      maxConnections: config.maxConnections ?? 10,
      types: bitemporalTypes,
      url: config.url,
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(toStorageError));
    const driver = new PostgresDriver(client);
    yield* driver.applySchema();
    return driver;
  });

  private applySchema(): Effect.Effect<void, StorageError> {
    return Effect.forEach(
      SqlSchemaGenerator.generateDDL("postgres"),
      (statement) => this.execute(statement),
      { concurrency: 1, discard: true }
    );
  }

  execute(
    sql: string,
    params: readonly unknown[] = []
  ): Effect.Effect<SqlQueryResult, StorageError> {
    return this.sql.unsafe(sql, params).raw.pipe(
      Effect.map((raw): SqlQueryResult => {
        // SAFETY: `PgClient` connections resolve `raw` with the `pg.Result` of the statement
        const result = raw as Pg.QueryResult<Record<string, unknown>>;
        return {
          rows: result.rows,
          rowsAffected: result.rowCount ?? 0,
        };
      }),
      Effect.mapError(toStorageError)
    );
  }

  readonly transaction = Effect.fn("PostgresDriver.transaction")(function* <
    A,
    E,
    R,
  >(
    this: PostgresDriver,
    fn: (tx: SqlDriver) => Effect.Effect<A, E, R>
  ): Effect.fn.Return<A, E | StorageError, R> {
    return yield* this.sql
      .withTransaction(Effect.andThen(this.sql.unsafe(WRITER_LOCK), fn(this)))
      .pipe(Effect.catchIf(isSqlError, (error) => toStorageError(error)));
  });
}

/** Postgres URLs are the only accepted shape for a cell database target. */
export function isPostgresUrl(value: string): boolean {
  return value.startsWith("postgres://") || value.startsWith("postgresql://");
}
