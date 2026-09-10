import { Schema } from "effect";

/**
 * F1 Evaluation Outcome (S17 / V0-CH-10)
 */
export const F1Outcome = Schema.Literals(["PASS", "FAIL", "INCONCLUSIVE"]);
export type F1Outcome = Schema.Schema.Type<typeof F1Outcome>;

/**
 * F1 Test Case Record (S17 / V0-CH-10)
 */
export const F1TestCase = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: F1Outcome,
  assertions: Schema.Int,
  executionTimeMs: Schema.Number,
  errorMessage: Schema.optional(Schema.String),
});
export type F1TestCase = Schema.Schema.Type<typeof F1TestCase>;

/**
 * PublicF1Receipt (V0-CH-10 / S17):
 * Candidate-bound, Ed25519-signed public receipt.
 */
export const PublicF1Receipt = Schema.Struct({
  candidateDigest: Schema.String,
  profileDigest: Schema.String,
  catalogDigest: Schema.String,
  outcome: F1Outcome,
  caseCount: Schema.Int,
  assertionsCount: Schema.Int,
  evaluatedAt: Schema.Int,
  signature: Schema.String,
  signerPublicKey: Schema.String,
});
export type PublicF1Receipt = Schema.Schema.Type<typeof PublicF1Receipt>;

/**
 * ConsentScope (V0-CH-11 / S17):
 * Legally binding consent and source scope for real-company mirror.
 */
export const ConsentScope = Schema.Struct({
  consentGrantId: Schema.String,
  participantId: Schema.String,
  dataScope: Schema.Array(Schema.String),
  purpose: Schema.String,
  expiresAt: Schema.Int,
  createdAt: Schema.Int,
});
export type ConsentScope = Schema.Schema.Type<typeof ConsentScope>;

/**
 * TraceableCorrection (V0-CH-11 / S17):
 * Traceable human/system correction record during mirror evaluation.
 */
export const TraceableCorrection = Schema.Struct({
  correctionId: Schema.String,
  observedTarget: Schema.String,
  priorValue: Schema.Unknown,
  correctedValue: Schema.Unknown,
  correctedBy: Schema.String,
  correctedAt: Schema.Int,
  reason: Schema.String,
});
export type TraceableCorrection = Schema.Schema.Type<
  typeof TraceableCorrection
>;

/**
 * F2 Claim (V0-CH-11)
 */
export const F2Claim = Schema.Literals([
  "model-and-query-only",
  "observed-action",
]);
export type F2Claim = Schema.Schema.Type<typeof F2Claim>;

/**
 * F2Receipt (V0-CH-11 / S17):
 * Consented real-company mirror evaluation receipt.
 */
export const F2Receipt = Schema.Struct({
  candidateDigest: Schema.String,
  profileDigest: Schema.String,
  rubricDigest: Schema.String,
  companyEvidenceRef: Schema.String,
  correctionRefs: Schema.Array(Schema.String),
  claim: F2Claim,
  participantId: Schema.String,
  consentScope: ConsentScope,
  evaluatedAt: Schema.Int,
  signature: Schema.String,
  signerPublicKey: Schema.String,
});
export type F2Receipt = Schema.Schema.Type<typeof F2Receipt>;

/**
 * Artifact Classification (V0-CH-12 / S11 / S17)
 */
export const ArtifactClassification = Schema.Literals(["PUBLIC", "PROTECTED"]);
export type ArtifactClassification = Schema.Schema.Type<
  typeof ArtifactClassification
>;

/**
 * Publication Violation (V0-CH-12)
 */
export const PublicationViolation = Schema.Struct({
  path: Schema.String,
  classification: Schema.Literal("PROTECTED"),
  rule: Schema.String,
  matchedDigest: Schema.optional(Schema.String),
  details: Schema.String,
});
export type PublicationViolation = Schema.Schema.Type<
  typeof PublicationViolation
>;

/**
 * PublicationScanResult (V0-CH-12)
 */
export const PublicationScanResult = Schema.Struct({
  isClean: Schema.Boolean,
  scannedPaths: Schema.Array(Schema.String),
  violations: Schema.Array(PublicationViolation),
  scannedAt: Schema.Int,
});
export type PublicationScanResult = Schema.Schema.Type<
  typeof PublicationScanResult
>;
