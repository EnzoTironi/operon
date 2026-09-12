import type {
  AdmissionGrade,
  ApprovalsPolicy,
  BatchAdmission,
  CandidateRecord,
  CandidateReviewStage,
  ConflictResolutionPolicy,
  FieldProvenance,
  FunnelPipelineConfig,
  IngestionReceipt,
  MappingFieldRule,
  MappingProposal,
  MappingProposalFilter,
  ObjectAdmission,
  ObjectInstance,
  ObjectProperties,
  ObjectTypeId,
  PropertyMapping,
  ProposalReview,
  QuarantineSearchHit,
  SensitivityLevel,
  SourceArtifact,
  Subject,
} from "@operon/schema";
import {
  ActionLogTypeId,
  computeMappingProposalDigest,
  computeSourceDigest,
  generatePrefixedId,
  parseJson,
  serializeJson,
} from "@operon/schema";
import type { Schema } from "effect";
import { Clock, Data, Effect, Option } from "effect";

import type { ConcurrentModificationError } from "./errors.js";
import {
  IdempotencyConflictError,
  SelfReviewDeniedError,
  StaleReviewError,
} from "./errors.js";
import {
  ContradictoryInputError,
  CorruptInputError,
  HumanReviewRequiredError,
  MappingProposalNotFoundError,
  UnknownSourceError,
} from "./ingestion-errors.js";
import type { ObjectStore } from "./object-store.js";
import type { ApprovalsPolicyViolationError } from "./oms.js";
import { defaultApprovalsPolicy, validateProposalApprovals } from "./oms.js";

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
  readonly propertyMappings: readonly MappingFieldRule[];
  readonly author: Subject;
  readonly tenantId?: string;
}

export interface ReviewMappingProposalOptions {
  readonly proposalId: string;
  readonly review: ProposalReview;
  /** Digest the reviewer saw. Must equal the proposal digest (TOCTOU guard). */
  readonly viewedDigest: string;
  readonly policy?: ApprovalsPolicy;
}

export interface QuarantineSearchFilter {
  readonly text?: string;
  readonly grade?: Extract<AdmissionGrade, "quarantine" | "candidate">;
  readonly targetObjectTypeId?: ObjectTypeId;
  readonly tenantId?: string;
}

function candidateReviewStage(
  proposal: MappingProposal
): Option.Option<CandidateReviewStage> {
  switch (proposal.status) {
    case "open":
    case "under_review":
    case "approved": {
      return Option.some(proposal.status);
    }
    case "draft":
    case "rejected":
    case "merged": {
      return Option.none();
    }
    default: {
      const exhaustive: never = proposal.status;
      return exhaustive;
    }
  }
}

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

function matchesText(value: unknown, text: string | undefined): boolean {
  if (text === undefined || text === "") {
    return true;
  }
  return serializeJson(value).toLowerCase().includes(text.toLowerCase());
}

function quarantineHits(
  sources: readonly SourceArtifact[],
  filter: QuarantineSearchFilter
): QuarantineSearchHit[] {
  const hits: QuarantineSearchHit[] = [];
  for (const src of sources) {
    const items = extractPayloadItems(src.rawPayload);
    for (const [itemIndex, item] of items.entries()) {
      if (matchesText(item, filter.text)) {
        hits.push({
          admission: {
            batchId: src.batchId,
            grade: "quarantine",
            itemIndex,
            locator: src.locator,
            receivedAt: src.receivedAt,
            sourceId: src.sourceId,
          },
          item,
        });
      }
    }
  }
  return hits;
}

function candidateHits(
  proposals: readonly MappingProposal[],
  filter: QuarantineSearchFilter
): QuarantineSearchHit[] {
  const hits: QuarantineSearchHit[] = [];
  for (const proposal of proposals) {
    const stage = candidateReviewStage(proposal);
    if (Option.isNone(stage)) {
      continue;
    }
    if (
      filter.targetObjectTypeId !== undefined &&
      proposal.targetObjectTypeId !== filter.targetObjectTypeId
    ) {
      continue;
    }
    for (const record of proposal.records) {
      if (matchesText(record.properties, filter.text)) {
        hits.push({
          admission: {
            confidence: record.confidence,
            grade: "candidate",
            mappingProposalId: proposal.proposalId,
            proposalDigest: proposal.digest,
            rawRecordId: record.rawRecordId,
            reviewStage: stage.value,
            targetObjectTypeId: record.targetObjectTypeId,
          },
          record,
        });
      }
    }
  }
  return hits;
}

function objectAdmissionKey(typeId: ObjectTypeId, objectId: string): string {
  return `${typeId}/${objectId}`;
}

