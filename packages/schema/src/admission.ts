import { Schema } from "effect";

import { CandidateRecord } from "./ingestion.js";
import { Subject } from "./security.js";
import { ObjectTypeId } from "./types.js";

/**
 * Admission grade of ingested material.
 *
 * - quarantine: raw evidence in a SourceArtifact. Navigable, not an object.
 * - candidate: typed record proposed by a mapping. Still not an object.
 * - batch: ObjectInstance written to `main` by a reviewed mapping proposal.
 * - decision: ObjectInstance that an executed Action wrote (DecisionRecord path).
 */
export const AdmissionGrade = Schema.Literals([
  "quarantine",
  "candidate",
  "batch",
  "decision",
]);
export type AdmissionGrade = typeof AdmissionGrade.Type;

export const QuarantineAdmission = Schema.Struct({
  grade: Schema.Literal("quarantine"),
  sourceId: Schema.String,
  batchId: Schema.String,
  locator: Schema.String,
  itemIndex: Schema.Number,
  receivedAt: Schema.Number,
});
export type QuarantineAdmission = typeof QuarantineAdmission.Type;

/**
 * Review stage of the mapping proposal a candidate belongs to.
 * Candidates of merged or rejected proposals are no longer candidates.
 */
export const CandidateReviewStage = Schema.Literals([
  "open",
  "under_review",
  "approved",
]);
export type CandidateReviewStage = typeof CandidateReviewStage.Type;

export const CandidateAdmission = Schema.Struct({
  grade: Schema.Literal("candidate"),
  mappingProposalId: Schema.String,
  proposalDigest: Schema.String,
  reviewStage: CandidateReviewStage,
  rawRecordId: Schema.String,
  targetObjectTypeId: ObjectTypeId,
  confidence: Schema.Number,
});
export type CandidateAdmission = typeof CandidateAdmission.Type;

export const BatchAdmission = Schema.Struct({
  grade: Schema.Literal("batch"),
  typeId: ObjectTypeId,
  objectId: Schema.String,
  mappingProposalId: Schema.String,
  proposalDigest: Schema.String,
  admittedAt: Schema.Number,
  admittedBy: Subject,
});
export type BatchAdmission = typeof BatchAdmission.Type;

export const DecisionAdmission = Schema.Struct({
  grade: Schema.Literal("decision"),
  typeId: ObjectTypeId,
  objectId: Schema.String,
  decisionRecordId: Schema.String,
  recordHash: Schema.String,
});
export type DecisionAdmission = typeof DecisionAdmission.Type;

export const AdmissionState = Schema.Union([
  QuarantineAdmission,
  CandidateAdmission,
  BatchAdmission,
  DecisionAdmission,
]);
export type AdmissionState = typeof AdmissionState.Type;

/**
 * Admission state of an ObjectInstance that lives in `main`.
 */
export const ObjectAdmission = Schema.Union([
  BatchAdmission,
  DecisionAdmission,
]);
export type ObjectAdmission = typeof ObjectAdmission.Type;

/**
 * A hit from a quarantine search. Q hits carry the raw payload item,
 * C hits carry the typed candidate record. Neither is an ObjectInstance.
 */
export const QuarantineSearchHit = Schema.Union([
  Schema.Struct({
    admission: QuarantineAdmission,
    item: Schema.Json,
  }),
  Schema.Struct({
    admission: CandidateAdmission,
    record: CandidateRecord,
  }),
]);
export type QuarantineSearchHit = typeof QuarantineSearchHit.Type;
