import type { ObjectInstance, ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { BitemporalObjectStore } from "./bitemporal-store.js";
import { ConcurrentModificationError } from "./errors.js";

describe("BitemporalObjectStore Time-Travel & Invariants (bitemporal-store.ts)", () => {
  const typeId = "Vessel" as ObjectTypeId;

  it("retrieves latest object version or undefined when absent", async () => {
    const store = new BitemporalObjectStore();

    const empty = await Effect.runPromise(store.getObject(typeId, "missing"));
    expect(empty).toBeUndefined();

    const v1: ObjectInstance = {
      id: "v-1",
      lastModifiedAt: 1000,
      properties: { pressure: 50 },
      typeId,
      version: 1,
    };
    await Effect.runPromise(store.putObject(v1, 1000));

    const latest = await Effect.runPromise(store.getObject(typeId, "v-1"));
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(1);
    expect((latest!.properties as any).pressure).toBe(50);
  });

  it("enforces exact valid-time interval boundaries [from, to) with inclusive start and exclusive end", async () => {
    const store = new BitemporalObjectStore();

    // Version 1: valid from 1000 to 2000
    const v1: ObjectInstance = {
      id: "v-2",
      lastModifiedAt: 1000,
      properties: { status: "IDLE" },
      typeId,
      version: 1,
    };
    await Effect.runPromise(store.putObject(v1, 1000));

    // Version 2: valid from 2000 to 3000
    const v2: ObjectInstance = {
      id: "v-2",
      lastModifiedAt: 2000,
      properties: { status: "ACTIVE" },
      typeId,
      version: 2,
    };
    await Effect.runPromise(store.putObject(v2, 2000));

    // 1. Before validFrom (999): undefined
    const at999 = await Effect.runPromise(
      store.asOfValidTime(typeId, "v-2", 999)
    );
    expect(at999).toBeUndefined();

    // 2. Exact start boundary (1000): matches v1
    const at1000 = await Effect.runPromise(
      store.asOfValidTime(typeId, "v-2", 1000)
    );
    expect(at1000).toBeDefined();
    expect((at1000!.properties as any).status).toBe("IDLE");

    // 3. Middle of v1 (1500): matches v1
    const at1500 = await Effect.runPromise(
      store.asOfValidTime(typeId, "v-2", 1500)
    );
    expect(at1500).toBeDefined();
    expect((at1500!.properties as any).status).toBe("IDLE");

    // 4. Exact transition point (2000): v1 is exclusive [1000, 2000), v2 starts at 2000 -> matches v2!
    const at2000 = await Effect.runPromise(
      store.asOfValidTime(typeId, "v-2", 2000)
    );
    expect(at2000).toBeDefined();
    expect((at2000!.properties as any).status).toBe("ACTIVE");

    // 5. Querying non-existent type returns undefined
    const missing = await Effect.runPromise(
      store.asOfValidTime("Unknown" as ObjectTypeId, "v-2", 1500)
    );
    expect(missing).toBeUndefined();
  });

  it("enforces transaction-time time-travel queries across superseding events", async () => {
    const store = new BitemporalObjectStore();

    const v1: ObjectInstance = {
      id: "v-3",
      lastModifiedAt: 1000,
      properties: { temp: 20 },
      typeId,
      version: 1,
    };
    await Effect.runPromise(store.putObject(v1, 1000));

    const v2: ObjectInstance = {
      id: "v-3",
      lastModifiedAt: 2000,
      properties: { temp: 45 },
      typeId,
      version: 2,
    };
    await Effect.runPromise(store.putObject(v2, 2000));

    // Query non-existent object in transaction time
    const absent = await Effect.runPromise(
      store.asOfTransactionTime(typeId, "absent", Date.now())
    );
    expect(absent).toBeUndefined();

    // Query current transaction time returns latest version
    const nowAsOf = await Effect.runPromise(
      store.asOfTransactionTime(typeId, "v-3", Date.now())
    );
    expect(nowAsOf).toBeDefined();
    expect((nowAsOf!.properties as any).temp).toBe(45);
  });

  it("enforces Optimistic Concurrency Control (OCC) version increments", async () => {
    const store = new BitemporalObjectStore();

    const v1: ObjectInstance = {
      id: "v-4",
      lastModifiedAt: 1000,
      properties: { val: 1 },
      typeId,
      version: 1,
    };
    await Effect.runPromise(store.putObject(v1));

    // Stale version mutation attempt (version 5 when current is 1)
    const invalidVersion: ObjectInstance = {
      id: "v-4",
      lastModifiedAt: 2000,
      properties: { val: 2 },
      typeId,
      version: 5,
    };

    const err = await Effect.runPromise(
      Effect.flip(store.putObject(invalidVersion))
    );

    expect(err).toBeInstanceOf(ConcurrentModificationError);
    expect((err as ConcurrentModificationError).expectedVersion).toBe(2);
    expect((err as ConcurrentModificationError).actualVersion).toBe(5);
  });
});
