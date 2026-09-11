import { Schema } from "effect";

import { computeCanonicalDigest } from "./definition.js";
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
 * MappingProposal (V0-CH-05)
 * Accountable mapping from raw sources to candidate records.
 */
export const MappingProposal = Schema.Struct({
  proposalId: Schema.String,
  definitionDigest: Schema.String,
  sources: Schema.Array(Schema.String),
  records: Schema.Array(CandidateRecord),
  openQuestions: Schema.Array(Schema.String),
  confidence: Schema.Number,
  status: Schema.Literals(["draft", "submitted", "approved", "rejected"]),
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
