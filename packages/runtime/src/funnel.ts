import type {
  CandidateRecord,
  ConflictResolutionPolicy,
  FieldProvenance,
  FunnelPipelineConfig,
  IngestionReceipt,
  MappingProposal,
  ObjectInstance,
  ObjectTypeId,
  SensitivityLevel,
  SourceArtifact,
  Subject,
} from "@operon/schema";
import { computeSourceDigest } from "@operon/schema";
import { Data, Effect } from "effect";

import type { ConcurrentModificationError } from "./errors.js";
import { IdempotencyConflictError } from "./errors.js";
import {
  ContradictoryInputError,
  CorruptInputError,
  UnknownSourceError,
} from "./ingestion-errors.js";
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

export interface IngestRawSourceOptions {
  readonly locator: string;
  readonly mediaType: string;
  readonly rawPayload: unknown;
  readonly permittedUses?: readonly string[];
  readonly sensitivity?: SensitivityLevel;
  readonly tenantId?: string;
  readonly environmentId?: string;
  readonly idempotencyKey?: string;
}

export interface ProposeMappingOptions {
  readonly sourceIds: readonly string[];
  readonly definitionDigest: string;
  readonly targetObjectTypeId: ObjectTypeId;
  readonly primaryKeyField: string;
  readonly propertyMappings: readonly {
    readonly sourceField: string;
    readonly targetPropertyName: string;
  }[];
  readonly author: Subject;
  readonly tenantId?: string;
}

/**
 * Accountable Ingestion Service (S03, S15, Chapter 15 & 16)
 *
 * Rules:
 * 1. Raw evidence stays attributed in SourceArtifact inventory and CANNOT silently
 *    become admitted truth in the Object Store (S03).
 * 2. Ingestion is strictly idempotent: replaying the same source returns the existing receipt;
 *    the same idempotency key with different payload conflicts (IdempotencyConflictError).
 * 3. Every accepted field in a mapping proposal resolves to artifact/locator/mapping/batch (FieldProvenance).
 * 4. Corrupt, unknown, and contradictory inputs yield explicit typed errors.
 * 5. Wrong tenant/environment reference does not disclose existence.
 */
export class AccountableIngestionService {
  private readonly sourceInventory = new Map<string, SourceArtifact>();
  private readonly idempotencyRegistry = new Map<
    string,
    {
      readonly sourceId: string;
      readonly digest: string;
      readonly receipt: IngestionReceipt;
    }
  >();
  private readonly mappingProposals = new Map<string, MappingProposal>();

  constructor(private readonly store: ObjectStore) {}

  /**
   * Ingest a raw source artifact into the inventory before any mapping or admission.
   */
  ingestRawSource(
    options: IngestRawSourceOptions
  ): Effect.Effect<
    IngestionReceipt,
    IdempotencyConflictError | CorruptInputError
  > {
    return Effect.gen({ self: this }, function* () {
      let payload = options.rawPayload;

      // 1. Validate payload
      if (
        payload === undefined ||
        payload === null ||
        (typeof payload === "string" && payload.trim() === "")
      ) {
        return yield* Effect.fail(
          new CorruptInputError({
            locator: options.locator,
            reason: "Raw payload is empty, undefined, or null",
          })
        );
      }

      // If string and mediaType is JSON, parse it to ensure valid structure
      if (options.mediaType.includes("json") && typeof payload === "string") {
        payload = yield* Effect.try({
          catch: (error: unknown) =>
            new CorruptInputError({
              locator: options.locator,
              reason: `Corrupt JSON payload: ${String((error as any)?.message ?? error)}`,
            }),
          try: () => JSON.parse(payload as string),
        });
      }

      // 2. Compute canonical digest
      const digest = computeSourceDigest(payload);

      // 3. Check idempotency
      if (options.idempotencyKey) {
        const existing = this.idempotencyRegistry.get(options.idempotencyKey);
        if (existing) {
          if (existing.digest === digest) {
            return {
              ...existing.receipt,
              status: "replayed" as const,
            };
          }
          return yield* Effect.fail(
            new IdempotencyConflictError({
              idempotencyKey: options.idempotencyKey,
              message: `Idempotency conflict for key '${options.idempotencyKey}': existing digest '${existing.digest}', new digest '${digest}'`,
            })
          );
        }
      }

      // 4. Create SourceArtifact
      const now = Date.now();
      const sourceId = `src_${now}_${Math.random().toString(36).slice(2, 8)}`;
      const batchId = `batch_${now}_${Math.random().toString(36).slice(2, 8)}`;

      const artifact: SourceArtifact = {
        batchId,
        digest,
        environmentId: options.environmentId,
        locator: options.locator,
        mediaType: options.mediaType,
        permittedUses: options.permittedUses ?? [
          "operational_analysis",
          "decision_support",
        ],
        rawPayload: payload,
        receivedAt: now,
        sensitivity: options.sensitivity ?? "internal",
        sourceId,
        tenantId: options.tenantId,
      };

      this.sourceInventory.set(sourceId, artifact);

      const receipt: IngestionReceipt = {
        batchId,
        idempotencyKey: options.idempotencyKey,
        sourceArtifact: artifact,
        status: "ingested",
        timestamp: now,
      };

      if (options.idempotencyKey) {
        this.idempotencyRegistry.set(options.idempotencyKey, {
          digest,
          receipt,
          sourceId,
        });
      }

      return receipt;
    });
  }

