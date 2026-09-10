import type { ObjectInstance } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ConcurrentModificationError } from "./errors.js";
import { InMemoryObjectStore } from "./object-store.js";

const makeObj = (
  id: string,
  version: number,
  label = "test"
): ObjectInstance => ({
  id,
  lastModifiedAt: 1000,
  properties: { label },
  typeId: "Entity" as any,
  version,
});

describe("InMemoryObjectStore OCC, Lazy Evaluation & Atomic Commits", () => {
  it("does NOT eagerly mutate internal store when effect is constructed (lazy writes)", async () => {
    const store = new InMemoryObjectStore();
    const obj = makeObj("eager-check", 1);

    // Construct effect without running it
    const effect = store.putObject(obj);

    // Inspect store before running
    const beforeRun = await Effect.runPromise(
      store.getObject("Entity" as any, "eager-check")
    );
    expect(beforeRun).toBeUndefined();

    // Now run effect
    await Effect.runPromise(effect);
    const afterRun = await Effect.runPromise(
      store.getObject("Entity" as any, "eager-check")
    );
    expect(afterRun).toBeDefined();
    expect(afterRun?.version).toBe(1);
  });

  it("rejects version-1 overwrite of an already existing object (F09 version-1 escape defense)", async () => {
    const store = new InMemoryObjectStore();
    await Effect.runPromise(
      store.putObject(makeObj("v1-defense", 1, "initial"))
    );
    await Effect.runPromise(
      store.putObject(makeObj("v1-defense", 2, "updated-v2"))
    );

    // Attempt to overwrite existing v2 object with version 1
    let error: unknown;
    try {
      await Effect.runPromise(
        store.putObject(makeObj("v1-defense", 1, "rogue-v1-overwrite"))
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(ConcurrentModificationError);
    const current = await Effect.runPromise(
      store.getObject("Entity" as any, "v1-defense")
    );
    expect(current?.version).toBe(2);
    expect(current?.properties.label).toBe("updated-v2");
  });

  it("commits multiple objects and links atomically in one transaction", async () => {
    const store = new InMemoryObjectStore();
    const objA = makeObj("objA", 1);
    const objB = makeObj("objB", 1);

    await Effect.runPromise(
      store.commitAtomicTransaction({
        mutations: [
          { type: "put", instance: objA },
          { type: "put", instance: objB },
        ],
      })
    );

    const a = await Effect.runPromise(store.getObject("Entity" as any, "objA"));
    const b = await Effect.runPromise(store.getObject("Entity" as any, "objB"));
    expect(a?.version).toBe(1);
    expect(b?.version).toBe(1);
  });

  it("rolls back multi-object batch if any object has a concurrency conflict (all-or-nothing)", async () => {
    const store = new InMemoryObjectStore();
    await Effect.runPromise(store.putObject(makeObj("objA", 1, "origA")));
    await Effect.runPromise(store.putObject(makeObj("objB", 1, "origB")));

    // Batch with valid objA v2 and CONFLICTING objB (version 5 when version 2 expected)
    let failed = false;
    try {
      await Effect.runPromise(
        store.commitAtomicTransaction({
          mutations: [
            { type: "put", instance: makeObj("objA", 2, "modifiedA") },
            { type: "put", instance: makeObj("objB", 5, "invalidB") },
          ],
        })
      );
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);

    // Verify objA was NOT modified and remains version 1!
    const a = await Effect.runPromise(store.getObject("Entity" as any, "objA"));
    expect(a?.version).toBe(1);
    expect(a?.properties.label).toBe("origA");

    // Verify objB was NOT modified and remains version 1!
    const b = await Effect.runPromise(store.getObject("Entity" as any, "objB"));
    expect(b?.version).toBe(1);
    expect(b?.properties.label).toBe("origB");
  });
});
