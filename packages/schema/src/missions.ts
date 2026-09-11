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
    if (entry.endsWith(":*")) {
      const prefix = entry.slice(0, -1);
      if (targetObjectId.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}
