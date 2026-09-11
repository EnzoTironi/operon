import type {
  LinkInstance,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
} from "@operon/schema";
import { Clock, Effect } from "effect";

import { ConcurrentModificationError } from "./errors.js";

export type ObjectMutation =
  | {
      readonly type: "put";
      readonly instance: ObjectInstance;
    }
  | {
      readonly type: "delete";
      readonly typeId: ObjectTypeId;
      readonly id: string;
    };

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

function toObjectKey(typeId: ObjectTypeId, id: string): string {
  return `${typeId}:${id}`;
}

const putObjectImpl = Effect.fn("InMemoryObjectStore.putObject")(function* (
  objects: Map<string, ObjectInstance>,
  instance: ObjectInstance
) {
  const k = toObjectKey(instance.typeId, instance.id);
  const existing = objects.get(k);

  if (existing && instance.version !== existing.version + 1) {
    return yield* new ConcurrentModificationError({
      actualVersion: instance.version,
      expectedVersion: existing.version + 1,
      objectId: instance.id,
    });
  }

  const now = yield* Clock.currentTimeMillis;
  const copy: ObjectInstance = {
    ...structuredClone(instance),
    lastModifiedAt: now,
  };
  objects.set(k, copy);
  return copy;
});

const commitAtomicTransactionImpl = Effect.fn(
  "InMemoryObjectStore.commitAtomicTransaction"
)(function* (
  validate: (
    mutations: readonly ObjectMutation[]
  ) => Effect.Effect<void, ConcurrentModificationError>,
  apply: (
    mutations: readonly ObjectMutation[],
    links: readonly LinkInstance[] | undefined,
    now: number
  ) => void,
  batch: AtomicTransactionBatch
) {
  yield* validate(batch.mutations);
  const now = yield* Clock.currentTimeMillis;
  apply(batch.mutations, batch.links, now);
});

/**
 * In-memory reference implementation of ObjectStore with deferred evaluation,
 * strict OCC (preventing version-1 overwrite escape), clone isolation, and atomic multi-object commits.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, ObjectInstance>();
  private readonly links: LinkInstance[] = [];

  static toKey(typeId: ObjectTypeId, id: string): string {
    return toObjectKey(typeId, id);
  }

  getObject(
    typeId: ObjectTypeId,
    id: string
  ): Effect.Effect<ObjectInstance | undefined> {
    return Effect.sync(() => {
      const instance = this.objects.get(InMemoryObjectStore.toKey(typeId, id));
      return instance ? structuredClone(instance) : undefined;
    });
  }

  putObject(
    instance: ObjectInstance
  ): Effect.Effect<ObjectInstance, ConcurrentModificationError> {
    return putObjectImpl(this.objects, instance);
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
      for (const [k, v] of this.objects) {
        if (k.startsWith(`${typeId}:`) && (!predicate || predicate(v))) {
          results.push(structuredClone(v));
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

  private validateBatchPreconditions(
    mutations: readonly ObjectMutation[]
  ): Effect.Effect<void, ConcurrentModificationError> {
    for (const mutation of mutations) {
      if (mutation.type === "put") {
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
    return Effect.void;
  }

  private applyBatchMutations(
    mutations: readonly ObjectMutation[],
    links: readonly LinkInstance[] | undefined,
    now: number
  ): void {
    for (const mutation of mutations) {
      if (mutation.type === "put") {
        const k = InMemoryObjectStore.toKey(
          mutation.instance.typeId,
          mutation.instance.id
        );
        this.objects.set(k, {
          ...structuredClone(mutation.instance),
          lastModifiedAt: now,
        });
      } else {
        this.objects.delete(
          InMemoryObjectStore.toKey(mutation.typeId, mutation.id)
        );
      }
    }

    if (links) {
      for (const link of links) {
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
  }

  commitAtomicTransaction(
    batch: AtomicTransactionBatch
  ): Effect.Effect<void, ConcurrentModificationError> {
    return commitAtomicTransactionImpl(
      (m) => this.validateBatchPreconditions(m),
      (m, l, n) => this.applyBatchMutations(m, l, n),
      batch
    );
  }

  exportSnapshot(): InMemoryObjectSnapshot {
    return {
      links: [...this.links],
      objects: [...this.objects.values()],
    };
  }

  importSnapshot(snapshot: InMemoryObjectSnapshot): void {
    this.objects.clear();
    for (const obj of snapshot.objects) {
      this.objects.set(
        InMemoryObjectStore.toKey(obj.typeId, obj.id),
        structuredClone(obj)
      );
    }
    if (snapshot.links) {
      this.links.length = 0;
      this.links.push(...snapshot.links.map((link) => structuredClone(link)));
    }
  }
}

export interface InMemoryObjectSnapshot {
  readonly objects: readonly ObjectInstance[];
  readonly links?: readonly LinkInstance[];
}
