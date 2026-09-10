import type { ObjectInstance, ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";

import type { BitemporalObjectStore } from "./bitemporal-store.js";
import type { ConcurrentModificationError } from "./errors.js";

export type MigrationStage = "shadow_run" | "dual_run" | "cutover";

export type CdcOperation = "insert" | "update" | "delete";

export interface CdcEvent {
  readonly id: string;
  readonly sourceSystem: string;
  readonly table: string;
  readonly operation: CdcOperation;
  readonly primaryKey: Record<string, unknown>;
  readonly beforeState?: Record<string, unknown>;
  readonly afterState?: Record<string, unknown>;
  readonly capturedAt: number;
}

export interface ShadowDiff {
  readonly objectTypeId: ObjectTypeId;
  readonly objectId: string;
  readonly match: boolean;
  readonly legacyProperties: Record<string, unknown>;
  readonly operonProperties: Record<string, unknown>;
  readonly divergentKeys: readonly string[];
}

export interface CutoverMetrics {
  readonly stage: MigrationStage;
  readonly totalEventsProcessed: number;
  readonly totalShadowComparisons: number;
  readonly matchingCount: number;
  readonly divergenceCount: number;
  readonly consistencyRate: number;
  readonly readyForCutover: boolean;
}

/**
 * Migration & Coexistence Engine (Chapter 15: Three-Stage Migration Architecture)
 * Supports Shadow Run, Dual Run, and Cutover with CDC reconciliation.
 */
export class MigrationEngine {
  private currentStage: MigrationStage = "shadow_run";
  private totalEvents = 0;
  private totalComparisons = 0;
  private matches = 0;
  private divergences = 0;
  private readonly store: BitemporalObjectStore;

  constructor(store: BitemporalObjectStore) {
    this.store = store;
  }

  public getStage(): MigrationStage {
    return this.currentStage;
  }

  public setStage(stage: MigrationStage): Effect.Effect<void> {
    return Effect.sync(() => {
      this.currentStage = stage;
    });
  }

  /**
   * Ingest a Change Data Capture event from a legacy ERP / database
   */
  ingestCdcEvent(
    event: CdcEvent,
    objectTypeId: ObjectTypeId,
    mapper: (raw: Record<string, unknown>) => {
      readonly id: string;
      readonly properties: Record<string, unknown>;
    }
  ): Effect.Effect<void, ConcurrentModificationError> {
    return Effect.gen({ self: this }, function* () {
      this.totalEvents += 1;
      const targetData = event.afterState ?? event.beforeState ?? {};
      const { id, properties } = mapper(targetData);

      if (event.operation === "delete") {
        // Soft delete / tombstone representation
        const existing = yield* this.store.getObject(objectTypeId, id);
        yield* this.store.putObject({
          id,
          lastModifiedAt: event.capturedAt,
          properties: { ...properties, _deleted: true },
          provenance: {
            ingestedAt: Date.now(),
            recordedAt: event.capturedAt,
            sourceSystem: `cdc:${event.sourceSystem}`,
          },
          typeId: objectTypeId,
          version: existing ? existing.version + 1 : 1,
        });
        return;
      }

      // Query existing object if any to increment version
      const existing = yield* this.store.getObject(objectTypeId, id);
      const nextVersion = existing ? existing.version + 1 : 1;

      const newInstance: ObjectInstance = {
        id,
        lastModifiedAt: event.capturedAt,
        properties,
        provenance: {
          ingestedAt: Date.now(),
          recordedAt: event.capturedAt,
          sourceSystem: `cdc:${event.sourceSystem}`,
        },
        typeId: objectTypeId,
        version: nextVersion,
      };

      yield* this.store.putObject(newInstance, event.capturedAt);
    });
  }

  /**
   * Perform shadow diff comparison between legacy system record and Operon OSv2
   */
  compareShadowRecord(
    objectTypeId: ObjectTypeId,
    objectId: string,
    legacyProperties: Record<string, unknown>
  ): Effect.Effect<ShadowDiff> {
    return Effect.gen({ self: this }, function* () {
      this.totalComparisons += 1;
      const operonObj = yield* this.store.getObject(objectTypeId, objectId);
      const operonProps = operonObj ? operonObj.properties : {};

      const divergentKeys: string[] = [];
      const checkedKeys = new Set([
        ...Object.keys(legacyProperties),
        ...Object.keys(operonProps),
      ]);

      for (const key of checkedKeys) {
        if (key.startsWith("_")) {
          continue;
        }
        const legVal = legacyProperties[key];
        const opVal = operonProps[key];
        if (JSON.stringify(legVal) !== JSON.stringify(opVal)) {
          divergentKeys.push(key);
        }
      }

      const match = divergentKeys.length === 0;
      if (match) {
        this.matches += 1;
      } else {
        this.divergences += 1;
      }

      return {
        divergentKeys,
        legacyProperties,
        match,
        objectId,
        objectTypeId,
        operonProperties: operonProps,
      };
    });
  }

  /**
   * Returns calculated consistency and cutover readiness score
   */
  getCutoverMetrics(): CutoverMetrics {
    const consistencyRate =
      this.totalComparisons === 0 ? 1 : this.matches / this.totalComparisons;

    // Cutover gate: at least 10 comparisons, 99% consistency, and in dual_run stage
    const readyForCutover =
      this.totalComparisons >= 5 &&
      consistencyRate >= 0.95 &&
      this.currentStage === "dual_run";

    return {
      stage: this.currentStage,
      totalEventsProcessed: this.totalEvents,
      totalShadowComparisons: this.totalComparisons,
      matchingCount: this.matches,
      divergenceCount: this.divergences,
      consistencyRate,
      readyForCutover,
    };
  }
}
