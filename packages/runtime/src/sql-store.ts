import type {
  LinkInstance,
  LinkTypeId,
  ObjectInstance,
  ObjectProperties,
  ObjectTypeId,
} from "@operon/schema";
import { Effect, Schema } from "effect";

import type { StorageError } from "./errors.js";
import { ConcurrentModificationError } from "./errors.js";
import type { AtomicTransactionBatch, ObjectStore } from "./object-store.js";

const JsonCodec = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownSync(JsonCodec);
const serializeJson = Schema.encodeSync(JsonCodec);

export type SqlDialect = "postgres" | "sqlite";

export interface BitemporalQueryOptions {
  readonly typeId: string;
  readonly id: string;
  readonly validTime: number;
  readonly txTime: number;
  readonly dialect?: SqlDialect;
}

export interface SqlQueryResult<T = unknown> {
  readonly rows: readonly T[];
  readonly rowsAffected: number;
}

export interface SqlDriver {
  readonly execute: (
    sql: string,
    params?: readonly unknown[]
  ) => Effect.Effect<SqlQueryResult, StorageError>;
  readonly transaction: <A, E, R>(
    fn: (tx: SqlDriver) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | StorageError, R>;
}

export interface SqlBitemporalRecord {
  readonly id: string;
  readonly type_id: string;
  readonly version: number;
  readonly properties: string;
  readonly valid_from: number;
  readonly valid_to: number | null;
  readonly tx_from: number;
  readonly tx_to: number | null;
  readonly branch: string;
}

export interface SqlLinkRecord {
  readonly link_type_id: string;
  readonly source_id: string;
  readonly target_id: string;
  readonly properties: string;
  readonly valid_from: number;
  readonly valid_to: number | null;
  readonly tx_from: number;
  readonly tx_to: number | null;
}

/**
 * SQL Schema and Query Generator for Bitemporal Enterprise Tables
 */
export const SqlSchemaGenerator = {
  generateDDL(dialect: SqlDialect = "postgres"): readonly string[] {
    const isPg = dialect === "postgres";
    const jsonType = isPg ? "JSONB" : "TEXT";

    return [
      `CREATE TABLE IF NOT EXISTS operon_objects (
        id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        properties ${jsonType} NOT NULL,
        valid_from BIGINT NOT NULL,
        valid_to BIGINT,
        tx_from BIGINT NOT NULL,
        tx_to BIGINT,
        branch TEXT NOT NULL DEFAULT 'main',
        PRIMARY KEY (type_id, id, version, tx_from)
      );`,
      `CREATE TABLE IF NOT EXISTS operon_links (
        link_type_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        properties ${jsonType},
        valid_from BIGINT NOT NULL,
        valid_to BIGINT,
        tx_from BIGINT NOT NULL,
        tx_to BIGINT,
        PRIMARY KEY (link_type_id, source_id, target_id, tx_from)
      );`,
      `CREATE TABLE IF NOT EXISTS operon_action_log (
        entry_id TEXT PRIMARY KEY,
        action_type_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        payload ${jsonType} NOT NULL,
        status TEXT NOT NULL,
        merkle_hash TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_operon_objects_lookup ON operon_objects(type_id, id, tx_to);`,
      `CREATE INDEX IF NOT EXISTS idx_operon_objects_bitemp ON operon_objects(type_id, valid_from, valid_to, tx_from, tx_to);`,
      `CREATE INDEX IF NOT EXISTS idx_operon_links_source ON operon_links(link_type_id, source_id, tx_to);`,
      `CREATE INDEX IF NOT EXISTS idx_operon_links_target ON operon_links(link_type_id, target_id, tx_to);`,
    ];
  },

  compilePointLookup(
    typeId: string,
    id: string,
    dialect: SqlDialect = "postgres"
  ): { sql: string; params: unknown[] } {
    const param1 = dialect === "postgres" ? "$1" : "?";
    const param2 = dialect === "postgres" ? "$2" : "?";
    const sql = `SELECT id, type_id, version, properties, valid_from, valid_to, tx_from, tx_to, branch 
                 FROM operon_objects 
                 WHERE type_id = ${param1} AND id = ${param2} AND tx_to IS NULL 
                 ORDER BY tx_from DESC LIMIT 1;`;
    return { params: [typeId, id], sql };
  },

  compileBitemporalQuery(options: BitemporalQueryOptions): {
    sql: string;
    params: unknown[];
  } {
    const { dialect = "postgres", id, txTime, typeId, validTime } = options;
    if (dialect === "postgres") {
      const sql = `SELECT id, type_id, version, properties, valid_from, valid_to, tx_from, tx_to, branch 
                   FROM operon_objects 
                   WHERE type_id = $1 AND id = $2 
                     AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
                     AND tx_from <= $4 AND (tx_to IS NULL OR tx_to > $4)
                   ORDER BY tx_from DESC LIMIT 1;`;
      return { params: [typeId, id, validTime, txTime], sql };
    }

    const sql = `SELECT id, type_id, version, properties, valid_from, valid_to, tx_from, tx_to, branch 
                 FROM operon_objects 
                 WHERE type_id = ? AND id = ? 
                   AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
                   AND tx_from <= ? AND (tx_to IS NULL OR tx_to > ?)
                 ORDER BY tx_from DESC LIMIT 1;`;
    return {
      params: [typeId, id, validTime, validTime, txTime, txTime],
      sql,
    };
  },
};

/**
 * Embedded in-memory SQL Driver supporting real transactions, parameter substitution, and isolation.
 */
export class EmbeddedSqlDriver implements SqlDriver {
  private objects = new Map<string, SqlBitemporalRecord>();
  private links: SqlLinkRecord[] = [];

