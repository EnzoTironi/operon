import { Schema } from "effect";

/**
 * Factual assertion to be checked against L2 ground truth and bitemporal evidence (OPR-L2-001)
 */
export const FactualAssertion = Schema.Struct({
  assertionId: Schema.String,
  assertedValue: Schema.Unknown,
  entityId: Schema.String,
  expectedVersion: Schema.optional(
    Schema.Union([Schema.String, Schema.Number])
  ),
  property: Schema.String,
});
export type FactualAssertion = Schema.Schema.Type<typeof FactualAssertion>;

/**
 * L2 Verification verdict status (OPR-L2-001)
 */
export const L2VerificationStatus = Schema.Literals([
  "VERIFIED",
  "MISMATCH_VALUE",
  "OBJECT_NOT_FOUND",
  "PROPERTY_ABSENT",
  "VERSION_MISMATCH",
  "UNVERIFIED",
]);
export type L2VerificationStatus = Schema.Schema.Type<
  typeof L2VerificationStatus
>;

/**
 * L2 Verification verdict record (OPR-L2-001)
 */
export const L2VerificationVerdict = Schema.Struct({
  assertionId: Schema.String,
  details: Schema.String,
  evidenceValue: Schema.optional(Schema.Unknown),
  status: L2VerificationStatus,
});
export type L2VerificationVerdict = Schema.Schema.Type<
  typeof L2VerificationVerdict
>;

/**
 * Must-Answer template specifying required facts and safety warnings (OPR-L2-002)
 */
export const MustAnswerTemplate = Schema.Struct({
  questionScope: Schema.String,
  requireContraindicationCheck: Schema.Boolean,
  requiredFacts: Schema.Array(Schema.String),
  requireMissingEvidenceWarning: Schema.Boolean,
  requireUncertaintyDeclaration: Schema.Boolean,
  templateId: Schema.String,
  version: Schema.String,
});
export type MustAnswerTemplate = Schema.Schema.Type<typeof MustAnswerTemplate>;

/**
 * Completeness check result (OPR-L2-002)
 */
export const CompletenessCheckResult = Schema.Struct({
  missingContraindications: Schema.Boolean,
  missingEvidenceWarningOmitted: Schema.Boolean,
  missingUncertainty: Schema.Boolean,
  omittedFacts: Schema.Array(Schema.String),
  passed: Schema.Boolean,
  templateId: Schema.String,
});
export type CompletenessCheckResult = Schema.Schema.Type<
  typeof CompletenessCheckResult
>;

/**
 * Citation character span within evidence source (OPR-L2-003)
 */
export const TextCharSpan = Schema.Struct({
  end: Schema.Number,
  start: Schema.Number,
});
export type TextCharSpan = Schema.Schema.Type<typeof TextCharSpan>;

/**
 * Evidence citation linking claim to ground source (OPR-L2-003)
 */
export const EvidenceCitation = Schema.Struct({
  charSpan: TextCharSpan,
  citationId: Schema.String,
  claimId: Schema.String,
  evidenceId: Schema.String,
  expectedTextSnippet: Schema.String,
  sourceVersion: Schema.Union([Schema.String, Schema.Number]),
  targetEntityId: Schema.String,
});
export type EvidenceCitation = Schema.Schema.Type<typeof EvidenceCitation>;

/**
 * Citation resolution status (OPR-L2-003)
 */
export const CitationResolutionStatus = Schema.Literals([
  "RESOLVED_SUPPORTED",
  "NOT_FOUND",
  "VERSION_MISMATCH",
  "SPAN_OUT_OF_BOUNDS",
  "INACCESSIBLE",
  "SEMANTIC_MISMATCH",
  "REQUIRES_HUMAN_EVAL",
]);
export type CitationResolutionStatus = Schema.Schema.Type<
  typeof CitationResolutionStatus
>;

/**
 * Citation resolution result (OPR-L2-003)
 */
export const CitationResolutionResult = Schema.Struct({
  citationId: Schema.String,
  details: Schema.String,
  status: CitationResolutionStatus,
});
export type CitationResolutionResult = Schema.Schema.Type<
  typeof CitationResolutionResult
>;

/**
 * Extracted candidate fact status prior to human admission (OPR-L2-005)
 */
export const ExtractionAdmissionStatus = Schema.Literals([
  "PENDING",
  "ADMITTED",
  "REJECTED",
]);
export type ExtractionAdmissionStatus = Schema.Schema.Type<
  typeof ExtractionAdmissionStatus
>;

/**
 * Extracted candidate fact from unstructured or external source (OPR-L2-005)
 */
export const ExtractedCandidateFact = Schema.Struct({
  candidateId: Schema.String,
  extractedAt: Schema.Number,
  extractedByActorId: Schema.String,
  extractedValue: Schema.Unknown,
  sourceEvidenceId: Schema.String,
  sourceSpan: TextCharSpan,
  sourceVersion: Schema.Union([Schema.String, Schema.Number]),
  status: ExtractionAdmissionStatus,
});
export type ExtractedCandidateFact = Schema.Schema.Type<
  typeof ExtractedCandidateFact
>;

/**
 * Human-admitted fact record retaining provenance and edit lineage (OPR-L2-005)
 */
export const AdmittedFactRecord = Schema.Struct({
  admittedAt: Schema.Number,
  admittedByActorId: Schema.String,
  admittedFactId: Schema.String,
  admittedValue: Schema.Unknown,
  candidateId: Schema.String,
  extractedByActorId: Schema.String,
  originalExtractedValue: Schema.Unknown,
  sourceEvidenceId: Schema.String,
  sourceSpan: TextCharSpan,
  sourceVersion: Schema.Union([Schema.String, Schema.Number]),
});
export type AdmittedFactRecord = Schema.Schema.Type<typeof AdmittedFactRecord>;

/**
 * Runtime quality gate routing result (OPR-L2-006)
 */
export const QualityGateRouting = Schema.Literals([
  "ALLOW",
  "BLOCK",
  "ROUTE_TO_REVIEW",
]);
export type QualityGateRouting = Schema.Schema.Type<typeof QualityGateRouting>;

/**
 * Output quality gate evaluation (OPR-L2-006)
 */
export const QualityGateEvaluation = Schema.Struct({
  actorId: Schema.String,
  actorTier: Schema.String,
  citationsResolved: Schema.Boolean,
  completenessPassed: Schema.Boolean,
  compliancePassed: Schema.Boolean,
  gateId: Schema.String,
  passed: Schema.Boolean,
  reason: Schema.String,
  routing: QualityGateRouting,
});
export type QualityGateEvaluation = Schema.Schema.Type<
  typeof QualityGateEvaluation
>;
