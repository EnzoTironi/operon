import type {
  ConflictResolutionPolicy,
  FunnelPipelineConfig,
  ObjectInstance,
  ObjectTypeId,
} from "@operon/schema";
import { Data, Effect } from "effect";

import type { ObjectStore } from "./object-store.js";

export class PipelineNotFoundError extends Data.TaggedError(
  "PipelineNotFoundError"
)<{
  readonly pipelineId: string;
}> {}

export class FunnelIngestionError extends Data.TaggedError(
  "FunnelIngestionError"
)<{
  readonly pipelineId: string;
  readonly message: string;
}> {}

export interface IngestionResult {
  readonly processedCount: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly skippedCount: number;
}

/**
 * Funnel (Object Data Funnel)
 * Connects external batch & streaming data into the Object Store with conflict resolution.
 */
export class FunnelService {
  private readonly store: ObjectStore;
  private readonly pipelines = new Map<string, FunnelPipelineConfig>();

  constructor(store: ObjectStore) {
    this.store = store;
  }

  registerPipeline(config: FunnelPipelineConfig): Effect.Effect<void> {
    this.pipelines.set(config.id, config);
    return Effect.void;
  }

  getPipeline(
    id: string
  ): Effect.Effect<FunnelPipelineConfig, PipelineNotFoundError> {
    const p = this.pipelines.get(id);
    if (!p) {
      return Effect.fail(new PipelineNotFoundError({ pipelineId: id }));
    }
    return Effect.succeed(p);
  }

  /**
   * Ingest a batch of raw records from an external dataset
   */
  ingestBatch(
    pipelineId: string,
    rawRecords: readonly Record<string, unknown>[]
  ): Effect.Effect<
    IngestionResult,
    PipelineNotFoundError | FunnelIngestionError
  > {
    return Effect.gen({ self: this }, function* () {
      const pipeline = yield* this.getPipeline(pipelineId);

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const record of rawRecords) {
        const rawId = record[pipeline.primaryKeyField];
        if (rawId === undefined || rawId === null) {
          skippedCount++;
          continue;
        }
        const id = String(rawId);

        // Map properties
        const mappedProperties: Record<string, unknown> = {};
        for (const mapping of pipeline.propertyMappings) {
          const rawVal = record[mapping.sourceField];
          mappedProperties[mapping.targetPropertyName] = mapping.transform
            ? mapping.transform(rawVal)
            : rawVal;
        }

        const existing = yield* this.store.getObject(
          pipeline.targetObjectTypeId as ObjectTypeId,
          id
        );

        if (existing) {
          // Resolve conflict according to policy
          const shouldUpdate = this.resolveConflict(
            pipeline.conflictPolicy,
            existing,
            record
          );

          if (shouldUpdate) {
            const updatedInstance: ObjectInstance = {
              ...existing,
              lastModifiedAt: Date.now(),
              properties: {
                ...existing.properties,
                ...mappedProperties,
              },
              version: existing.version + 1,
            };
            yield* this.store.putObject(updatedInstance).pipe(
              Effect.mapError(
                (err) =>
                  new FunnelIngestionError({
                    message: `Failed to update object: ${err.message}`,
                    pipelineId,
                  })
              )
            );
            updatedCount++;
          } else {
            skippedCount++;
          }
        } else {
          const newInstance: ObjectInstance = {
            id,
            lastModifiedAt: Date.now(),
            properties: mappedProperties,
            typeId: pipeline.targetObjectTypeId as ObjectTypeId,
            version: 1,
          };
          yield* this.store.putObject(newInstance).pipe(
            Effect.mapError(
              (err) =>
                new FunnelIngestionError({
                  message: `Failed to insert object: ${err.message}`,
                  pipelineId,
                })
            )
          );
          createdCount++;
        }
      }

      return {
        createdCount,
        processedCount: rawRecords.length,
        skippedCount,
        updatedCount,
      };
    });
  }

  /**
   * Ingest a single streaming event
   */
  ingestStreamRecord(
    pipelineId: string,
    record: Record<string, unknown>
  ): Effect.Effect<
    ObjectInstance,
    PipelineNotFoundError | FunnelIngestionError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.ingestBatch(pipelineId, [record]);
      const pipeline = yield* this.getPipeline(pipelineId);
      const rawId = record[pipeline.primaryKeyField];
      const obj = yield* this.store.getObject(
        pipeline.targetObjectTypeId as ObjectTypeId,
        String(rawId)
      );
      if (!obj) {
        return yield* Effect.fail(
          new FunnelIngestionError({
            message: "Stream record could not be read after write",
            pipelineId,
          })
        );
      }
      return obj;
    });
  }

  private resolveConflict(
    policy: ConflictResolutionPolicy,
    existing: ObjectInstance,
    sourceRecord: Record<string, unknown>
  ): boolean {
    switch (policy) {
      case "source_wins": {
        return true;
      }
      case "user_edit_wins": {
        // If modified by human/agent action after creation, do not overwrite
        return existing.version <= 1;
      }
      case "timestamp_wins": {
        const sourceTime = Number(
          sourceRecord.timestamp ?? sourceRecord.updatedAt ?? 0
        );
        return sourceTime >= existing.lastModifiedAt;
      }
      default: {
        return true;
      }
    }
  }
}