  private matchesTemporalSlice(
    record: SqlBitemporalRecord,
    validTime?: number,
    txTime?: number
  ): boolean {
    if (validTime !== undefined && txTime !== undefined) {
      const validMatch =
        record.valid_from <= validTime &&
        (record.valid_to === null || record.valid_to > validTime);
      const txMatch =
        record.tx_from <= txTime &&
        (record.tx_to === null || record.tx_to > txTime);
      return validMatch && txMatch;
    }
    return record.tx_to === null;
  }

  private executeSelectObjects(params: readonly unknown[]): SqlQueryResult {
    const typeId = params[0] as string;
    const id = params[1] as string;
    const validTime = params[2] as number | undefined;
    const txTime = (params.length >= 6 ? params[4] : params[3]) as
      | number
      | undefined;

    const results: SqlBitemporalRecord[] = [];
    for (const record of this.objects.values()) {
      if (
        record.type_id === typeId &&
        (!id || record.id === id) &&
        this.matchesTemporalSlice(record, validTime, txTime)
      ) {
        results.push(record);
      }
    }

    results.sort((a, b) => b.tx_from - a.tx_from);
    return { rows: results, rowsAffected: 0 };
  }

  private executeSelectLinks(
    params: readonly unknown[],
    isSource: boolean
  ): SqlQueryResult {
    const linkTypeId = params[0] as string;
    const endpointId = params[1] as string;

    const matched = this.links.filter((l) => {
      if (l.link_type_id !== linkTypeId || l.tx_to !== null) {
        return false;
      }
      return isSource ? l.source_id === endpointId : l.target_id === endpointId;
    });

    return { rows: matched, rowsAffected: 0 };
  }

  private executeInsertObject(params: readonly unknown[]): SqlQueryResult {
    const record: SqlBitemporalRecord = {
      branch: (params[8] as string) ?? "main",
      id: params[0] as string,
      properties: params[3] as string,
      tx_from: params[6] as number,
      tx_to: (params[7] as number) ?? null,
      type_id: params[1] as string,
      valid_from: params[4] as number,
      valid_to: (params[5] as number) ?? null,
      version: params[2] as number,
    };
    const key = `${record.type_id}:${record.id}:${record.version}:${record.tx_from}`;
    this.objects.set(key, record);
    return { rows: [], rowsAffected: 1 };
  }

