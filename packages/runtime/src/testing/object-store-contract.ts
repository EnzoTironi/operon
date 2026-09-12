import type { LinkTypeId, ObjectInstance, ObjectTypeId } from "@operon/schema";
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConcurrentModificationError } from "../errors.js";
import type { ObjectStore } from "../object-store.js";

/** Every store under contract must commit batches atomically. */
export type ContractObjectStore = ObjectStore & {
  readonly commitAtomicTransaction: NonNullable<
    ObjectStore["commitAtomicTransaction"]
  >;
};

export interface ObjectStoreFixture {
  readonly store: ContractObjectStore;
  readonly close: () => Promise<void>;
}

const ENTITY = "Entity" as ObjectTypeId;
const KNOWS = "Knows" as LinkTypeId;

const makeObj = (
  id: string,
  version: number,
  label = "test"
): ObjectInstance => ({
  id,
  lastModifiedAt: 1000,
  properties: { label },
  typeId: ENTITY,
  version,
});

function isConcurrentModification(
  exit: Exit.Exit<unknown, ConcurrentModificationError>
): boolean {
  return (
    Exit.isFailure(exit) &&
    exit.cause.reasons.some(
      (reason) =>
        reason._tag === "Fail" &&
        reason.error._tag === "ConcurrentModificationError"
    )
  );
}

/**
 * Behavioural contract shared by every `ObjectStore` implementation. Each
 * `it` runs against a fresh store from `open`, so implementations with
 * external state (SQLite files, Postgres databases) start clean.
 */
