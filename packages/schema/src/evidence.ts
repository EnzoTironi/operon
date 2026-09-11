import { Schema } from "effect";

import { BitemporalCoordinates } from "./bitemporal.js";
import { computeCanonicalDigest } from "./definition.js";
import { Subject } from "./security.js";
import { DataClassification, ObjectTypeId } from "./types.js";

/**
 * Claim lifecycle states per S03
 */
export const ClaimState = Schema.Literals([
  "proposed",
  "supported",
  "accepted",
  "contested",
  "superseded",
  "retracted",
  "unknown",
]);
export type ClaimState = Schema.Schema.Type<typeof ClaimState>;

/**
 * Claim: An attributed assertion linking subject/property/value to evidence per S03
 */
export const Claim = Schema.Struct({
  attribution: Subject,
  claimId: Schema.String,
  confidence: Schema.Number,
  conflictReason: Schema.optional(Schema.String),
  effectiveTime: Schema.Number, // Valid time (T_v)
  evidenceDigest: Schema.String,
  propertyName: Schema.String,
  propertyValue: Schema.Json,
  recordedAt: Schema.Number, // Transaction time (T_t)
  sourceSystem: Schema.String,
  state: ClaimState,
  subjectId: Schema.String,
  targetTypeId: ObjectTypeId,
});
export type Claim = Schema.Schema.Type<typeof Claim>;

/**
 * EvidenceClosure: Required dependencies, revisions, and staleness constraints per S03
 */
export const EvidenceClosure = Schema.Struct({
  dependencyPredicate: Schema.optional(Schema.String),
  maxStalenessMs: Schema.Number,
  requiredInputs: Schema.Array(Schema.String),
  sourceRevision: Schema.String,
});
export type EvidenceClosure = Schema.Schema.Type<typeof EvidenceClosure>;

/**
 * CanonicalEvidenceEnvelope: Ingestion container for raw evidence and candidate claims per S03 / V1-02
 */
export const CanonicalEvidenceEnvelope = Schema.Struct({
  author: Subject,
  classification: DataClassification,
  contentDigest: Schema.String,
  effectiveTime: Schema.Number,
  envelopeId: Schema.String,
  evidenceClosure: Schema.optional(EvidenceClosure),
  externalId: Schema.String,
  rawPayload: Schema.Json,
  receivedAt: Schema.Number,
  sourceSystem: Schema.String,
  targetTypeId: ObjectTypeId,
});
export type CanonicalEvidenceEnvelope = Schema.Schema.Type<
  typeof CanonicalEvidenceEnvelope
>;

/**
 * AdmissionReceipt: Produced upon controlled admission of an evidence envelope per S03 / V1-02
 */
export const AdmissionReceipt = Schema.Struct({
  admissionId: Schema.String,
  admittedAt: Schema.Number,
  admittedBy: Subject,
  bitemporal: BitemporalCoordinates,
  claims: Schema.Array(Claim),
  conflictingClaims: Schema.Array(Claim),
  envelopeId: Schema.String,
  receiptDigest: Schema.String,
  status: Schema.Literals(["admitted", "contested", "quarantined"]),
  subjectId: Schema.String,
  targetTypeId: ObjectTypeId,
});
export type AdmissionReceipt = Schema.Schema.Type<typeof AdmissionReceipt>;

/**
 * QueryReceipt: Exact checkable receipt for point-in-time bitemporal queries per S04 / V1-02
 */
export const QueryReceipt = Schema.Struct({
  asOf: Schema.Struct({
    transactionTime: Schema.Number,
    validTime: Schema.Number,
  }),
  count: Schema.Number,
  objects: Schema.Array(Schema.Unknown),
  queriedAt: Schema.Number,
  queryId: Schema.String,
  receiptDigest: Schema.String,
  targetTypeId: ObjectTypeId,
});
export type QueryReceipt = Schema.Schema.Type<typeof QueryReceipt>;

/**
 * Computes canonical SHA-256 digest for an AdmissionReceipt
 */
export function computeAdmissionReceiptDigest(receipt: {
  readonly envelopeId: string;
  readonly subjectId: string;
  readonly targetTypeId: string;
  readonly status: string;
  readonly admittedAt: number;
  readonly claims: readonly unknown[];
  readonly conflictingClaims: readonly unknown[];
}): string {
  return computeCanonicalDigest({
    admittedAt: receipt.admittedAt,
    claims: receipt.claims,
    conflictingClaims: receipt.conflictingClaims,
    envelopeId: receipt.envelopeId,
    status: receipt.status,
    subjectId: receipt.subjectId,
    targetTypeId: receipt.targetTypeId,
  });
}

/**
 * Computes canonical SHA-256 digest for a QueryReceipt
 */
export function computeQueryReceiptDigest(receipt: {
  readonly queryId: string;
  readonly targetTypeId: string;
  readonly asOf: {
    readonly validTime: number;
    readonly transactionTime: number;
  };
  readonly objects: readonly unknown[];
}): string {
  return computeCanonicalDigest({
    asOf: receipt.asOf,
    objects: receipt.objects,
    queryId: receipt.queryId,
    targetTypeId: receipt.targetTypeId,
  });
}