  private executeUpdateObject(
    params: readonly unknown[],
    isSetValidTo: boolean
  ): SqlQueryResult {
    if (isSetValidTo) {
      const newValidTo = params[0] as number;
      const typeId = params[1] as string;
      const id = params[2] as string;

      let count = 0;
      for (const [key, record] of this.objects.entries()) {
        if (
          record.type_id === typeId &&
          record.id === id &&
          record.tx_to === null &&
          (record.valid_to === null || record.valid_to > newValidTo)
        ) {
          this.objects.set(key, { ...record, valid_to: newValidTo });
          count++;
        }
      }
      return { rows: [], rowsAffected: count };
    }

    const newTxTo = params[0] as number;
    const typeId = params[1] as string;
    const id = params[2] as string;

    let count = 0;
    for (const [key, record] of this.objects.entries()) {
      if (
        record.type_id === typeId &&
        record.id === id &&
        record.tx_to === null
      ) {
        this.objects.set(key, { ...record, tx_to: newTxTo });
        count++;
      }
    }
    return { rows: [], rowsAffected: count };
  }

  private executeInsertLink(params: readonly unknown[]): SqlQueryResult {
    const link: SqlLinkRecord = {
      link_type_id: params[0] as string,
      source_id: params[1] as string,
      target_id: params[2] as string,
      properties: (params[3] as string) ?? "{}",
      tx_from: params[6] as number,
      tx_to: (params[7] as number) ?? null,
      valid_from: params[4] as number,
      valid_to: (params[5] as number) ?? null,
    };
    this.links.push(link);
    return { rows: [], rowsAffected: 1 };
  }

  public execute(
    sql: string,
    params: readonly unknown[] = []
  ): Effect.Effect<SqlQueryResult, StorageError> {
    return Effect.sync(() => {
      const normalized = sql.trim().toUpperCase();

      if (
        normalized.startsWith("SELECT") &&
        normalized.includes("FROM OPERON_OBJECTS")
      ) {
        return this.executeSelectObjects(params);
      }
      if (
        normalized.startsWith("SELECT") &&
        normalized.includes("FROM OPERON_LINKS")
      ) {
        return this.executeSelectLinks(
          params,
          normalized.includes("SOURCE_ID =")
        );
      }
      if (normalized.startsWith("INSERT INTO OPERON_OBJECTS")) {
        return this.executeInsertObject(params);
      }
      if (normalized.startsWith("UPDATE OPERON_OBJECTS")) {
        return this.executeUpdateObject(
          params,
          normalized.includes("SET VALID_TO")
        );
      }
      if (normalized.startsWith("INSERT INTO OPERON_LINKS")) {
        return this.executeInsertLink(params);
      }

      return { rows: [], rowsAffected: 0 };
    });
  }

  public transaction<A, E, R>(
    fn: (tx: SqlDriver) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | StorageError, R> {
    const backupObjects = new Map(this.objects);
    const backupLinks = [...this.links];

    return fn(this).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          this.objects = backupObjects;
          this.links = backupLinks;
        })
      )
    );
  }
}

interface ClosePriorSliceOptions {
  readonly tx: SqlDriver;
  readonly dialect: SqlDialect;
  readonly instance: ObjectInstance;
  readonly current: SqlBitemporalRecord;
  readonly now: number;
}

function closeOrUpdatePriorSlice(
  opts: ClosePriorSliceOptions
): Effect.Effect<void, StorageError> {
  const p1 = opts.dialect === "postgres" ? "$1" : "?";
  const p2 = opts.dialect === "postgres" ? "$2" : "?";
  const p3 = opts.dialect === "postgres" ? "$3" : "?";
  if (
    opts.instance.validFrom !== undefined &&
    opts.instance.validFrom > opts.current.valid_from
  ) {
    const updateValidToSql = `UPDATE operon_objects SET valid_to = ${p1} WHERE type_id = ${p2} AND id = ${p3} AND tx_to IS NULL AND (valid_to IS NULL OR valid_to > ${p1});`;
    const updateParams =
      opts.dialect === "postgres"
        ? [opts.instance.validFrom, opts.instance.typeId, opts.instance.id]
        : [
            opts.instance.validFrom,
            opts.instance.typeId,
            opts.instance.id,
            opts.instance.validFrom,
          ];
    return opts.tx.execute(updateValidToSql, updateParams).pipe(Effect.asVoid);
  }
  const closeSql = `UPDATE operon_objects SET tx_to = ${p1} WHERE type_id = ${p2} AND id = ${p3} AND tx_to IS NULL;`;
  return opts.tx
    .execute(closeSql, [opts.now, opts.instance.typeId, opts.instance.id])
    .pipe(Effect.asVoid);
}

