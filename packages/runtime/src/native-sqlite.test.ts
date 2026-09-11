import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

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
    const tmpPath = path.join(
      process.cwd(),
      `.tmp-operon-test-${Date.now()}.sqlite`
    );
    const cleanup = () => {
      for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
        if (existsSync(f)) {
          unlinkSync(f);
        }
      }
    };
    cleanup();

    try {
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
    } finally {
      cleanup();
    }
  });

  it("recovers bitemporal consistency and rolls back uncommitted WAL mutations after simulated crash on disk", async () => {
    const dbPath = path.join(
      process.cwd(),
      `.tmp-sqlite-crash-${Date.now()}.sqlite`
    );
    const cleanup = () => {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      }
    };

    cleanup();

    try {
      // 1. First session: commit Version 1 and Version 2
      const driver1 = new NativeSqliteDriver(dbPath);
      const store1 = new SqlBitemporalStore(driver1, "sqlite");

      const initialObj: ObjectInstance = {
        id: "acc-crash-01",
        lastModifiedAt: 1000,
        properties: { balance: 500, status: "active" },
        typeId: "Account" as any,
        validFrom: 1000,
        version: 1,
      };
      await Effect.runPromise(store1.putObject(initialObj));

      const updatedObj: ObjectInstance = {
        ...initialObj,
        lastModifiedAt: 2000,
        properties: { balance: 750, status: "active" },
        validFrom: 2000,
        version: 2,
      };
      await Effect.runPromise(store1.putObject(updatedObj));

      // 2. Simulate in-flight transaction crash: begin transaction, stage uncommitted mutations,
      // then close abruptly without COMMIT.
      await Effect.runPromise(driver1.execute("BEGIN IMMEDIATE;"));
      await Effect.runPromise(
        driver1.execute(
          "INSERT INTO operon_objects (id, type_id, version, properties, valid_from, valid_to, tx_from, tx_to, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            "acc-crash-01",
            "Account",
            3,
            JSON.stringify({ balance: 9999, status: "corrupted" }),
            3000,
            null,
            3000,
            null,
            "main",
          ]
        )
      );

      // Abrupt close simulating process termination before commit
      driver1.close();

      // 3. Second session: reopen real on-disk database after crash
      const driver2 = new NativeSqliteDriver(dbPath);
      const store2 = new SqlBitemporalStore(driver2, "sqlite");

      // Invariant 1: Uncommitted transaction rolled back by SQLite recovery
      const recovered = await Effect.runPromise(
        store2.getObject("Account" as any, "acc-crash-01")
      );
      expect(recovered).toBeDefined();
      expect(recovered?.version).toBe(2);
      const recoveredProps = recovered
        ? (recovered.properties as { balance: number; status: string })
        : { balance: 0, status: "" };
      expect(recoveredProps.balance).toBe(750);
      expect(recoveredProps.status).toBe("active");

      // Invariant 2: Bitemporal slice continuity — exactly one active slice (valid_to is null)
      const rawActiveSlices = await Effect.runPromise(
        driver2.execute(
          "SELECT * FROM operon_objects WHERE id = ? AND type_id = ? AND valid_to IS NULL;",
          ["acc-crash-01", "Account"]
        )
      );
      expect(rawActiveSlices.rows.length).toBe(1);
      expect((rawActiveSlices.rows[0] as any).version).toBe(2);

      // Invariant 3: Time-travel queries remain intact for prior committed versions
      const timeTravelV1 = await Effect.runPromise(
        driver2.execute(
          "SELECT * FROM operon_objects WHERE id = ? AND type_id = ? AND valid_from <= 1500 AND (valid_to IS NULL OR valid_to > 1500);",
          ["acc-crash-01", "Account"]
        )
      );
      expect(timeTravelV1.rows.length).toBe(1);
      expect((timeTravelV1.rows[0] as any).version).toBe(1);
      expect(JSON.parse((timeTravelV1.rows[0] as any).properties).balance).toBe(
        500
      );

      driver2.close();
    } finally {
      cleanup();
    }
  });
});
