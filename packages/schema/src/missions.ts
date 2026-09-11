import { Schema } from "effect";

/**
 * Four Interaction Modes and Authority Tiers per S12 & OPR-AGT-001:
 * - TIER_1_OBSERVE: Read-only inspection; cannot propose or execute.
 * - TIER_2_PROPOSE: Agent proposes action for human execution; cannot execute.
 * - TIER_3_EXECUTE_WITH_APPROVAL: Agent executes only after explicit human approval.
 * - TIER_4_BOUNDED_AUTONOMY: Agent executes directly within pre-approved envelope.
 */
export const AuthorityTier = Schema.Literals([
  "TIER_1_OBSERVE",
  "TIER_2_PROPOSE",
  "TIER_3_EXECUTE_WITH_APPROVAL",
  "TIER_4_BOUNDED_AUTONOMY",
]);
export type AuthorityTier = Schema.Schema.Type<typeof AuthorityTier>;

/**
 * Risk bands for bounded autonomy per OPR-AGT-002
 */
export const RiskBand = Schema.Literals(["LOW", "MEDIUM", "HIGH"]);
export type RiskBand = Schema.Schema.Type<typeof RiskBand>;

/**
 * Calibration evidence required for earned promotion to Tier 4 per OPR-AGT-002
 */
export const CalibrationEvidence = Schema.Struct({
  evaluatedAt: Schema.Number,
  minimumTrialsRequired: Schema.Number,
  passRate: Schema.Number,
  safetyViolations: Schema.Number,
  trialCount: Schema.Number,
  verifierSignature: Schema.String,
});
export type CalibrationEvidence = Schema.Schema.Type<
  typeof CalibrationEvidence
>;

/**
 * Auditable demotion event record per OPR-AGT-002
 */
export const DemotionEvent = Schema.Struct({
  agentId: Schema.String,
  demotedAt: Schema.Number,
  mandateId: Schema.String,
  newTier: AuthorityTier,
  previousTier: AuthorityTier,
  reason: Schema.String,
  violationsCount: Schema.Number,
});
export type DemotionEvent = Schema.Schema.Type<typeof DemotionEvent>;

/**
 * TaskMandate Envelope bounding agent authority per S12 & OPR-AGT-002
 */
export const TaskMandateEnvelope = Schema.Struct({
  allowedActionClasses: Schema.Array(Schema.String),
  budgetLimit: Schema.Number,
  expiresAt: Schema.Number,
  mandateId: Schema.String,
  maxRiskBand: RiskBand,
  objectSet: Schema.Array(Schema.String),
  principalId: Schema.String,
  spentBudget: Schema.Number,
  tier: AuthorityTier,
});
export type TaskMandateEnvelope = Schema.Schema.Type<
  typeof TaskMandateEnvelope
>;

/**
 * Distinct, non-collapsible actor and confirmation records per OPR-AGT-001
 */
export const ExecutionActorRecord = Schema.Union([
  Schema.Struct({
    agentProposerId: Schema.String,
    confirmedAt: Schema.Number,
    humanReviewerId: Schema.String,
    mode: Schema.Literal("TIER_2_HUMAN"),
    proposalId: Schema.String,
  }),
  Schema.Struct({
    approvalId: Schema.String,
    confirmedAt: Schema.Number,
    executingAgentId: Schema.String,
    humanApproverId: Schema.String,
    mode: Schema.Literal("TIER_3_APPROVED_AGENT"),
  }),
  Schema.Struct({
    confirmedAt: Schema.Number,
    executingAgentId: Schema.String,
    mandateId: Schema.String,
    mode: Schema.Literal("TIER_4_AUTONOMOUS_AGENT"),
    riskBand: RiskBand,
  }),
]);
export type ExecutionActorRecord = Schema.Schema.Type<
  typeof ExecutionActorRecord
>;

/**
 * Maps enum AuthorityTier to numeric representation (1..4)
 */
export function numericTier(tier: AuthorityTier): 1 | 2 | 3 | 4 {
  switch (tier) {
    case "TIER_1_OBSERVE": {
      return 1;
    }
    case "TIER_2_PROPOSE": {
      return 2;
    }
    case "TIER_3_EXECUTE_WITH_APPROVAL": {
      return 3;
    }
    case "TIER_4_BOUNDED_AUTONOMY": {
      return 4;
    }
    default: {
      return 1;
    }
  }
}

/**
 * Maps numeric representation (1..4) to enum AuthorityTier
 */