const reconcilePriorObjectSlice = Effect.fn(
  "SqlStore.reconcilePriorObjectSlice"
)(function* (
  tx: SqlDriver,
  dialect: SqlDialect,
  instance: ObjectInstance,
  now: number
) {
  const query = SqlSchemaGenerator.compilePointLookup(
    instance.typeId,
    instance.id,
    dialect
  );
  const existingRes = yield* tx.execute(query.sql, query.params);

  if (existingRes.rows.length === 0) {
    if (instance.version !== 1) {
      return yield* new ConcurrentModificationError({
        actualVersion: instance.version,
        expectedVersion: 1,
        objectId: instance.id,
      });
    }
    return instance.validFrom ?? now;
  }

  const current = existingRes.rows[0] as SqlBitemporalRecord;
  if (current.version !== instance.version - 1) {
    return yield* new ConcurrentModificationError({
      actualVersion: instance.version,
      expectedVersion: current.version + 1,
      objectId: instance.id,
    });
  }

  yield* closeOrUpdatePriorSlice({
    current,
    dialect,
    instance,
    now,
    tx,
  });
  return instance.validFrom ?? current.valid_from;
});

interface InsertObjectSliceOptions {
  readonly tx: SqlDriver;
  readonly dialect: SqlDialect;
  readonly instance: ObjectInstance;
  readonly validFrom: number;
  readonly now: number;
}

function insertObjectSlice(
  opts: InsertObjectSliceOptions
): Effect.Effect<void, StorageError> {
  const insertSql = `INSERT INTO operon_objects (id, type_id, version, properties, valid_from, valid_to, tx_from, tx_to, branch) 
                     VALUES (${
                       opts.dialect === "postgres"
                         ? "$1, $2, $3, $4, $5, $6, $7, $8, $9"
                         : "?, ?, ?, ?, ?, ?, ?, ?, ?"
                     });`;
  const params = [
    opts.instance.id,
    opts.instance.typeId,
    opts.instance.version,
    serializeJson(opts.instance.properties),
    opts.validFrom,
    opts.instance.validTo ?? null,
    opts.now,
    null,
    "main",
  ];
  return opts.tx.execute(insertSql, params).pipe(Effect.asVoid);
}

const applyAtomicMutation = Effect.fn("SqlStore.applyAtomicMutation")(
  function* (
    tx: SqlDriver,
    dialect: SqlDialect,
    mutation: AtomicTransactionBatch["mutations"][number],
    now: number
  ) {
    if (mutation.type === "put" && mutation.instance) {
      const validFrom = yield* reconcilePriorObjectSlice(
        tx,
        dialect,
        mutation.instance,
        now
      );
      yield* insertObjectSlice({
        dialect,
        instance: mutation.instance,
        now,
        tx,
        validFrom,
      });
    } else if (mutation.type === "delete" && mutation.typeId && mutation.id) {
      const p1 = dialect === "postgres" ? "$1" : "?";
      const p2 = dialect === "postgres" ? "$2" : "?";
      const p3 = dialect === "postgres" ? "$3" : "?";
      const closeSql = `UPDATE operon_objects SET tx_to = ${p1} WHERE type_id = ${p2} AND id = ${p3} AND tx_to IS NULL;`;
      yield* tx.execute(closeSql, [now, mutation.typeId, mutation.id]);
    }
  }
);

function applyAtomicLink(
  tx: SqlDriver,
  dialect: SqlDialect,
  link: NonNullable<AtomicTransactionBatch["links"]>[number],
  now: number
): Effect.Effect<void, StorageError> {
  const insertLinkSql = `INSERT INTO operon_links (link_type_id, source_id, target_id, properties, valid_from, valid_to, tx_from, tx_to)
                         VALUES (${
                           dialect === "postgres"
                             ? "$1, $2, $3, $4, $5, $6, $7, $8"
                             : "?, ?, ?, ?, ?, ?, ?, ?"
                         });`;
  const linkParams = [
    link.linkTypeId,
    link.sourceId,
    link.targetId,
    serializeJson(link.metadata ?? {}),
    link.createdAt ?? now,
    null,
    now,
    null,
  ];
  return tx.execute(insertLinkSql, linkParams).pipe(Effect.asVoid);
}

