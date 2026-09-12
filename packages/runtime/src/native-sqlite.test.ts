import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { NativeSqliteDriver } from "./native-sqlite.js";
import { SqlBitemporalStore } from "./sql-store.js";
import { describeObjectStoreContract } from "./testing/object-store-contract.js";

describeObjectStoreContract("SqlBitemporalStore on node:sqlite", () => {
  const driver = new NativeSqliteDriver(":memory:");
  return Promise.resolve({
    close: () => {
      driver.close();
      return Promise.resolve();
    },
    store: new SqlBitemporalStore(driver, "sqlite"),
  });
});

describe("NativeSqliteDriver persistence", () => {
  it("keeps bitemporal data across database close and reopen on disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "operon-sqlite-"));
    const file = path.join(dir, "cell.sqlite");
    const Record = "Record" as ObjectTypeId;

    const driver1 = new NativeSqliteDriver(file);
    await Effect.runPromise(
      new SqlBitemporalStore(driver1, "sqlite").putObject({
        id: "persisted-1",
        lastModifiedAt: 1000,
        properties: { state: "saved" },
        typeId: Record,
        version: 1,
      })
    );
    driver1.close();

    const driver2 = new NativeSqliteDriver(file);
    const reloaded = await Effect.runPromise(
      new SqlBitemporalStore(driver2, "sqlite").getObject(Record, "persisted-1")
    );
    driver2.close();
    rmSync(dir, { force: true, recursive: true });

    expect(reloaded?.properties.state).toBe("saved");
  });
});