  /**
   * Retrieve a source artifact with non-disclosure of existence on tenant mismatch.
   */
  getSource(
    sourceId: string,
    tenantId?: string
  ): Effect.Effect<SourceArtifact, UnknownSourceError> {
    return Effect.gen({ self: this }, function* () {
      const src = this.sourceInventory.get(sourceId);
      if (!src) {
        return yield* Effect.fail(new UnknownSourceError({ sourceId }));
      }
      // Non-disclosure invariant: mismatching tenant returns identical error as not found
      if (tenantId && src.tenantId && src.tenantId !== tenantId) {
        return yield* Effect.fail(new UnknownSourceError({ sourceId }));
      }
      return src;
    });
  }

  /**
   * List source artifacts, optionally scoped to a tenant.
   */
  listSources(tenantId?: string): Effect.Effect<readonly SourceArtifact[]> {
    return Effect.sync(() => {
      const all = [...this.sourceInventory.values()];
      if (!tenantId) return all;
      return all.filter((s) => !s.tenantId || s.tenantId === tenantId);
    });
  }

  /**
   * Propose a mapping from raw sources to candidate records with full provenance tracking (S15).
   */
  proposeMapping(
    options: ProposeMappingOptions
  ): Effect.Effect<
    MappingProposal,
    UnknownSourceError | ContradictoryInputError
  > {
    return Effect.gen({ self: this }, function* () {
      const sources: SourceArtifact[] = [];
      for (const srcId of options.sourceIds) {
        const src = yield* this.getSource(srcId, options.tenantId);
        sources.push(src);
      }

      const candidateRecords: CandidateRecord[] = [];
      const seenRecordsById = new Map<string, CandidateRecord>();
      const openQuestions: string[] = [];

      for (const src of sources) {
        const payload = src.rawPayload;
        const items: readonly Record<string, unknown>[] = Array.isArray(payload)
          ? payload
          : typeof payload === "object" && payload !== null
            ? [payload as Record<string, unknown>]
            : [];

        for (const item of items) {
          const rawPk = item[options.primaryKeyField];
          if (rawPk === undefined || rawPk === null) {
            openQuestions.push(
              `Record in source '${src.sourceId}' missing primary key field '${options.primaryKeyField}'`
            );
            continue;
          }
          const pkStr = String(rawPk);

          const mappedProps: Record<string, unknown> = {};
          const fieldProvenances: Record<string, FieldProvenance> = {};

          for (const rule of options.propertyMappings) {
            const val = item[rule.sourceField];
            if (val !== undefined) {
              mappedProps[rule.targetPropertyName] = val;
              fieldProvenances[rule.targetPropertyName] = {
                batchId: src.batchId,
                digest: src.digest,
                fieldPath: rule.sourceField,
                locator: src.locator,
                sourceId: src.sourceId,
              };
            }
          }

          // Check for contradictory inputs within the same batch/proposal
          const prev = seenRecordsById.get(pkStr);
          if (prev) {
            const conflictingProps: string[] = [];
            for (const [propName, propVal] of Object.entries(mappedProps)) {
              if (
                prev.properties[propName] !== undefined &&
                prev.properties[propName] !== propVal
              ) {
                conflictingProps.push(propName);
              }
            }
            if (conflictingProps.length > 0) {
              return yield* Effect.fail(
                new ContradictoryInputError({
                  conflictingProperties: conflictingProps,
                  reason: `Contradictory values for record '${pkStr}': properties [${conflictingProps.join(
                    ", "
                  )}] conflict across sources`,
                  recordId: pkStr,
                })
              );
            }
          }

          const candidate: CandidateRecord = {
            confidence: 0.95,
            properties: mappedProps,
            provenance: {
              batchId: src.batchId,
              digest: src.digest,
              fieldProvenances,
              locator: src.locator,
              sourceId: src.sourceId,
            },
            rawRecordId: pkStr,
            targetObjectTypeId: options.targetObjectTypeId,
          };

          seenRecordsById.set(pkStr, candidate);
          candidateRecords.push(candidate);
        }
      }

      const proposalId = `prop_map_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const proposal: MappingProposal = {
        confidence: candidateRecords.length > 0 ? 0.95 : 0,
        createdAt: Date.now(),
        createdBy: options.author,
        definitionDigest: options.definitionDigest,
        openQuestions,
        proposalId,
        records: candidateRecords,
        sources: options.sourceIds,
        status: "draft",
      };

      this.mappingProposals.set(proposalId, proposal);
      return proposal;
    });
  }

  /**
   * Admitting a mapping proposal writes candidate records to the canonical Object Store (S03).
   * Raw evidence CANNOT mutate the store directly without this approved proposal.
   */
  admitProposal(
    proposalId: string,
    _author: Subject
  ): Effect.Effect<
    MappingProposal,
    UnknownSourceError | ConcurrentModificationError
  > {
    return Effect.gen({ self: this }, function* () {
      const proposal = this.mappingProposals.get(proposalId);
      if (!proposal) {
        return yield* Effect.fail(
          new UnknownSourceError({ sourceId: proposalId })
        );
      }

      const now = Date.now();
      for (const record of proposal.records) {
        yield* this.store.putObject({
          id: record.rawRecordId,
          lastModifiedAt: now,
          properties: record.properties,
          typeId: record.targetObjectTypeId,
          version: 1,
        });
      }

      const approved: MappingProposal = {
        ...proposal,
        status: "approved",
      };
      this.mappingProposals.set(proposalId, approved);
      return approved;
    });
  }

  getProposal(
    proposalId: string
  ): Effect.Effect<MappingProposal, UnknownSourceError> {
    return Effect.gen({ self: this }, function* () {
      const p = this.mappingProposals.get(proposalId);
      if (!p) {
        return yield* Effect.fail(
          new UnknownSourceError({ sourceId: proposalId })
        );
      }
      return p;
    });
  }

  exportSnapshot(): {
    readonly sources: readonly SourceArtifact[];
    readonly idempotency: readonly {
      readonly key: string;
      readonly sourceId: string;
      readonly digest: string;
      readonly receipt: IngestionReceipt;
    }[];
    readonly proposals: readonly MappingProposal[];
  } {
    return {
      idempotency: [...this.idempotencyRegistry.entries()].map(
        ([key, val]) => ({
          digest: val.digest,
          key,
          receipt: val.receipt,
          sourceId: val.sourceId,
        })
      ),
      proposals: [...this.mappingProposals.values()],
      sources: [...this.sourceInventory.values()],
    };
  }

  importSnapshot(snapshot: {
    readonly sources?: readonly SourceArtifact[];
    readonly idempotency?: readonly {
      readonly key: string;
      readonly sourceId: string;
      readonly digest: string;
      readonly receipt: IngestionReceipt;
    }[];
    readonly proposals?: readonly MappingProposal[];
  }): void {
    if (snapshot.sources) {
      for (const s of snapshot.sources) {
        this.sourceInventory.set(s.sourceId, s);
      }
    }
    if (snapshot.idempotency) {
      for (const i of snapshot.idempotency) {
        this.idempotencyRegistry.set(i.key, {
          digest: i.digest,
          receipt: i.receipt,
          sourceId: i.sourceId,
        });
      }
    }
    if (snapshot.proposals) {
      for (const p of snapshot.proposals) {
        this.mappingProposals.set(p.proposalId, p);
      }
    }
  }
}