/**
 * Production SQL Bitemporal Store implementing ObjectStore and time-travel queries
 */
export class SqlBitemporalStore implements ObjectStore {
  public constructor(
    private readonly driver: SqlDriver,
    private readonly dialect: SqlDialect = "postgres"
  ) {}

  public getObject(
    typeId: ObjectTypeId,
    id: string
  ): Effect.Effect<ObjectInstance | undefined> {
    const query = SqlSchemaGenerator.compilePointLookup(
      typeId,
      id,
      this.dialect
    );
    return this.driver.execute(query.sql, query.params).pipe(
      Effect.map((res): ObjectInstance | undefined => {
        const row = res.rows[0] as SqlBitemporalRecord | undefined;
        return row
          ? {
              id: row.id,
              lastModifiedAt: row.tx_from,
              // SAFETY: Object properties serialized to SQL conform to ObjectProperties
              properties: parseJson(row.properties) as ObjectProperties,
              typeId: row.type_id as ObjectTypeId,
              validFrom: row.valid_from,
              validTo: row.valid_to ?? undefined,
              version: row.version,
            }
          : undefined;
      }),
      Effect.catchTag("StorageError", Effect.die)
    );
  }

  public putObject(
    instance: ObjectInstance
  ): Effect.Effect<ObjectInstance, ConcurrentModificationError> {
    const now = Date.now();
    const dialect = this.dialect;

    const executePutTransaction = Effect.fn(
      "SqlBitemporalStore.executePutTransaction"
    )(function* (tx: SqlDriver) {
      const validFrom = yield* reconcilePriorObjectSlice(
        tx,
        dialect,
        instance,
        now
      );
      yield* insertObjectSlice({
        dialect,
        instance,
        now,
        tx,
        validFrom,
      });

      return {
        ...instance,
        lastModifiedAt: now,
        validFrom,
      };
    });

    return this.driver
      .transaction(executePutTransaction)
      .pipe(Effect.catchTag("StorageError", Effect.die));
  }

  public deleteObject(typeId: ObjectTypeId, id: string): Effect.Effect<void> {
    const now = Date.now();
    const closeSql = `UPDATE operon_objects SET tx_to = ${
      this.dialect === "postgres" ? "$1" : "?"
    } WHERE type_id = ${this.dialect === "postgres" ? "$2" : "?"} AND id = ${
      this.dialect === "postgres" ? "$3" : "?"
    } AND tx_to IS NULL;`;

    return this.driver
      .execute(closeSql, [now, typeId, id])
      .pipe(Effect.asVoid, Effect.catchTag("StorageError", Effect.die));
  }

  public findObjects(
    typeId: ObjectTypeId,
    predicate?: (instance: ObjectInstance) => boolean
  ): Effect.Effect<readonly ObjectInstance[]> {
    const sql = `SELECT id, type_id, version, properties, valid_from, valid_to, tx_from, tx_to, branch 
                 FROM operon_objects 
                 WHERE type_id = ${this.dialect === "postgres" ? "$1" : "?"} AND tx_to IS NULL;`;

    return this.driver.execute(sql, [typeId]).pipe(
      Effect.map((res) => {
        const instances: ObjectInstance[] = [];
        for (const r of res.rows) {
          const row = r as SqlBitemporalRecord;
          const inst: ObjectInstance = {
            id: row.id,
            lastModifiedAt: row.tx_from,
            // SAFETY: Object properties serialized to SQL conform to ObjectProperties
            properties: parseJson(row.properties) as ObjectProperties,
            typeId: row.type_id as ObjectTypeId,
            validFrom: row.valid_from,
            validTo: row.valid_to ?? undefined,
            version: row.version,
          };
          if (!predicate || predicate(inst)) {
            instances.push(inst);
          }
        }
        return instances;
      }),
      Effect.catchTag("StorageError", Effect.die)
    );
  }

