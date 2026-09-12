import { Schema } from "effect";

import { computeCanonicalDigest } from "./definition.js";
import { ProposalReview, ProposalStatus } from "./proposals.js";
import { Subject } from "./security.js";
import { DataClassification, ObjectTypeId } from "./types.js";

export const SensitivityLevel = DataClassification;
export type SensitivityLevel = typeof SensitivityLevel.Type;

/**
 * SourceArtifact (S03, S15, Chapter 15 & 16)
 * Raw evidence artifact cataloged before mapping or admission.
 */
export const SourceArtifact = Schema.Struct({
  sourceId: Schema.String,
  digest: Schema.String,
  mediaType: Schema.String,
  permittedUses: Schema.Array(Schema.String),
  sensitivity: SensitivityLevel,
  locator: Schema.String,
  receivedAt: Schema.Number,
  batchId: Schema.String,
  tenantId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(Schema.String),
  rawPayload: Schema.Json,
});
export type SourceArtifact = typeof SourceArtifact.Type;
export const SourceArtifactSchema = SourceArtifact;

/**
 * Provenance pointer linking every accepted field back to raw evidence.
 */
export const FieldProvenanceSchema = Schema.Struct({
  batchId: Schema.String,
  digest: Schema.String,
  fieldPath: Schema.String,
  locator: Schema.String,
  sourceId: Schema.String,
});
export type FieldProvenance = typeof FieldProvenanceSchema.Type;

/**
 * CandidateRecord produced by mapping proposal.
 */
export const CandidateRecordProvenance = Schema.Struct({
  sourceId: Schema.String,
  locator: Schema.String,
  batchId: Schema.String,
  digest: Schema.String,
  fieldProvenances: Schema.Record(Schema.String, FieldProvenanceSchema),
});

export const CandidateRecord = Schema.Struct({
  rawRecordId: Schema.String,
  targetObjectTypeId: ObjectTypeId,
  properties: Schema.Record(Schema.String, Schema.Json),
  confidence: Schema.Number,
  provenance: CandidateRecordProvenance,
});
export type CandidateRecord = typeof CandidateRecord.Type;
export const CandidateRecordSchema = CandidateRecord;

/**
 * One field rule of a mapping: copy `sourceField` from the raw item into
 * `targetPropertyName` of the candidate record.
 */
export const MappingFieldRule = Schema.Struct({
  sourceField: Schema.String,
  targetPropertyName: Schema.String,
});
export type MappingFieldRule = typeof MappingFieldRule.Type;

/**
 * The filter a mapping proposal admits. Its canonical digest is what a human
 * approves: sources, definition, target type, key field, field rules and the
 * resulting candidate records. One digest covers the whole batch.
 */
export const MappingProposalFilter = Schema.Struct({
  definitionDigest: Schema.String,
  sources: Schema.Array(Schema.String),
  targetObjectTypeId: ObjectTypeId,
  primaryKeyField: Schema.String,
  propertyMappings: Schema.Array(MappingFieldRule),
  records: Schema.Array(CandidateRecord),
  openQuestions: Schema.Array(Schema.String),
});
export type MappingProposalFilter = typeof MappingProposalFilter.Type;

export function computeMappingProposalDigest(
  filter: MappingProposalFilter
): string {
  return computeCanonicalDigest(filter);
}

/**
 * MappingProposal (V0-CH-05)
 * Accountable mapping from raw sources to candidate records. It is also the
 * batch admission proposal: it opens for review, a human approves its digest,
 * and merging writes every candidate record to `main` at grade `batch`.
 */
export const MappingProposal = Schema.Struct({
  ...MappingProposalFilter.fields,
  proposalId: Schema.String,
  digest: Schema.String,
  confidence: Schema.Number,
  status: ProposalStatus,
  reviews: Schema.Array(ProposalReview),
  createdAt: Schema.Number,
  createdBy: Subject,
});
export type MappingProposal = typeof MappingProposal.Type;
export const MappingProposalSchema = MappingProposal;

/**
 * IngestionReceipt returned upon successful accountable ingestion.
 */
export const IngestionReceipt = Schema.Struct({
  batchId: Schema.String,
  sourceArtifact: SourceArtifact,
  status: Schema.Literals(["ingested", "replayed"]),
  idempotencyKey: Schema.optionalKey(Schema.String),
  timestamp: Schema.Number,
});
export type IngestionReceipt = typeof IngestionReceipt.Type;
export const IngestionReceiptSchema = IngestionReceipt;

export type SourcePayload = Schema.Json;

export function computeSourceDigest(payload: SourcePayload): string {
  return computeCanonicalDigest(payload);
}
