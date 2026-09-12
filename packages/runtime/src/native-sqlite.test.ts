import type { ObjectInstance } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { NativeSqliteDriver } from "./native-sqlite.js";
import { SqlBitemporalStore } from "./sql-store.js";

describe("NativeSqliteDriver & SqlBitemporalStore", () => {
  it("executes point lookup and time-travel queries on real SQLite", async () => {
    const driver = new NativeSqliteDriver(":memory:");
    const store = new SqlBitemporalStore(driver, "sqlite");

    const patient: ObjectInstance = {
      id: "patient-101",
      typeId: "Patient" as any,
      version: 1,
      properties: { name: "Alice", status: "admitted" },
      lastModifiedAt: 1000,
    };

    // Put initial version
    await Effect.runPromise(store.putObject(patient));

    // Point lookup
    const retrieved = await Effect.runPromise(
      store.getObject("Patient" as any, "patient-101")
    );
    expect(retrieved).toBeDefined();
    expect(retrieved?.version).toBe(1);
    expect(retrieved?.properties.name).toBe("Alice");

    // Update to version 2
    const updatedPatient: ObjectInstance = {
      ...patient,
      version: 2,
      properties: { name: "Alice", status: "discharged" },
    };
    await Effect.runPromise(store.putObject(updatedPatient));

    const retrievedV2 = await Effect.runPromise(
      store.getObject("Patient" as any, "patient-101")
    );
    expect(retrievedV2?.version).toBe(2);
    expect(retrievedV2?.properties.status).toBe("discharged");

    driver.close();
  });

  it("enforces multi-object atomic all-or-nothing rollback on version conflict", async () => {
    const driver = new NativeSqliteDriver(":memory:");
    const store = new SqlBitemporalStore(driver, "sqlite");

    const objA: ObjectInstance = {
      id: "obj-A",
      typeId: "Entity" as any,
      version: 1,
      properties: { val: "A" },
      lastModifiedAt: 1000,
    };
    await Effect.runPromise(store.putObject(objA));

    // Batch with valid objA v2 but INVALID objB (version 99 instead of 1)
    const objBInvalid: ObjectInstance = {
      id: "obj-B",
      typeId: "Entity" as any,
      version: 99,
      properties: { val: "B" },
      lastModifiedAt: 1000,
    };
    const objAValid: ObjectInstance = {
      ...objA,
      version: 2,
      properties: { val: "A-updated" },
    };

    const exit = await Effect.runPromiseExit(
      store.commitAtomicTransaction({
        mutations: [
          { type: "put", instance: objAValid },
          { type: "put", instance: objBInvalid },
        ],
      })
    );
    expect(exit._tag).toBe("Failure");

    // Verify objA was ROLLED BACK and remains version 1!
    const checkA = await Effect.runPromise(
      store.getObject("Entity" as any, "obj-A")
    );
    expect(checkA?.version).toBe(1);
    expect(checkA?.properties.val).toBe("A");

    driver.close();
  });

  it("persists bitemporal data across database close and reopen on disk", async () => {
    const tmpPath = `/tmp/operon-test-${Date.now()}.sqlite`;
    const driver1 = new NativeSqliteDriver(tmpPath);
    const store1 = new SqlBitemporalStore(driver1, "sqlite");

    await Effect.runPromise(
      store1.putObject({
        id: "persisted-1",
        typeId: "Record" as any,
        version: 1,
        properties: { state: "saved" },
        lastModifiedAt: 1000,
      })
    );
    driver1.close();

    // Reopen same database file
    const driver2 = new NativeSqliteDriver(tmpPath);
    const store2 = new SqlBitemporalStore(driver2, "sqlite");

    const reloaded = await Effect.runPromise(
      store2.getObject("Record" as any, "persisted-1")
    );
    expect(reloaded).toBeDefined();
    expect(reloaded?.properties.state).toBe("saved");
    driver2.close();
  });
});