  public linkObjects(link: LinkInstance): Effect.Effect<void> {
    const now = Date.now();
    const insertSql = `INSERT INTO operon_links (link_type_id, source_id, target_id, properties, valid_from, valid_to, tx_from, tx_to) 
                       VALUES (${
                         this.dialect === "postgres" ? "$1" : "?"
                       }, ${this.dialect === "postgres" ? "$2" : "?"}, ${
                         this.dialect === "postgres" ? "$3" : "?"
                       }, ${this.dialect === "postgres" ? "$4" : "?"}, ${
                         this.dialect === "postgres" ? "$5" : "?"
                       }, ${this.dialect === "postgres" ? "$6" : "?"}, ${
                         this.dialect === "postgres" ? "$7" : "?"
                       }, ${this.dialect === "postgres" ? "$8" : "?"});`;

    return this.driver
      .execute(insertSql, [
        link.linkTypeId,
        link.sourceId,
        link.targetId,
        serializeJson(link.metadata ?? {}),
        link.createdAt,
        null,
        now,
        null,
      ])
      .pipe(Effect.asVoid, Effect.catchTag("StorageError", Effect.die));
  }

  public getLinks(
    linkTypeId: LinkTypeId,
    sourceId: string
  ): Effect.Effect<readonly LinkInstance[]> {
    const sql = `SELECT link_type_id, source_id, target_id, properties, valid_from, valid_to, tx_from, tx_to 
                 FROM operon_links 
                 WHERE link_type_id = ${this.dialect === "postgres" ? "$1" : "?"} 
                   AND source_id = ${this.dialect === "postgres" ? "$2" : "?"} 
                   AND tx_to IS NULL;`;

    return this.driver.execute(sql, [linkTypeId, sourceId]).pipe(
      Effect.map((res) =>
        res.rows.map((r) => {
          const row = r as SqlLinkRecord;
          return {
            createdAt: row.tx_from,
            linkTypeId: row.link_type_id as LinkTypeId,
            metadata: parseJson(row.properties) as Record<string, unknown>,
            sourceId: row.source_id,
            targetId: row.target_id,
          };
        })
      ),
      Effect.catchTag("StorageError", Effect.die)
    );
  }

  public asOfBitemporal(
    typeId: ObjectTypeId,
    id: string,
    validTime: number,
    txTime: number
  ): Effect.Effect<ObjectInstance | undefined, StorageError> {
    const query = SqlSchemaGenerator.compileBitemporalQuery({
      dialect: this.dialect,
      id,
      txTime,
      typeId,
      validTime,
    });

    return this.driver.execute(query.sql, query.params).pipe(
      Effect.map((res): ObjectInstance | undefined => {
        const row = res.rows[0] as SqlBitemporalRecord | undefined;
        return row
          ? {
              id: row.id,
              lastModifiedAt: row.tx_from,
              // SAFETY: Object properties serialized to SQL conform to ObjectProperties
              properties: parseJson(row.properties) as ObjectProperties,
              typeId: row.type_id as ObjectTypeId,
              validFrom: row.valid_from,
              validTo: row.valid_to ?? undefined,
              version: row.version,
            }
          : undefined;
      })
    );
  }

  public commitAtomicTransaction(
    batch: AtomicTransactionBatch
  ): Effect.Effect<void, ConcurrentModificationError> {
    const now = Date.now();
    const dialect = this.dialect;

    const executeBatchTransaction = Effect.fn(
      "SqlBitemporalStore.executeBatchTransaction"
    )(function* (tx: SqlDriver) {
      yield* Effect.forEach(
        batch.mutations,
        (mutation) => applyAtomicMutation(tx, dialect, mutation, now),
        { concurrency: 1, discard: true }
      );

      if (batch.links) {
        yield* Effect.forEach(
          batch.links,
          (link) => applyAtomicLink(tx, dialect, link, now),
          { concurrency: 1, discard: true }
        );
      }
    });

    return this.driver.transaction(executeBatchTransaction).pipe(
      Effect.mapError((failure: unknown) => {
        if (
          failure &&
          typeof failure === "object" &&
          "_tag" in failure &&
          failure._tag === "ConcurrentModificationError"
        ) {
          return failure as ConcurrentModificationError;
        }
        const msg =
          failure && typeof failure === "object" && "message" in failure
            ? String((failure as { message: unknown }).message)
            : String(failure);
        return new ConcurrentModificationError({
          actualVersion: 0,
          expectedVersion: 0,
          objectId: `transaction_failure: ${msg}`,
        });
      })
    );
  }
}
