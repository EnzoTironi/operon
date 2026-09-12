import type { ObjectInstance, ObjectTypeId } from "@operon/schema";
import { Effect, Exit, Redacted, Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresDriver, isPostgresUrl } from "./postgres.js";
import { SqlBitemporalStore } from "./sql-store.js";
import { describeObjectStoreContract } from "./testing/object-store-contract.js";
import { createPostgresTestDatabase } from "./testing/postgres-test-database.js";
import type { PostgresTestDatabase } from "./testing/postgres-test-database.js";

const database = await createPostgresTestDatabase();

interface OpenDriver {
  readonly driver: PostgresDriver;
  readonly close: () => Promise<void>;
}

async function openDriver(target: PostgresTestDatabase): Promise<OpenDriver> {
  const scope = await Effect.runPromise(Scope.make());
  const driver = await Effect.runPromise(
    PostgresDriver.connect({ url: target.url }).pipe(Scope.provide(scope))
  );
  return {
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    driver,
  };
}

describe("isPostgresUrl", () => {
  it("accepts both URL schemes and rejects file paths", () => {
    expect(isPostgresUrl("postgres://u:p@h:1/db")).toBe(true);
    expect(isPostgresUrl("postgresql://u:p@h:1/db")).toBe(true);
    expect(isPostgresUrl("/tmp/cell.sqlite")).toBe(false);
    expect(isPostgresUrl(":memory:")).toBe(false);
  });
});

describe.skipIf(database === undefined)("PostgresDriver", () => {
  if (database === undefined) {
    return;
  }
  const target = database;

  describeObjectStoreContract("SqlBitemporalStore on PostgreSQL", async () => {
    const opened = await openDriver(target);
    return {
      close: opened.close,
      store: new SqlBitemporalStore(opened.driver, "postgres"),
    };
  });

  const Record = "Record" as ObjectTypeId;

  it("keeps data across reconnects and applies the schema idempotently", async () => {
    const first = await openDriver(target);
    await Effect.runPromise(
      new SqlBitemporalStore(first.driver, "postgres").putObject({
        id: "persisted-pg",
        lastModifiedAt: 1000,
        properties: { state: "saved" },
        typeId: Record,
        version: 1,
      })
    );
    await first.close();

    const second = await openDriver(target);
    const reloaded = await Effect.runPromise(
      new SqlBitemporalStore(second.driver, "postgres").getObject(
        Record,
        "persisted-pg"
      )
    );
    await second.close();

    expect(reloaded?.properties.state).toBe("saved");
    expect(reloaded?.version).toBe(1);
    expect(typeof reloaded?.validFrom).toBe("number");
  });

  it("decodes BIGINT epochs as numbers and JSONB as the serialized payload", async () => {
    const opened = await openDriver(target);
    const result = await Effect.runPromise(
      opened.driver.execute(
        "SELECT CAST($1 AS BIGINT) AS millis, CAST($2 AS JSONB) AS payload",
        [1_700_000_000_000, '{"a":1}']
      )
    );
    await opened.close();
    expect(result.rows[0]).toEqual({
      millis: 1_700_000_000_000,
      payload: '{"a": 1}',
    });
  });

  it("answers bitemporal as-of queries for earlier transaction times", async () => {
    const opened = await openDriver(target);
    const store = new SqlBitemporalStore(opened.driver, "postgres");
    const base: ObjectInstance = {
      id: "asof",
      lastModifiedAt: 0,
      properties: { status: "admitted" },
      typeId: Record,
      version: 1,
    };
    const v1 = await Effect.runPromise(store.putObject(base));
    await Effect.runPromise(Effect.sleep("5 millis"));
    const v2 = await Effect.runPromise(
      store.putObject({
        ...base,
        properties: { status: "discharged" },
        version: 2,
      })
    );

    const beforeV2 = await Effect.runPromise(
      store.asOfBitemporal(
        Record,
        "asof",
        v1.lastModifiedAt,
        v2.lastModifiedAt - 1
      )
    );
    const now = await Effect.runPromise(
      store.asOfBitemporal(Record, "asof", v2.lastModifiedAt, v2.lastModifiedAt)
    );
    await opened.close();

    expect(beforeV2?.properties.status).toBe("admitted");
    expect(now?.properties.status).toBe("discharged");
  });

  it("lets exactly one of two concurrent conflicting puts win", async () => {
    const opened = await openDriver(target);
    const store = new SqlBitemporalStore(opened.driver, "postgres");
    await Effect.runPromise(
      store.putObject({
        id: "race",
        lastModifiedAt: 0,
        properties: { n: 1 },
        typeId: Record,
        version: 1,
      })
    );
    const attempt = (n: number) =>
      Effect.exit(
        store.putObject({
          id: "race",
          lastModifiedAt: 0,
          properties: { n },
          typeId: Record,
          version: 2,
        })
      );
    const exits = await Effect.runPromise(
      Effect.all([attempt(2), attempt(3)], { concurrency: "unbounded" })
    );
    const current = await Effect.runPromise(store.getObject(Record, "race"));
    await opened.close();

    expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
    expect(exits.filter(Exit.isFailure)).toHaveLength(1);
    expect(current?.version).toBe(2);
  });

  it("surfaces connection failures as StorageError", async () => {
    const badUrl = new URL(Redacted.value(target.url));
    badUrl.password = "wrong-password";
    const failure = await Effect.runPromiseExit(
      Effect.scoped(
        PostgresDriver.connect({
          url: Redacted.make(badUrl.toString()),
        })
      )
    );
    expect(Exit.isFailure(failure)).toBe(true);
    if (Exit.isFailure(failure)) {
      const reason = failure.cause.reasons[0];
      expect(reason?._tag).toBe("Fail");
      if (reason?._tag === "Fail") {
        expect(reason.error._tag).toBe("StorageError");
      }
    }
  });

  afterAll(async () => {
    await target.drop();
  });
});
