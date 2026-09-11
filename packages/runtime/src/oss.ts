import type {
  LinkInstance,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
} from "@operon/schema";
import { Effect } from "effect";

import type { ObjectStore } from "./object-store.js";

export interface AggregateOptions {
  readonly metric: "count" | "sum" | "avg" | "min" | "max";
  readonly propertyName?: string;
  readonly groupByProperty?: string;
}

export interface AggregateResult {
  readonly value: number;
  readonly groups?: Record<string, number>;
}

/**
 * OSS: Object Set abstraction representing a queryable, composable collection of objects
 */
export class ObjectSet {
  private readonly store: ObjectStore;
  readonly objectTypeId: ObjectTypeId;
  private readonly loader: () => Effect.Effect<readonly ObjectInstance[]>;

  constructor(
    store: ObjectStore,
    objectTypeId: ObjectTypeId,
    loader?: () => Effect.Effect<readonly ObjectInstance[]>
  ) {
    this.store = store;
    this.objectTypeId = objectTypeId;
    this.loader = loader ?? (() => store.findObjects(objectTypeId));
  }

  /**
   * Materialize the current set of objects
   */
  all(): Effect.Effect<readonly ObjectInstance[]> {
    return this.loader();
  }

  /**
   * Filter the set by a predicate
   */
  filter(predicate: (instance: ObjectInstance) => boolean): ObjectSet {
    return new ObjectSet(this.store, this.objectTypeId, () =>
      this.loader().pipe(Effect.map((instances) => instances.filter(predicate)))
    );
  }

  /**
   * Filter where property equals value
   */
  whereEquals(propertyName: string, value: unknown): ObjectSet {
    return this.filter(
      (inst) =>
        (inst.properties as Record<string, unknown>)[propertyName] === value
    );
  }

  /**
   * Union of this set with another set of the same object type
   */
  union(other: ObjectSet): ObjectSet {
    return new ObjectSet(this.store, this.objectTypeId, () =>
      Effect.zipWith(this.loader(), other.loader(), (a, b) => {
        const map = new Map<string, ObjectInstance>();
        for (const item of a) {
          map.set(item.id, item);
        }
        for (const item of b) {
          map.set(item.id, item);
        }
        return [...map.values()];
      })
    );
  }

  /**
   * Intersection of this set with another set
   */
  intersect(other: ObjectSet): ObjectSet {
    return new ObjectSet(this.store, this.objectTypeId, () =>
      Effect.zipWith(this.loader(), other.loader(), (a, b) => {
        const bIds = new Set(b.map((x) => x.id));
        return a.filter((item) => bIds.has(item.id));
      })
    );
  }

  /**
   * Difference (this set minus another set)
   */
  difference(other: ObjectSet): ObjectSet {
    return new ObjectSet(this.store, this.objectTypeId, () =>
      Effect.zipWith(this.loader(), other.loader(), (a, b) => {
        const bIds = new Set(b.map((x) => x.id));
        return a.filter((item) => !bIds.has(item.id));
      })
    );
  }

  /**
   * Sort objects by property
   */
  sortBy(propertyName: string, direction: "asc" | "desc" = "asc"): ObjectSet {
    return new ObjectSet(this.store, this.objectTypeId, () =>
      this.loader().pipe(
        Effect.map((instances) =>
          instances.toSorted((a, b) => {
            const valA = (a.properties as Record<string, unknown>)[
              propertyName
            ];
            const valB = (b.properties as Record<string, unknown>)[
              propertyName
            ];
            if (valA === valB) {
              return 0;
            }
            const res =
              (valA as number | string) > (valB as number | string) ? 1 : -1;
            return direction === "asc" ? res : -res;
          })
        )
      )
    );
  }

  /**
   * Limit result set
   */
  take(count: number): ObjectSet {
    return new ObjectSet(this.store, this.objectTypeId, () =>
      this.loader().pipe(Effect.map((instances) => instances.slice(0, count)))
    );
  }

  /**
   * Compute aggregate metrics over the set
   */
  aggregate(opts: AggregateOptions): Effect.Effect<AggregateResult> {
    return this.loader().pipe(
      Effect.map((instances) => {
        if (opts.groupByProperty) {
          const groups: Record<string, number> = {};
          for (const item of instances) {
            const groupKey = String(
              (item.properties as Record<string, unknown>)[
                opts.groupByProperty
              ] ?? "unknown"
            );
            groups[groupKey] = (groups[groupKey] ?? 0) + 1;
          }
          return { groups, value: instances.length };
        }

        if (opts.metric === "count") {
          return { value: instances.length };
        }

        if (!opts.propertyName) {
          return { value: instances.length };
        }

        const propName = opts.propertyName;
        const values = instances
          .map((i) =>
            Number((i.properties as Record<string, unknown>)[propName])
          )
          .filter((v) => !Number.isNaN(v));

        if (values.length === 0) {
          return { value: 0 };
        }

        switch (opts.metric) {
          case "sum": {
            return { value: values.reduce((sum, v) => sum + v, 0) };
          }
          case "avg": {
            return {
              value: values.reduce((sum, v) => sum + v, 0) / values.length,
            };
          }
          case "min": {
            return { value: Math.min(...values) };
          }
          case "max": {
            return { value: Math.max(...values) };
          }
          default: {
            return { value: instances.length };
          }
        }
      })
    );
  }

  /**
   * Hop across links from this ObjectSet to a target ObjectSet
   */
  traverseLink(
    linkTypeId: LinkTypeId,
    targetObjectTypeId: ObjectTypeId,
    direction: "forward" | "reverse" = "forward"
  ): ObjectSet {
    const { store } = this;
    const { loader } = this;
    return new ObjectSet(this.store, targetObjectTypeId, () =>
      Effect.gen(function* () {
        const sourceObjects = yield* loader();
        const targetIds = new Set<string>();

        yield* Effect.forEach(
          sourceObjects,
          Effect.fn("ObjectSet.resolveSourceLinks")(function* (src) {
            let links: readonly LinkInstance[];
            if (direction === "forward") {
              links = yield* store.getLinks(linkTypeId, src.id);
            } else if (store.getReverseLinks) {
              links = yield* store.getReverseLinks(linkTypeId, src.id);
            } else {
              links = [];
            }

            for (const link of links) {
              const targetId =
                direction === "forward" ? link.targetId : link.sourceId;
              targetIds.add(targetId);
            }
          }),
          { concurrency: 1 }
        );

        const targetObjects: ObjectInstance[] = [];
        yield* Effect.forEach(
          [...targetIds],
          Effect.fn("ObjectSet.resolveTargetObject")(function* (tid) {
            const target = yield* store.getObject(targetObjectTypeId, tid);
            if (target) {
              targetObjects.push(target);
            }
          }),
          { concurrency: 1 }
        );

        return targetObjects as readonly ObjectInstance[];
      })
    );
  }
}

/**
 * OSS Entrypoint Service
 */
export class ObjectSetService {
  private readonly store: ObjectStore;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  getSet(objectTypeId: ObjectTypeId): ObjectSet {
    return new ObjectSet(this.store, objectTypeId);
  }
}