export function describeObjectStoreContract(
  name: string,
  open: () => Promise<ObjectStoreFixture>
): void {
  describe(`${name} ObjectStore contract`, () => {
    let fixture: ObjectStoreFixture;

    beforeAll(async () => {
      fixture = await open();
    });

    afterAll(async () => {
      await fixture.close();
    });

    it("does not mutate the store when an effect is constructed but not run", async () => {
      const { store } = fixture;
      const effect = store.putObject(makeObj("lazy", 1));
      expect(await Effect.runPromise(store.getObject(ENTITY, "lazy"))).toBe(
        undefined
      );
      await Effect.runPromise(effect);
      const after = await Effect.runPromise(store.getObject(ENTITY, "lazy"));
      expect(after?.version).toBe(1);
    });

    it("returns the latest version after successive puts", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("versioned", 1, "one")));
      await Effect.runPromise(store.putObject(makeObj("versioned", 2, "two")));
      const current = await Effect.runPromise(
        store.getObject(ENTITY, "versioned")
      );
      expect(current?.version).toBe(2);
      expect(current?.properties.label).toBe("two");
      expect(current?.typeId).toBe(ENTITY);
      expect(typeof current?.lastModifiedAt).toBe("number");
    });

    it("rejects a version-1 overwrite of an existing object", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("v1-defense", 1)));
      await Effect.runPromise(
        store.putObject(makeObj("v1-defense", 2, "updated-v2"))
      );
      const exit = await Effect.runPromiseExit(
        store.putObject(makeObj("v1-defense", 1, "rogue"))
      );
      expect(isConcurrentModification(exit)).toBe(true);
      const current = await Effect.runPromise(
        store.getObject(ENTITY, "v1-defense")
      );
      expect(current?.version).toBe(2);
      expect(current?.properties.label).toBe("updated-v2");
    });

    it("rejects a version that skips ahead", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("skip", 1)));
      const exit = await Effect.runPromiseExit(
        store.putObject(makeObj("skip", 3))
      );
      expect(isConcurrentModification(exit)).toBe(true);
    });

    it("round-trips nested JSON properties", async () => {
      const { store } = fixture;
      const properties = {
        flags: [true, false],
        nested: { count: 3, label: "ação" },
        ratio: 0.25,
      };
      await Effect.runPromise(
        store.putObject({ ...makeObj("json", 1), properties })
      );
      const stored = await Effect.runPromise(store.getObject(ENTITY, "json"));
      expect(stored?.properties).toEqual(properties);
    });

    it("finds objects of a type and applies the predicate", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("find-a", 1, "keep")));
      await Effect.runPromise(store.putObject(makeObj("find-b", 1, "drop")));
      const kept = await Effect.runPromise(
        store.findObjects(
          ENTITY,
          (instance) => instance.properties.label === "keep"
        )
      );
      expect(kept.map((instance) => instance.id)).toEqual(["find-a"]);
      const all = await Effect.runPromise(store.findObjects(ENTITY));
      expect(all.map((instance) => instance.id)).toEqual(
        expect.arrayContaining(["find-a", "find-b"])
      );
    });

    it("deletes the current object", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("gone", 1)));
      await Effect.runPromise(store.deleteObject(ENTITY, "gone"));
      expect(await Effect.runPromise(store.getObject(ENTITY, "gone"))).toBe(
        undefined
      );
    });

    it("stores links with metadata and reads them by source", async () => {
      const { store } = fixture;
      await Effect.runPromise(
        store.linkObjects({
          createdAt: 5000,
          linkTypeId: KNOWS,
          metadata: { since: 2020 },
          sourceId: "ana",
          targetId: "bia",
        })
      );
      const links = await Effect.runPromise(store.getLinks(KNOWS, "ana"));
      expect(links).toHaveLength(1);
      expect(links[0]?.targetId).toBe("bia");
      expect(links[0]?.metadata).toEqual({ since: 2020 });
      expect(await Effect.runPromise(store.getLinks(KNOWS, "bia"))).toEqual([]);
    });

    it("commits multiple objects and links in one transaction", async () => {
      const { store } = fixture;
      await Effect.runPromise(
        store.commitAtomicTransaction({
          links: [
            {
              createdAt: 1000,
              linkTypeId: KNOWS,
              sourceId: "batchA",
              targetId: "batchB",
            },
          ],
          mutations: [
            { instance: makeObj("batchA", 1), type: "put" },
            { instance: makeObj("batchB", 1), type: "put" },
          ],
        })
      );
      const a = await Effect.runPromise(store.getObject(ENTITY, "batchA"));
      const b = await Effect.runPromise(store.getObject(ENTITY, "batchB"));
      expect(a?.version).toBe(1);
      expect(b?.version).toBe(1);
      const links = await Effect.runPromise(store.getLinks(KNOWS, "batchA"));
      expect(links.map((link) => link.targetId)).toEqual(["batchB"]);
    });

    it("rolls back the whole batch when one mutation conflicts", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("rbA", 1, "origA")));
      await Effect.runPromise(store.putObject(makeObj("rbB", 1, "origB")));
      const exit = await Effect.runPromiseExit(
        store.commitAtomicTransaction({
          mutations: [
            { instance: makeObj("rbA", 2, "modifiedA"), type: "put" },
            { instance: makeObj("rbB", 5, "invalidB"), type: "put" },
          ],
        })
      );
      expect(isConcurrentModification(exit)).toBe(true);
      const a = await Effect.runPromise(store.getObject(ENTITY, "rbA"));
      const b = await Effect.runPromise(store.getObject(ENTITY, "rbB"));
      expect(a?.version).toBe(1);
      expect(a?.properties.label).toBe("origA");
      expect(b?.version).toBe(1);
      expect(b?.properties.label).toBe("origB");
    });

    it("applies a delete mutation inside a batch", async () => {
      const { store } = fixture;
      await Effect.runPromise(store.putObject(makeObj("del-in-batch", 1)));
      await Effect.runPromise(
        store.commitAtomicTransaction({
          mutations: [{ id: "del-in-batch", type: "delete", typeId: ENTITY }],
        })
      );
      expect(
        await Effect.runPromise(store.getObject(ENTITY, "del-in-batch"))
      ).toBe(undefined);
    });
  });
}