export function fromNumericTier(tier: 1 | 2 | 3 | 4): AuthorityTier {
  switch (tier) {
    case 1: {
      return "TIER_1_OBSERVE";
    }
    case 2: {
      return "TIER_2_PROPOSE";
    }
    case 3: {
      return "TIER_3_EXECUTE_WITH_APPROVAL";
    }
    case 4: {
      return "TIER_4_BOUNDED_AUTONOMY";
    }
    default: {
      return "TIER_1_OBSERVE";
    }
  }
}

const RISK_LEVELS: Record<RiskBand, number> = {
  HIGH: 3,
  LOW: 1,
  MEDIUM: 2,
};

/**
 * Evaluates whether requested risk band is within the allowed maximum risk band
 */
export function isRiskBandAllowed(
  maxBand: RiskBand,
  requestedBand: RiskBand
): boolean {
  return RISK_LEVELS[requestedBand] <= RISK_LEVELS[maxBand];
}

/**
 * Checks whether target object is permitted within the authorized object set
 */
export function isObjectInSet(
  objectSet: readonly string[],
  targetObjectId: string
): boolean {
  if (objectSet.includes("*")) {
    return true;
  }
  for (const entry of objectSet) {
    if (entry === targetObjectId) {
      return true;
    }
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (targetObjectId.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Key scope separating runtime consumers from authoring builders per S12 & OPR-AGT-003
 */
export const KeyScope = Schema.Literals(["CONSUMER", "BUILDER"]);
export type KeyScope = Schema.Schema.Type<typeof KeyScope>;

/**
 * Access key record bound to tenant and scope per OPR-AGT-003
 */
export const AccessKey = Schema.Struct({
  createdAt: Schema.Number,
  environmentId: Schema.String,
  expiresAt: Schema.Number,
  keyId: Schema.String,
  principalId: Schema.String,
  scope: KeyScope,
  tenantId: Schema.String,
});
export type AccessKey = Schema.Schema.Type<typeof AccessKey>;

/**
 * Admission verdict for untrusted model candidates per OPR-AGT-004
 */
export const CandidateAdmissionVerdict = Schema.Literals([
  "ADMITTED",
  "QUARANTINED",
  "REJECTED",
]);
export type CandidateAdmissionVerdict = Schema.Schema.Type<
  typeof CandidateAdmissionVerdict
>;

/**
 * Result of deterministic model candidate validation per OPR-AGT-004
 */
export const ModelCandidateEvaluation = Schema.Struct({
  candidateId: Schema.String,
  evaluatedAt: Schema.Number,
  modelId: Schema.String,
  quarantineReason: Schema.optionalKey(Schema.String),
  sanitizedPayload: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Unknown)
  ),
  verdict: CandidateAdmissionVerdict,
  violations: Schema.Array(Schema.String),
});
export type ModelCandidateEvaluation = Schema.Schema.Type<
  typeof ModelCandidateEvaluation
>;

/**
 * Observable predicate types for verifiable mission objectives per S12 & OPR-FULL-021
 */
export const ObservablePredicate = Schema.Union([
  Schema.TaggedStruct("PROPERTY_EQUALS", {
    expectedValue: Schema.Unknown,
    objectId: Schema.String,
    property: Schema.String,
  }),
  Schema.TaggedStruct("STATE_MATCHES", {
    expectedState: Schema.String,
    objectId: Schema.String,
  }),
  Schema.TaggedStruct("RECEIPT_EXISTS", {
    actionId: Schema.String,
    requiredStatus: Schema.Literals(["COMPLETED", "EXECUTED"]),
  }),
  Schema.TaggedStruct("CUSTOM_ASSERTION", {
    assertionId: Schema.String,
    parameters: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown)
    ),
  }),
]);
export type ObservablePredicate = Schema.Schema.Type<
  typeof ObservablePredicate
>;

/**
 * Mandatory stop conditions and safety tripwires per S12 & OPR-FULL-021, OPR-FULL-023
 */
export const StopCondition = Schema.Union([
  Schema.TaggedStruct("MAX_BUDGET_EXCEEDED", {
    maxBudget: Schema.Number,
  }),
  Schema.TaggedStruct("EXPIRED_DEADLINE", {
    deadline: Schema.Number,
  }),
  Schema.TaggedStruct("MANDATORY_CONSTRAINT", {
    constraintId: Schema.String,
    description: Schema.String,
  }),
  Schema.TaggedStruct("SAFETY_TRIPWIRE", {
    reason: Schema.String,
    tripwireId: Schema.String,
  }),
]);
export type StopCondition = Schema.Schema.Type<typeof StopCondition>;

