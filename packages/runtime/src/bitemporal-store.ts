import type {
  BitemporalCoordinates,
  LinkInstance,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
} from "@operon/schema";
import { Effect } from "effect";

import { ConcurrentModificationError } from "./errors.js";
import type { ObjectStore } from "./object-store.js";

export interface VersionedObjectInstance extends ObjectInstance {
  readonly bitemporal: BitemporalCoordinates;
}

/**
 * Bitemporal Object Store supporting Valid Time (T_v) and Transaction Time (T_t)
 */
export class BitemporalObjectStore implements ObjectStore {
  private readonly timeline = new Map<string, VersionedObjectInstance[]>();
  private readonly links: LinkInstance[] = [];

  private static toKey(typeId: string, id: string): string {
    return `${typeId}:${id}`;
  }

  getObject(
    typeId: ObjectTypeId,
    id: string
  ): Effect.Effect<ObjectInstance | undefined> {
    const key = BitemporalObjectStore.toKey(typeId, id);
    const versions = this.timeline.get(key);
    if (!versions || versions.length === 0) {
      return Effect.void as Effect.Effect<undefined>;
    }
    const latest = versions.at(-1);
    return Effect.succeed(latest);
  }

  asOfValidTime(
    typeId: ObjectTypeId,
    id: string,
    validTimestamp: number
  ): Effect.Effect<ObjectInstance | undefined> {
    const key = BitemporalObjectStore.toKey(typeId, id);
    const versions = this.timeline.get(key);
    if (!versions) {
      return Effect.void as Effect.Effect<undefined>;
    }
    const matched = versions.findLast((v) => {
      const from = v.bitemporal.validTime.validFrom;
      const to = v.bitemporal.validTime.validTo;
      return (
        from <= validTimestamp && (to === undefined || to > validTimestamp)
      );
    });

    return Effect.succeed(matched);
  }

  asOfTransactionTime(
    typeId: ObjectTypeId,
    id: string,
    transactionTimestamp: number
  ): Effect.Effect<ObjectInstance | undefined> {
    const key = BitemporalObjectStore.toKey(typeId, id);
    const versions = this.timeline.get(key);
    if (!versions) {
      return Effect.void as Effect.Effect<undefined>;
    }
    const matched = versions.findLast((v) => {
      const recorded = v.bitemporal.transactionTime.recordedAt;
      const superseded = v.bitemporal.transactionTime.supersededAt;
      return (
        recorded <= transactionTimestamp &&
        (superseded === undefined || superseded > transactionTimestamp)
      );
    });

    return Effect.succeed(matched);
  }

  putObject(
    instance: ObjectInstance,
    validFrom = Date.now()
  ): Effect.Effect<ObjectInstance, ConcurrentModificationError> {
    const key = BitemporalObjectStore.toKey(instance.typeId, instance.id);
    const versions = this.timeline.get(key) ?? [];
    const current = versions.at(-1);

    let nextVersion: number;
    if (current) {
      if (
        instance.version !== current.version &&
        instance.version !== current.version + 1
      ) {
        return Effect.fail(
          new ConcurrentModificationError({
            actualVersion: instance.version,
            expectedVersion: current.version + 1,
            objectId: instance.id,
          })
        );
      }
      nextVersion = current.version + 1;
    } else {
      nextVersion = instance.version === 0 ? 1 : instance.version;
    }

    const now = Date.now();
    if (current) {
      const idx = versions.length - 1;
      const updatedPrev: VersionedObjectInstance = {
        ...current,
        bitemporal: {
          transactionTime: {
            ...current.bitemporal.transactionTime,
            supersededAt: now,
          },
          validTime: {
            ...current.bitemporal.validTime,
            validTo: current.bitemporal.validTime.validTo ?? now,
          },
        },
      };
      versions[idx] = updatedPrev;
    }

    const versionedInstance: VersionedObjectInstance = {
      ...instance,
      bitemporal: {
        transactionTime: { recordedAt: now },
        validTime: { validFrom },
      },
      lastModifiedAt: now,
      version: nextVersion,
    };

    versions.push(versionedInstance);
    this.timeline.set(key, versions);

    return Effect.succeed(versionedInstance);
  }

  deleteObject(typeId: ObjectTypeId, id: string): Effect.Effect<void> {
    const key = BitemporalObjectStore.toKey(typeId, id);
    this.timeline.delete(key);
    return Effect.void;
  }

  findObjects(
    typeId: ObjectTypeId,
    predicate?: (instance: ObjectInstance) => boolean
  ): Effect.Effect<readonly ObjectInstance[]> {
    const results: ObjectInstance[] = [];
    for (const [key, versions] of this.timeline.entries()) {
      if (key.startsWith(`${typeId}:`)) {
        const latest = versions.at(-1);
        if (latest && (!predicate || predicate(latest))) {
          results.push(latest);
        }
      }
    }
    return Effect.succeed(results);
  }

  linkObjects(link: LinkInstance): Effect.Effect<void> {
    this.links.push(link);
    return Effect.void;
  }

  getLinks(
    linkTypeId: LinkTypeId,
    sourceId: string
  ): Effect.Effect<readonly LinkInstance[]> {
    const filtered = this.links.filter(
      (l) => l.linkTypeId === linkTypeId && l.sourceId === sourceId
    );
    return Effect.succeed(filtered);
  }

  getReverseLinks(
    linkTypeId: LinkTypeId,
    targetId: string
  ): Effect.Effect<readonly LinkInstance[]> {
    const filtered = this.links.filter(
      (l) => l.linkTypeId === linkTypeId && l.targetId === targetId
    );
    return Effect.succeed(filtered);
  }
}
