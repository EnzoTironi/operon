import type {
  CandidateRecord,
  ConflictResolutionPolicy,
  FieldProvenance,
  FunnelPipelineConfig,
  IngestionReceipt,
  MappingProposal,
  ObjectInstance,
  ObjectProperties,
  ObjectTypeId,
  PropertyMapping,
  SensitivityLevel,
  SourceArtifact,
  Subject,
} from "@operon/schema";
import {
  computeSourceDigest,
  generatePrefixedId,
  parseJson,
} from "@operon/schema";
import type { Schema } from "effect";
import { Clock, Data, Effect } from "effect";

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

function extractRecordProperties(
  record: Record<string, Schema.Json>,
  propertyMappings: readonly PropertyMapping[]
): ObjectProperties {
  const mappedProperties: ObjectProperties = {};
  for (const mapping of propertyMappings) {
    const rawVal = record[mapping.sourceField];
    if (rawVal !== undefined) {
      const val = mapping.transform ? mapping.transform(rawVal) : rawVal;
      if (val !== undefined) {
        mappedProperties[mapping.targetPropertyName] = val;
      }
    }
  }
  return mappedProperties;
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
  readonly ingestBatch = Effect.fn("FunnelService.ingestBatch")(function* (
    this: FunnelService,
    pipelineId: string,
    rawRecords: readonly Record<string, Schema.Json>[]
  ): Effect.fn.Return<
    IngestionResult,
    PipelineNotFoundError | FunnelIngestionError
  > {
    const pipeline = yield* this.getPipeline(pipelineId);
    const now = yield* Clock.currentTimeMillis;

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    const { store } = this;
    const resolveConflict = (
      policy: ConflictResolutionPolicy,
      existing: ObjectInstance,
      record: Record<string, Schema.Json>
    ) => this.resolveConflict(policy, existing, record);

    yield* Effect.forEach(
      rawRecords,
      Effect.fn("FunnelService.ingestRecord")(function* (record) {
        const rawId = record[pipeline.primaryKeyField];
          if (rawId === undefined || rawId === null) {
            skippedCount++;
            return;
          }
          const id = String(rawId);
          const mappedProperties = extractRecordProperties(
            record,
            pipeline.propertyMappings
          );

          const existing = yield* store.getObject(
            pipeline.targetObjectTypeId as ObjectTypeId,
            id
          );

          if (!existing) {
            const newInstance: ObjectInstance = {
              id,
              lastModifiedAt: now,
              properties: mappedProperties,
              typeId: pipeline.targetObjectTypeId as ObjectTypeId,
              version: 1,
            };
            yield* store.putObject(newInstance).pipe(
              Effect.mapError(
                (err) =>
                  new FunnelIngestionError({
                    message: `Failed to insert object: ${err.message}`,
                    pipelineId,
                  })
              )
            );
            createdCount++;
            return;
          }

          const shouldUpdate = resolveConflict(
            pipeline.conflictPolicy,
            existing,
            record
          );

          if (shouldUpdate) {
            const updatedInstance: ObjectInstance = {
              ...existing,
              lastModifiedAt: now,
              properties: {
                ...existing.properties,
                ...mappedProperties,
              },
              version: existing.version + 1,
            };
            yield* store.putObject(updatedInstance).pipe(
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
        }),
      { concurrency: 1 }
    );

    return {
      createdCount,
      processedCount: rawRecords.length,
      skippedCount,
      updatedCount,
    };
  });

  /**
   * Ingest a single streaming event
   */
  readonly ingestStreamRecord = Effect.fn("FunnelService.ingestStreamRecord")(
    function* (
      this: FunnelService,
      pipelineId: string,
      record: Record<string, Schema.Json>
    ): Effect.fn.Return<
      ObjectInstance,
      PipelineNotFoundError | FunnelIngestionError
    > {
      yield* this.ingestBatch(pipelineId, [record]);
      const pipeline = yield* this.getPipeline(pipelineId);
      const rawId = record[pipeline.primaryKeyField];
      const obj = yield* this.store.getObject(
        pipeline.targetObjectTypeId as ObjectTypeId,
        String(rawId)
      );
      if (!obj) {
        return yield* new FunnelIngestionError({
          message: "Stream record could not be read after write",
          pipelineId,
        });
      }
      return obj;
    }
  );

  private resolveConflict(
    policy: ConflictResolutionPolicy,
    existing: ObjectInstance,
    sourceRecord: Record<string, Schema.Json>
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
  readonly rawPayload: Schema.Json;
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
function extractPayloadItems(
  payload: unknown
): readonly Record<string, Schema.Json>[] {
  if (Array.isArray(payload)) {
    // SAFETY: payload array items are JSON records in this pipeline
    return payload as readonly Record<string, Schema.Json>[];
  }
  if (typeof payload === "object" && payload !== null) {
    // SAFETY: payload is verified to be a non-null JSON object at runtime
    return [payload as Record<string, Schema.Json>];
  }
  return [];
}

function mapItemProperties(
  item: Record<string, Schema.Json>,
  mappings: readonly PropertyMapping[],
  src: SourceArtifact
): {
  mappedProps: Record<string, Schema.Json>;
  fieldProvenances: Record<string, FieldProvenance>;
} {
  const mappedProps: Record<string, Schema.Json> = {};
  const fieldProvenances: Record<string, FieldProvenance> = {};
  for (const rule of mappings) {
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
  return { mappedProps, fieldProvenances };
}

function checkConflictingProperties(
  prev: CandidateRecord,
  mappedProps: Record<string, Schema.Json>,
  pkStr: string
): Effect.Effect<void, ContradictoryInputError> {
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
    return Effect.fail(
      new ContradictoryInputError({
        conflictingProperties: conflictingProps,
        reason: `Contradictory values for record '${pkStr}': properties [${conflictingProps.join(
          ", "
        )}] conflict across sources`,
        recordId: pkStr,
      })
    );
  }
  return Effect.void;
}

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
  readonly ingestRawSource = Effect.fn(
    "AccountableIngestionService.ingestRawSource"
  )(function* (
    this: AccountableIngestionService,
    options: IngestRawSourceOptions
  ): Effect.fn.Return<
    IngestionReceipt,
    IdempotencyConflictError | CorruptInputError
  > {
    let payload = options.rawPayload;

    // 1. Validate payload
    if (
      payload === undefined ||
      payload === null ||
      (typeof payload === "string" && payload.trim() === "")
    ) {
      return yield* new CorruptInputError({
        locator: options.locator,
        reason: "Raw payload is empty, undefined, or null",
      });
    }

    // If string and mediaType is JSON, parse it to ensure valid structure
    if (options.mediaType.includes("json") && typeof payload === "string") {
      payload = yield* Effect.try({
        catch: (cause: unknown) =>
          new CorruptInputError({
            locator: options.locator,
            reason: `Corrupt JSON payload: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        // SAFETY: Parsing verified JSON string produces Schema.Json
        try: () => parseJson(payload as string) as Schema.Json,
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
        return yield* new IdempotencyConflictError({
          idempotencyKey: options.idempotencyKey,
          message: `Idempotency conflict for key '${options.idempotencyKey}': existing digest '${existing.digest}', new digest '${digest}'`,
        });
      }
    }

    // 4. Create SourceArtifact
    const now = yield* Clock.currentTimeMillis;
    const sourceId = generatePrefixedId("src", now);
    const batchId = generatePrefixedId("batch", now);

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

  /**
   * Retrieve a source artifact with non-disclosure of existence on tenant mismatch.
   */
  readonly getSource = Effect.fn("AccountableIngestionService.getSource")(
    function* (
      this: AccountableIngestionService,
      sourceId: string,
      tenantId?: string
    ): Effect.fn.Return<SourceArtifact, UnknownSourceError> {
      const src = this.sourceInventory.get(sourceId);
      if (!src) {
        return yield* new UnknownSourceError({ sourceId });
      }
      // Non-disclosure invariant: mismatching tenant returns identical error as not found
      if (tenantId && src.tenantId && src.tenantId !== tenantId) {
        return yield* new UnknownSourceError({ sourceId });
      }
      return src;
    }
  );

  /**
   * List source artifacts, optionally scoped to a tenant.
   */
  listSources(tenantId?: string): Effect.Effect<readonly SourceArtifact[]> {
    return Effect.sync(() => {
      const all = [...this.sourceInventory.values()];
      if (!tenantId) {
        return all;
      }
      return all.filter((s) => !s.tenantId || s.tenantId === tenantId);
    });
  }

  /**
   * Propose a mapping from raw sources to candidate records with full provenance tracking (S15).
   */
  readonly proposeMapping = Effect.fn(
    "AccountableIngestionService.proposeMapping"
  )(function* (
    this: AccountableIngestionService,
    options: ProposeMappingOptions
  ): Effect.fn.Return<
    MappingProposal,
    UnknownSourceError | ContradictoryInputError
  > {
    const sources = yield* Effect.forEach(
      options.sourceIds,
      (srcId) => this.getSource(srcId, options.tenantId),
      { concurrency: 1 }
    );

    const candidateRecords: CandidateRecord[] = [];
    const seenRecordsById = new Map<string, CandidateRecord>();
    const openQuestions: string[] = [];

    yield* Effect.forEach(
      sources,
      Effect.fn("AccountableIngestionService.processSource")(function* (src) {
        const items = extractPayloadItems(src.rawPayload);

        yield* Effect.forEach(
          items,
          Effect.fn("AccountableIngestionService.processItem")(function* (
            item
          ) {
            const rawPk = item[options.primaryKeyField];
            if (rawPk === undefined || rawPk === null) {
              openQuestions.push(
                `Record in source '${src.sourceId}' missing primary key field '${options.primaryKeyField}'`
              );
              return;
            }
            const pkStr = String(rawPk);
            const { mappedProps, fieldProvenances } = mapItemProperties(
              item,
              options.propertyMappings,
              src
            );

            const prev = seenRecordsById.get(pkStr);
            if (prev) {
              yield* checkConflictingProperties(prev, mappedProps, pkStr);
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
          }),
          { concurrency: 1 }
        );
      }),
      { concurrency: 1 }
    );

    const now = yield* Clock.currentTimeMillis;
    const proposalId = generatePrefixedId("prop_map", now);

    const proposal: MappingProposal = {
      confidence: candidateRecords.length > 0 ? 0.95 : 0,
      createdAt: now,
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

  /**
   * Admitting a mapping proposal writes candidate records to the canonical Object Store (S03).
   * Raw evidence CANNOT mutate the store directly without this approved proposal.
   */
  readonly admitProposal = Effect.fn(
    "AccountableIngestionService.admitProposal"
  )(function* (
    this: AccountableIngestionService,
    proposalId: string,
    _author: Subject
  ): Effect.fn.Return<
    MappingProposal,
    UnknownSourceError | ConcurrentModificationError
  > {
    const proposal = this.mappingProposals.get(proposalId);
    if (!proposal) {
      return yield* new UnknownSourceError({ sourceId: proposalId });
    }

    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      proposal.records,
      (record) =>
        this.store.putObject({
          id: record.rawRecordId,
          lastModifiedAt: now,
          properties: record.properties,
          typeId: record.targetObjectTypeId,
          version: 1,
        }),
      { concurrency: 1 }
    );

    const approved: MappingProposal = {
      ...proposal,
      status: "approved",
    };
    this.mappingProposals.set(proposalId, approved);
    return approved;
  });

  readonly getProposal = Effect.fn("AccountableIngestionService.getProposal")(
    function* (
      this: AccountableIngestionService,
      proposalId: string
    ): Effect.fn.Return<MappingProposal, UnknownSourceError> {
      const p = this.mappingProposals.get(proposalId);
      if (!p) {
        return yield* new UnknownSourceError({ sourceId: proposalId });
      }
      return p;
    }
  );

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
