import type {
  LinkInstance,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
} from "@operon/schema";
import { Effect } from "effect";

import { ConcurrentModificationError } from "./errors.js";

export interface ObjectMutation {
  readonly type: "put" | "delete";
  readonly instance?: ObjectInstance;
  readonly typeId?: ObjectTypeId;
  readonly id?: string;
}

export interface AtomicTransactionBatch {
  readonly mutations: readonly ObjectMutation[];
  readonly links?: readonly LinkInstance[];
}

export interface ObjectStore {
  readonly getObject: (
    typeId: ObjectTypeId,
    id: string
  ) => Effect.Effect<ObjectInstance | undefined>;
  readonly putObject: (
    instance: ObjectInstance
  ) => Effect.Effect<ObjectInstance, ConcurrentModificationError>;
  readonly deleteObject: (
    typeId: ObjectTypeId,
    id: string
  ) => Effect.Effect<void>;
  readonly findObjects: (
    typeId: ObjectTypeId,
    predicate?: (instance: ObjectInstance) => boolean
  ) => Effect.Effect<readonly ObjectInstance[]>;
  readonly linkObjects: (link: LinkInstance) => Effect.Effect<void>;
  readonly getLinks: (
    linkTypeId: LinkTypeId,
    sourceId: string
  ) => Effect.Effect<readonly LinkInstance[]>;
  readonly getReverseLinks?: (
    linkTypeId: LinkTypeId,
    targetId: string
  ) => Effect.Effect<readonly LinkInstance[]>;
  readonly commitAtomicTransaction?: (
    batch: AtomicTransactionBatch
  ) => Effect.Effect<void, ConcurrentModificationError>;
  readonly revertObject?: (
    typeId: ObjectTypeId,
    id: string,
    previousInstance?: ObjectInstance
  ) => Effect.Effect<void>;
}

/**
 * In-memory reference implementation of ObjectStore with deferred evaluation,
 * strict OCC (preventing version-1 overwrite escape), clone isolation, and atomic multi-object commits.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, ObjectInstance>();
  private readonly links: LinkInstance[] = [];

  private static toKey(typeId: string, id: string): string {
    return `${typeId}:${id}`;
  }

  getObject(
    typeId: ObjectTypeId,
    id: string
  ): Effect.Effect<ObjectInstance | undefined> {
    return Effect.sync(() => {
      const obj = this.objects.get(InMemoryObjectStore.toKey(typeId, id));
      return obj ? structuredClone(obj) : undefined;
    });
  }

  putObject(
    instance: ObjectInstance
  ): Effect.Effect<ObjectInstance, ConcurrentModificationError> {
    return Effect.suspend(() => {
      const k = InMemoryObjectStore.toKey(instance.typeId, instance.id);
      const existing = this.objects.get(k);

      if (existing && instance.version !== existing.version + 1) {
        return Effect.fail(
          new ConcurrentModificationError({
            actualVersion: instance.version,
            expectedVersion: existing.version + 1,
            objectId: instance.id,
          })
        );
      }

      const updated: ObjectInstance = {
        ...structuredClone(instance),
        lastModifiedAt: Date.now(),
      };
      this.objects.set(k, updated);
      return Effect.succeed(structuredClone(updated));
    });
  }

  deleteObject(typeId: ObjectTypeId, id: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.objects.delete(InMemoryObjectStore.toKey(typeId, id));
    });
  }

  revertObject(
    typeId: ObjectTypeId,
    id: string,
    previousInstance?: ObjectInstance
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      const k = InMemoryObjectStore.toKey(typeId, id);
      if (previousInstance) {
        this.objects.set(k, structuredClone(previousInstance));
      } else {
        this.objects.delete(k);
      }
    });
  }

  findObjects(
    typeId: ObjectTypeId,
    predicate?: (instance: ObjectInstance) => boolean
  ): Effect.Effect<readonly ObjectInstance[]> {
    return Effect.sync(() => {
      const results: ObjectInstance[] = [];
      for (const obj of this.objects.values()) {
        if (obj.typeId === typeId && (!predicate || predicate(obj))) {
          results.push(structuredClone(obj));
        }
      }
      return results;
    });
  }

  linkObjects(link: LinkInstance): Effect.Effect<void> {
    return Effect.sync(() => {
      const exists = this.links.some(
        (l) =>
          l.linkTypeId === link.linkTypeId &&
          l.sourceId === link.sourceId &&
          l.targetId === link.targetId
      );
      if (!exists) {
        this.links.push(structuredClone(link));
      }
    });
  }

  getLinks(
    linkTypeId: LinkTypeId,
    sourceId: string
  ): Effect.Effect<readonly LinkInstance[]> {
    return Effect.sync(() =>
      this.links
        .filter((l) => l.linkTypeId === linkTypeId && l.sourceId === sourceId)
        .map((l) => structuredClone(l))
    );
  }

  getReverseLinks(
    linkTypeId: LinkTypeId,
    targetId: string
  ): Effect.Effect<readonly LinkInstance[]> {
    return Effect.sync(() =>
      this.links
        .filter((l) => l.linkTypeId === linkTypeId && l.targetId === targetId)
        .map((l) => structuredClone(l))
    );
  }

  commitAtomicTransaction(
    batch: AtomicTransactionBatch
  ): Effect.Effect<void, ConcurrentModificationError> {
    return Effect.suspend(() => {
      // 1. Validation phase (validate ALL optimistic concurrency preconditions before applying any mutation)
      for (const mutation of batch.mutations) {
        if (mutation.type === "put" && mutation.instance) {
          const k = InMemoryObjectStore.toKey(
            mutation.instance.typeId,
            mutation.instance.id
          );
          const existing = this.objects.get(k);
          if (existing && mutation.instance.version !== existing.version + 1) {
            return Effect.fail(
              new ConcurrentModificationError({
                actualVersion: mutation.instance.version,
                expectedVersion: existing.version + 1,
                objectId: mutation.instance.id,
              })
            );
          }
        }
      }

      // 2. Execution phase (all-or-nothing: apply all staged mutations and links)
      const now = Date.now();
      for (const mutation of batch.mutations) {
        if (mutation.type === "put" && mutation.instance) {
          const k = InMemoryObjectStore.toKey(
            mutation.instance.typeId,
            mutation.instance.id
          );
          this.objects.set(k, {
            ...structuredClone(mutation.instance),
            lastModifiedAt: now,
          });
        } else if (
          mutation.type === "delete" &&
          mutation.typeId &&
          mutation.id
        ) {
          this.objects.delete(
            InMemoryObjectStore.toKey(mutation.typeId, mutation.id)
          );
        }
      }

      if (batch.links) {
        for (const link of batch.links) {
          const exists = this.links.some(
            (l) =>
              l.linkTypeId === link.linkTypeId &&
              l.sourceId === link.sourceId &&
              l.targetId === link.targetId
          );
          if (!exists) {
            this.links.push(structuredClone(link));
          }
        }
      }
      return Effect.void;
    });
  }
}