/**
 * A single plan step inside a Planning DAG per S12 & OPR-FULL-023
 */
export const PlanStep = Schema.Struct({
  actionClass: Schema.String,
  actionId: Schema.String,
  dependencies: Schema.Array(Schema.String),
  estimatedCost: Schema.Number,
  mandatoryConstraints: Schema.optionalKey(Schema.Array(Schema.String)),
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  riskBand: RiskBand,
  stepId: Schema.String,
  targetObjectId: Schema.String,
});
export type PlanStep = Schema.Schema.Type<typeof PlanStep>;

/**
 * Versioned Plan DAG with dependencies per S12 & OPR-FULL-023
 */
export const PlanDAG = Schema.Struct({
  mandateId: Schema.String,
  objectiveScore: Schema.Number,
  planId: Schema.String,
  proposerAgentId: Schema.String,
  steps: Schema.Array(PlanStep),
});
export type PlanDAG = Schema.Schema.Type<typeof PlanDAG>;

/**
 * Mission lifecycle status per S12 & OPR-FULL-021
 */
export const MissionStatus = Schema.Literals([
  "PENDING",
  "PLANNING",
  "EXECUTING",
  "PARTIAL",
  "SUCCEEDED",
  "FAILED",
  "STOPPED",
]);
export type MissionStatus = Schema.Schema.Type<typeof MissionStatus>;

/**
 * Full Mission TaskMandate contract per S12, OPR-FULL-021, and OPR-FULL-023
 */
export const MissionTaskMandate = Schema.Struct({
  deadline: Schema.Number,
  envelope: TaskMandateEnvelope,
  issuerId: Schema.String,
  mandateId: Schema.String,
  objective: Schema.String,
  ownerId: Schema.String,
  stopConditions: Schema.Array(StopCondition),
  successPredicates: Schema.Array(ObservablePredicate),
});
export type MissionTaskMandate = Schema.Schema.Type<typeof MissionTaskMandate>;

/**
 * Evaluation result for an individual observable predicate
 */
export const PredicateEvaluationResult = Schema.Struct({
  detail: Schema.optionalKey(Schema.String),
  predicate: ObservablePredicate,
  satisfied: Schema.Boolean,
});
export type PredicateEvaluationResult = Schema.Schema.Type<
  typeof PredicateEvaluationResult
>;

/**
 * Independent mission outcome evaluation report per S12 & OPR-FULL-021
 */
export const MissionOutcomeEvaluation = Schema.Struct({
  allPredicatesSatisfied: Schema.Boolean,
  fictionalSuccessPrevented: Schema.Boolean,
  mandateId: Schema.String,
  plannerReportedDone: Schema.Boolean,
  predicatesEvaluated: Schema.Array(PredicateEvaluationResult),
  status: MissionStatus,
  stopConditionsTriggered: Schema.Array(Schema.String),
});
export type MissionOutcomeEvaluation = Schema.Schema.Type<
  typeof MissionOutcomeEvaluation
>;

/**
 * Result of plan DAG verification per OPR-FULL-023
 */
export const PlanValidationResult = Schema.Struct({
  isValid: Schema.Boolean,
  planId: Schema.String,
  violations: Schema.Array(Schema.String),
});
export type PlanValidationResult = Schema.Schema.Type<
  typeof PlanValidationResult
>;

/**
 * Governed evidence acquisition action per S12 & OPR-FULL-022
 */
export const EvidenceAcquisitionAction = Schema.Struct({
  actionClass: Schema.String,
  actionId: Schema.String,
  budgetCost: Schema.Number,
  mandateId: Schema.String,
  queryParameters: Schema.Record(Schema.String, Schema.Unknown),
  sourceConnectorId: Schema.String,
  targetObjectId: Schema.String,
});
export type EvidenceAcquisitionAction = Schema.Schema.Type<
  typeof EvidenceAcquisitionAction
>;

/**
 * Status of evidence acquisition operation
 */
export const EvidenceAcquisitionStatus = Schema.Literals([
  "ACQUIRED",
  "BUDGET_EXCEEDED",
  "SOURCE_UNAVAILABLE",
  "UNAUTHORIZED",
]);
export type EvidenceAcquisitionStatus = Schema.Schema.Type<
  typeof EvidenceAcquisitionStatus
>;

/**
 * Receipt of active evidence acquisition per OPR-FULL-022
 */