function decisionAdmissionOf(
  actionLogs: readonly ObjectInstance[],
  typeId: ObjectTypeId,
  objectId: string
): Option.Option<ObjectAdmission> {
  const log = actionLogs.find(
    (candidate) =>
      candidate.properties.status === "executed" &&
      candidate.properties.targetObjectTypeId === typeId &&
      candidate.properties.targetObjectId === objectId
  );
  if (!log) {
    return Option.none();
  }
  return Option.some({
    decisionRecordId: String(log.properties.decisionRecordId),
    grade: "decision",
    objectId,
    recordHash: String(log.properties.recordHash),
    typeId,
  });
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
 * 6. Candidate records reach `main` only through a mapping proposal whose digest
 *    a human reviewer approved (batch admission). Agents propose and merge; they never approve.
 */
function mapItemProperties(
  item: Record<string, Schema.Json>,
  mappings: readonly MappingFieldRule[],
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

export interface AccountableIngestionSnapshot {
  readonly sources: readonly SourceArtifact[];
  readonly idempotency: readonly {
    readonly key: string;
    readonly sourceId: string;
    readonly digest: string;
    readonly receipt: IngestionReceipt;
  }[];
  readonly proposals: readonly MappingProposal[];
  readonly admissions: readonly BatchAdmission[];
}

/**
 * Share of field rules that resolved on this item. A deterministic copy of
 * every requested field is full confidence; missing fields lower it.
 */
function mappingConfidence(
  rules: readonly MappingFieldRule[],
  mappedProps: Record<string, Schema.Json>
): number {
  if (rules.length === 0) {
    return 1;
  }
  return Object.keys(mappedProps).length / rules.length;
}

function proposalConfidence(records: readonly CandidateRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  return Math.min(...records.map((r) => r.confidence));
}

function nextReviewStatus(
  reviews: readonly ProposalReview[],
  policy: ApprovalsPolicy
): MappingProposal["status"] {
  if (reviews.some((r) => r.verdict === "reject")) {
    return "rejected";
  }
  const approvals = reviews.filter((r) => r.verdict === "approve").length;
  return approvals >= policy.requiredMinApprovals ? "approved" : "under_review";
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
  private readonly batchAdmissions = new Map<string, BatchAdmission>();

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
          Effect.fn("AccountableIngestionService.processItem")(
            function* (item) {
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
                confidence: mappingConfidence(
                  options.propertyMappings,
                  mappedProps
                ),
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
          ),
          { concurrency: 1 }
        );
      }),
      { concurrency: 1 }
    );

    const now = yield* Clock.currentTimeMillis;
    const proposalId = generatePrefixedId("prop_map", now);

    const filter: MappingProposalFilter = {
      definitionDigest: options.definitionDigest,
      openQuestions,
      primaryKeyField: options.primaryKeyField,
      propertyMappings: options.propertyMappings,
      records: candidateRecords,
      sources: options.sourceIds,
      targetObjectTypeId: options.targetObjectTypeId,
    };

    const proposal: MappingProposal = {
      ...filter,
      confidence: proposalConfidence(candidateRecords),
      createdAt: now,
      createdBy: options.author,
      digest: computeMappingProposalDigest(filter),
      proposalId,
      reviews: [],
      status: "open",
    };

    this.mappingProposals.set(proposalId, proposal);
    return proposal;
  });

  /**
   * A human reviews the batch digest. Authors cannot review their own batch,
   * agents cannot review at all, and the reviewed digest must be the current one.
   */
  readonly reviewProposal = Effect.fn(
    "AccountableIngestionService.reviewProposal"
  )(function* (
    this: AccountableIngestionService,
    options: ReviewMappingProposalOptions
  ): Effect.fn.Return<
    MappingProposal,
    | MappingProposalNotFoundError
    | HumanReviewRequiredError
    | SelfReviewDeniedError
    | StaleReviewError
  > {
    const { proposalId, review } = options;
    const proposal = this.mappingProposals.get(proposalId);
    if (!proposal) {
      return yield* new MappingProposalNotFoundError({ proposalId });
    }
    if (review.reviewer.type !== "user") {
      return yield* new HumanReviewRequiredError({
        proposalId,
        reviewerId: review.reviewer.id,
        reviewerType: review.reviewer.type,
      });
    }
    if (review.reviewer.id === proposal.createdBy.id) {
      return yield* new SelfReviewDeniedError({
        authorId: proposal.createdBy.id,
        message: `Author '${proposal.createdBy.id}' cannot review own batch admission '${proposalId}'`,
        reviewerId: review.reviewer.id,
      });
    }
    if (options.viewedDigest !== proposal.digest) {
      return yield* new StaleReviewError({
        candidateDigest: proposal.digest,
        message: `Review references digest '${options.viewedDigest}', current batch digest is '${proposal.digest}'`,
        proposalId,
        reviewDigest: options.viewedDigest,
      });
    }

    const policy = options.policy ?? defaultApprovalsPolicy;
    const reviews = [...proposal.reviews, review];
    const reviewed: MappingProposal = {
      ...proposal,
      reviews,
      status: nextReviewStatus(reviews, policy),
    };
    this.mappingProposals.set(proposalId, reviewed);
    return reviewed;
  });

  /**
   * Merging an approved batch writes every candidate record to `main` at
   * grade `batch` (S03). Raw evidence cannot reach the store any other way.
   * Merging an already merged batch is a no-op replay.
   */
  readonly admitProposal = Effect.fn(
    "AccountableIngestionService.admitProposal"
  )(function* (
    this: AccountableIngestionService,
    proposalId: string,
    admitter: Subject,
    policy: ApprovalsPolicy = defaultApprovalsPolicy
  ): Effect.fn.Return<
    MappingProposal,
    | MappingProposalNotFoundError
    | ApprovalsPolicyViolationError
    | ConcurrentModificationError
  > {
    const proposal = this.mappingProposals.get(proposalId);
    if (!proposal) {
      return yield* new MappingProposalNotFoundError({ proposalId });
    }
    if (proposal.status === "merged") {
      return proposal;
    }

    yield* validateProposalApprovals(
      {
        id: proposal.proposalId,
        reviews: proposal.reviews,
        status: proposal.status,
      },
      policy
    );

    const now = yield* Clock.currentTimeMillis;
    const { batchAdmissions, store } = this;
    yield* Effect.forEach(
      proposal.records,
      Effect.fn("AccountableIngestionService.admitRecord")(function* (record) {
        yield* store.putObject({
          id: record.rawRecordId,
          lastModifiedAt: now,
          properties: record.properties,
          typeId: record.targetObjectTypeId,
          version: 1,
        });
        const admission: BatchAdmission = {
          admittedAt: now,
          admittedBy: admitter,
          grade: "batch",
          mappingProposalId: proposal.proposalId,
          objectId: record.rawRecordId,
          proposalDigest: proposal.digest,
          typeId: record.targetObjectTypeId,
        };
        batchAdmissions.set(
          objectAdmissionKey(record.targetObjectTypeId, record.rawRecordId),
          admission
        );
      }),
      { concurrency: 1 }
    );

    const merged: MappingProposal = {
      ...proposal,
      status: "merged",
    };
    this.mappingProposals.set(proposalId, merged);
    return merged;
  });

  readonly getProposal = Effect.fn("AccountableIngestionService.getProposal")(
    function* (
      this: AccountableIngestionService,
      proposalId: string
    ): Effect.fn.Return<MappingProposal, MappingProposalNotFoundError> {
      const p = this.mappingProposals.get(proposalId);
      if (!p) {
        return yield* new MappingProposalNotFoundError({ proposalId });
      }
      return p;
    }
  );

  listProposals(tenantId?: string): Effect.Effect<readonly MappingProposal[]> {
    return Effect.map(this.listSources(tenantId), (sources) => {
      const visibleSources = new Set(sources.map((s) => s.sourceId));
      return [...this.mappingProposals.values()].filter((p) =>
        p.sources.every((sourceId) => visibleSources.has(sourceId))
      );
    });
  }

  /**
   * Search quarantine (raw payload items) and candidates (typed records of
   * open batches) without either becoming an ObjectInstance.
   */
  readonly searchQuarantine = Effect.fn(
    "AccountableIngestionService.searchQuarantine"
  )(function* (
    this: AccountableIngestionService,
    filter: QuarantineSearchFilter
  ): Effect.fn.Return<readonly QuarantineSearchHit[], never> {
    const sources = yield* this.listSources(filter.tenantId);
    const proposals = yield* this.listProposals(filter.tenantId);
    switch (filter.grade) {
      case "quarantine": {
        return quarantineHits(sources, filter);
      }
      case "candidate": {
        return candidateHits(proposals, filter);
      }
      case undefined: {
        return [
          ...quarantineHits(sources, filter),
          ...candidateHits(proposals, filter),
        ];
      }
      default: {
        const exhaustive: never = filter.grade;
        return exhaustive;
      }
    }
  });

  /**
   * Admission state of an object in `main`. An executed Action (ActionLog with
   * this target) makes it decision-bearing; a merged batch makes it `batch`.
   * Objects that reached the store any other way have no recorded admission.
   */
  admissionOf(
    typeId: ObjectTypeId,
    objectId: string
  ): Effect.Effect<Option.Option<ObjectAdmission>> {
    return Effect.map(
      // SAFETY: ActionLogTypeId is the fixed ObjectTypeId the write pipeline materializes
      this.store.findObjects(ActionLogTypeId as ObjectTypeId),
      (actionLogs) =>
        Option.orElse(decisionAdmissionOf(actionLogs, typeId, objectId), () =>
          Option.fromNullishOr(
            this.batchAdmissions.get(objectAdmissionKey(typeId, objectId))
          )
        )
    );
  }

  exportSnapshot(): AccountableIngestionSnapshot {
    return {
      admissions: [...this.batchAdmissions.values()],
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

  importSnapshot(snapshot: Partial<AccountableIngestionSnapshot>): void {
    if (snapshot.admissions) {
      for (const a of snapshot.admissions) {
        this.batchAdmissions.set(objectAdmissionKey(a.typeId, a.objectId), a);
      }
    }
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
