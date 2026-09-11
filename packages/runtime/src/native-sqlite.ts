import { createRequire } from "node:module";

import { Effect } from "effect";

import { StorageError } from "./errors.js";
import type { SqlDialect, SqlDriver, SqlQueryResult } from "./sql-store.js";
import { SqlSchemaGenerator } from "./sql-store.js";

const nodeRequire = createRequire(import.meta.url);

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...params: readonly unknown[]) => readonly unknown[];
    run: (...params: readonly unknown[]) => { changes: number | bigint };
  };
  close: () => void;
}

/**
 * Native SQLite driver backed by Node 22+ built-in node:sqlite (DatabaseSync).
 * Provides genuine ACID transactional commits, prepared statements, and disk persistence.
 */
export class NativeSqliteDriver implements SqlDriver {
  private readonly db: SqliteDatabase;
  public readonly dialect: SqlDialect = "sqlite";

  constructor(databasePath = ":memory:") {
    const { DatabaseSync } = nodeRequire("node:sqlite");
    this.db = new DatabaseSync(databasePath) as SqliteDatabase;
    // Initialize schema DDL
    const ddl = SqlSchemaGenerator.generateDDL("sqlite");
    for (const statement of ddl) {
      this.db.exec(statement);
    }
  }

  execute(
    sql: string,
    params: readonly unknown[] = []
  ): Effect.Effect<SqlQueryResult, StorageError> {
    return Effect.try({
      try: () => {
        const normalized = sql.trim().toUpperCase();
        if (normalized.startsWith("SELECT")) {
          const stmt = this.db.prepare(sql);
          const rows = stmt.all(...params);
          return {
            rows,
            rowsAffected: 0,
          };
        }

        const stmt = this.db.prepare(sql);
        const result = stmt.run(...params);
        return {
          rows: [],
          rowsAffected: Number(result.changes),
        };
      },
      catch: (cause: unknown) => {
        const msg =
          cause && typeof cause === "object" && "message" in cause
            ? String((cause as { message: unknown }).message)
            : String(cause);
        return new StorageError({
          message: `Native SQLite query execution failed: ${msg}`,
        });
      },
    });
  }

  readonly transaction = Effect.fn("NativeSqliteDriver.transaction")(function* <
    A,
    E,
    R,
  >(
    this: NativeSqliteDriver,
    fn: (tx: SqlDriver) => Effect.Effect<A, E, R>
  ): Effect.fn.Return<A, E | StorageError, R> {
    yield* this.execute("BEGIN IMMEDIATE;");
    return yield* fn(this).pipe(
      Effect.tap(() => this.execute("COMMIT;")),
      Effect.tapError(() => this.execute("ROLLBACK;"))
    );
  });

  close(): void {
    this.db.close();
  }
}