export const EvidenceAcquisitionReceipt = Schema.Struct({
  actionId: Schema.String,
  acquiredAt: Schema.Number,
  candidateHash: Schema.String,
  cost: Schema.Number,
  evidencePayload: Schema.Record(Schema.String, Schema.Unknown),
  mandateId: Schema.String,
  sourceConnectorId: Schema.String,
  status: EvidenceAcquisitionStatus,
  targetObjectId: Schema.String,
});
export type EvidenceAcquisitionReceipt = Schema.Schema.Type<
  typeof EvidenceAcquisitionReceipt
>;

/**
 * Memory sensitivity classification per OPR-AGT-005
 */
export const MemorySensitivity = Schema.Literals([
  "CONFIDENTIAL",
  "INTERNAL",
  "PUBLIC",
  "RESTRICTED",
]);
export type MemorySensitivity = Schema.Schema.Type<typeof MemorySensitivity>;

/**
 * Tenant-isolated, time-bounded governed memory record per S12 & OPR-AGT-005
 */
export const GovernedAgentMemoryRecord = Schema.Struct({
  agentId: Schema.String,
  content: Schema.Record(Schema.String, Schema.Unknown),
  environmentId: Schema.String,
  expiresAt: Schema.optionalKey(Schema.Number),
  mandateId: Schema.String,
  memoryId: Schema.String,
  recordedAt: Schema.Number,
  sensitivity: MemorySensitivity,
  tenantId: Schema.String,
});
export type GovernedAgentMemoryRecord = Schema.Schema.Type<
  typeof GovernedAgentMemoryRecord
>;

/**
 * Step disposition record for reconstructable execution trace
 */
export const TraceStepDisposition = Schema.Struct({
  disposition: Schema.String,
  stepId: Schema.String,
});
export type TraceStepDisposition = Schema.Schema.Type<
  typeof TraceStepDisposition
>;

/**
 * Tool call record for reconstructable execution trace
 */
export const TraceToolCall = Schema.Struct({
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  resultDigest: Schema.String,
  toolName: Schema.String,
});
export type TraceToolCall = Schema.Schema.Type<typeof TraceToolCall>;

/**
 * Full reconstructable observable execution trace per S12 & OPR-AGT-005
 */
export const ReconstructableExecutionTrace = Schema.Struct({
  actionReceipts: Schema.Array(Schema.String),
  candidateDigest: Schema.String,
  executedAt: Schema.Number,
  mandateId: Schema.String,
  modelVersion: Schema.String,
  rationale: Schema.String,
  stepDispositions: Schema.Array(TraceStepDisposition),
  toolCalls: Schema.Array(TraceToolCall),
  traceId: Schema.String,
});
export type ReconstructableExecutionTrace = Schema.Schema.Type<
  typeof ReconstructableExecutionTrace
>;

/**
 * Model provider classification per S12 & OPR-FULL-024
 */
export const ModelProvider = Schema.Literals([
  "ANTHROPIC",
  "LOCAL_SANDBOX",
  "OLLAMA",
  "OPENAI",
  "SELF_HOSTED",
]);
export type ModelProvider = Schema.Schema.Type<typeof ModelProvider>;

/**
 * Benchmark evaluation case for model promotion per OPR-FULL-024
 */
export const ModelEvaluationCase = Schema.Struct({
  caseId: Schema.String,
  expectedAction: Schema.String,
  forbiddenOutputPatterns: Schema.Array(Schema.String),
  inputPayload: Schema.Record(Schema.String, Schema.Unknown),
});
export type ModelEvaluationCase = Schema.Schema.Type<
  typeof ModelEvaluationCase
>;

/**
 * Report generated by versioned model evaluation suite per OPR-FULL-024
 */
export const ModelEvaluationReport = Schema.Struct({
  evaluatedAt: Schema.Number,
  failures: Schema.Array(Schema.String),
  modelId: Schema.String,
  passed: Schema.Boolean,
  score: Schema.Number,
  suiteVersion: Schema.String,
});
export type ModelEvaluationReport = Schema.Schema.Type<
  typeof ModelEvaluationReport
>;

/**
 * Model routing configuration with token budget and fallback per S12 & OPR-FULL-024
 */
export const ModelRoutingConfig = Schema.Struct({
  fallbackModelId: Schema.optionalKey(Schema.String),
  maxTokenBudget: Schema.Number,
  modelId: Schema.String,
  provider: ModelProvider,
  routingKey: Schema.String,
  version: Schema.String,
});
export type ModelRoutingConfig = Schema.Schema.Type<typeof ModelRoutingConfig>;
