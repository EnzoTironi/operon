import type { AuthorityTier, KeyScope } from "@operon/schema";
import { Data } from "effect";

/**
 * SelfApprovalDeniedError (S07):
 * Proposer cannot self-approve a prepared action proposal.
 */
export class SelfApprovalDeniedError extends Data.TaggedError(
  "SelfApprovalDeniedError"
)<{
  readonly message: string;
  readonly proposerId: string;
  readonly reviewerId: string;
}> {}

/**
 * ApprovalDigestMismatchError (S07):
 * Viewed digest must strictly match the prepared action digest.
 */
export class ApprovalDigestMismatchError extends Data.TaggedError(
  "ApprovalDigestMismatchError"
)<{
  readonly message: string;
  readonly preparedDigest: string;
  readonly viewedDigest: string;
}> {}

/**
 * StaleApprovalError (S07):
 * Prepared proposal or approval has expired, or underlying revisions have drifted.
 */
export class StaleApprovalError extends Data.TaggedError("StaleApprovalError")<{
  readonly message: string;
  readonly preparedDigest: string;
  readonly reason: string;
}> {}

/**
 * FabricatedApprovalError (S07):
 * Approval attempt was fabricated, forged, or attempted by an AI agent/sentinel
 * when human approval is strictly required.
 */
export class FabricatedApprovalError extends Data.TaggedError(
  "FabricatedApprovalError"
)<{
  readonly message: string;
  readonly reason: string;
}> {}

/**
 * UnauthorizedReviewerError (S06 / S07):
 * Reviewer lacks the authority, roles, or tenant scope to approve.
 */
export class UnauthorizedReviewerError extends Data.TaggedError(
  "UnauthorizedReviewerError"
)<{
  readonly message: string;
  readonly reviewerId: string;
  readonly requiredRole?: string;
  readonly reason?: string;
}> {}

/**
 * FreshnessOrPolicyDeniedError (S06 / S07):
 * Preparation or evaluation failed policy readiness, freshness budgets, or guards.
 */
export class FreshnessOrPolicyDeniedError extends Data.TaggedError(
  "FreshnessOrPolicyDeniedError"
)<{
  readonly message: string;
  readonly actionId: string;
  readonly reasons: readonly string[];
}> {}

/**
 * PreparedActionNotFoundError:
 * Pinned proposal not found or does not exist under tenant non-disclosure.
 */
export class PreparedActionNotFoundError extends Data.TaggedError(
  "PreparedActionNotFoundError"
)<{
  readonly message: string;
  readonly preparedDigest?: string;
  readonly preparedId?: string;
}> {}

/**
 * ApprovalRecordNotFoundError:
 * Approval record not found or does not exist under tenant non-disclosure.
 */
export class ApprovalRecordNotFoundError extends Data.TaggedError(
  "ApprovalRecordNotFoundError"
)<{
  readonly message: string;
  readonly approvalId: string;
}> {}

/**
 * GrantNotFoundError (S06):
 * Delegated IntentGrant does not exist or tenant mismatch.
 */
export class GrantNotFoundError extends Data.TaggedError("GrantNotFoundError")<{
  readonly message: string;
  readonly grantId: string;
}> {}

/**
 * GrantExceededError (S06):
 * IntentGrant budget, expiry, revocation epoch, or scope exceeded.
 */
export class GrantExceededError extends Data.TaggedError("GrantExceededError")<{
  readonly message: string;
  readonly grantId: string;
  readonly reason: string;
}> {}

/**
 * TenantMismatchError (Tenant Non-Disclosure):
 * Tenant or environment boundary mismatch; caller cannot observe resource existence.
 */
export class TenantMismatchError extends Data.TaggedError(
  "TenantMismatchError"
)<{
  readonly message: string;
  readonly tenantId: string;
}> {}

/**
 * EnvironmentMismatchError:
 * Environment boundary mismatch.
 */
export class EnvironmentMismatchError extends Data.TaggedError(
  "EnvironmentMismatchError"
)<{
  readonly message: string;
  readonly environmentId: string;
}> {}

/**
 * CommitConcurrencyError (S08):
 * Pinned object revision during prepare does not match current revision during commit.
 */
export class CommitConcurrencyError extends Data.TaggedError(
  "CommitConcurrencyError"
)<{
  readonly message: string;
  readonly objectId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
}> {}

/**
 * OutboxDeliveryError (S08):
 * Durable side effect delivery encountered failure or external unknown timeout.
 */
export class OutboxDeliveryError extends Data.TaggedError(
  "OutboxDeliveryError"
)<{
  readonly message: string;
  readonly outboxId: string;
  readonly status: string;
  readonly cause?: unknown;
}> {}

/**
 * IndependentReviewRequiredError (S09):
 * Required semantic reviewer cannot be the acting principal.
 */
export class IndependentReviewRequiredError extends Data.TaggedError(
  "IndependentReviewRequiredError"
)<{
  readonly message: string;
  readonly proposerId: string;
  readonly reviewerId: string;
}> {}

/**
 * ReviewUnavailableError (S09):
 * Mandatory semantic review is unavailable, stale, or malformed.
 */
export class ReviewUnavailableError extends Data.TaggedError(
  "ReviewUnavailableError"
)<{
  readonly message: string;
  readonly reason: string;
}> {}

/**
 * SandboxContainmentError (S10):
 * Simulation or sandbox escape attempt detected and failed closed.
 */
export class SandboxContainmentError extends Data.TaggedError(
  "SandboxContainmentError"
)<{
  readonly message: string;
  readonly escapeType: "network" | "filesystem" | "credential" | "effect";
  readonly target: string;
}> {}

/**
 * PromotionEvidenceMismatchError (S11):
 * Promotion evidence candidate digest or profile does not match promotion plan.
 */
export class PromotionEvidenceMismatchError extends Data.TaggedError(
  "PromotionEvidenceMismatchError"
)<{
  readonly message: string;
  readonly expectedCandidateDigest: string;
  readonly actualCandidateDigest: string;
  readonly expectedProfile: string;
  readonly actualProfile: string;
}> {}

/**
 * RolloutHaltedError (S11):
 * Phased rollout halted due to cohort failure or breached stop condition.
 */
export class RolloutHaltedError extends Data.TaggedError("RolloutHaltedError")<{
  readonly message: string;
  readonly cohortId: string;
  readonly reason: string;
}> {}

/**
 * RollbackExecutionError (S11):
 * Rollback execution failed due to invalid receipt or missing state.
 */
export class RollbackExecutionError extends Data.TaggedError(
  "RollbackExecutionError"
)<{
  readonly message: string;
  readonly promotionId: string;
  readonly reason: string;
}> {}

/**
 * DiagnosticNotFoundError (S18):
 * Diagnostic bundle for requested runId not found.
 */
export class DiagnosticNotFoundError extends Data.TaggedError(
  "DiagnosticNotFoundError"
)<{
  readonly message: string;
  readonly runId: string;
}> {}

/**
 * TierAuthorityExceededError (S12 / OPR-AGT-001):
 * Attempted operation exceeds the permitted authority tier.
 */
export class TierAuthorityExceededError extends Data.TaggedError(
  "TierAuthorityExceededError"
)<{
  readonly message: string;
  readonly tier: AuthorityTier;
  readonly attemptedOperation: string;
}> {}

/**
 * EnvelopeViolationError (S12 / OPR-AGT-002):
 * Action invocation exceeds the bounded mandate envelope (action class, object set, or risk band).
 */
export class EnvelopeViolationError extends Data.TaggedError(
  "EnvelopeViolationError"
)<{
  readonly message: string;
  readonly mandateId: string;
  readonly violationType: "actionClass" | "objectSet" | "riskBand";
  readonly details: string;
}> {}

/**
 * BudgetExhaustedError (S12 / OPR-AGT-002):
 * TaskMandate budget limit has been reached or exceeded.
 */
export class BudgetExhaustedError extends Data.TaggedError(
  "BudgetExhaustedError"
)<{
  readonly message: string;
  readonly mandateId: string;
  readonly spentBudget: number;
  readonly requestedBudget: number;
  readonly budgetLimit: number;
}> {}

/**
 * UnjustifiedPromotionError (S12 / OPR-AGT-002):
 * Promotion to higher tier attempted without required calibration evidence or passing thresholds.
 */
export class UnjustifiedPromotionError extends Data.TaggedError(
  "UnjustifiedPromotionError"
)<{
  readonly message: string;
  readonly mandateId: string;
  readonly reason: string;
}> {}

/**
 * MandateExpiredError (S12 / OPR-AGT-002):
 * TaskMandate has passed its expiration timestamp.
 */
export class MandateExpiredError extends Data.TaggedError(
  "MandateExpiredError"
)<{
  readonly message: string;
  readonly mandateId: string;
  readonly expiresAt: number;
  readonly attemptedAt: number;
}> {}

/**
 * KeyScopeViolationError (S12 / OPR-AGT-003):
 * Attempted operation violates access key scope (consumer modifying definition, or builder accessing prod data / self-approving).
 */
export class KeyScopeViolationError extends Data.TaggedError(
  "KeyScopeViolationError"
)<{
  readonly message: string;
  readonly keyId: string;
  readonly keyScope: KeyScope;
  readonly attemptedAction: string;
  readonly targetDomain: "definition" | "production_data" | "self_approval";
}> {}

/**
 * UntrustedCandidateQuarantinedError (S12 / OPR-AGT-004):
 * Model output failed deterministic validation (unknown action, invalid object type, hidden field, prompt injection) and is quarantined.
 */
export class UntrustedCandidateQuarantinedError extends Data.TaggedError(
  "UntrustedCandidateQuarantinedError"
)<{
  readonly message: string;
  readonly candidateId: string;
  readonly modelId: string;
  readonly reason: string;
  readonly violations: readonly string[];
}> {}

/**
 * PlanValidationError (S12 / OPR-FULL-023):
 * Plan DAG failed validation (cycle detected, unauthorized action/object, risk band exceeded, budget exceeded, or mandatory constraint violated).
 */
export class PlanValidationError extends Data.TaggedError(
  "PlanValidationError"
)<{
  readonly message: string;
  readonly planId: string;
  readonly reason:
    | "BUDGET_EXCEEDED"
    | "CYCLE_DETECTED"
    | "MANDATORY_CONSTRAINT_VIOLATED"
    | "RISK_BAND_EXCEEDED"
    | "UNAUTHORIZED_ACTION_CLASS"
    | "UNAUTHORIZED_TARGET_OBJECT";
  readonly violations: readonly string[];
}> {}

/**
 * StopConditionTriggeredError (S12 / OPR-FULL-021, OPR-FULL-023):
 * Execution stopped due to budget limit, deadline expiry, invariant violation, or safety tripwire.
 */
export class StopConditionTriggeredError extends Data.TaggedError(
  "StopConditionTriggeredError"
)<{
  readonly conditionType: string;
  readonly detail: string;
  readonly mandateId: string;
  readonly message: string;
}> {}

/**
 * FictionalSuccessRejectedError (S12 / OPR-FULL-021 / FULL-ACC-021):
 * Model reported completion, but independent state verification found unsatisfied success predicates.
 */
export class FictionalSuccessRejectedError extends Data.TaggedError(
  "FictionalSuccessRejectedError"
)<{
  readonly mandateId: string;
  readonly message: string;
  readonly unsatisfiedPredicates: readonly string[];
}> {}

/**
 * EvidenceAcquisitionDeniedError (S12 / OPR-FULL-022):
 * Evidence acquisition rejected due to out-of-envelope action, object, or budget.
 */
export class EvidenceAcquisitionDeniedError extends Data.TaggedError(
  "EvidenceAcquisitionDeniedError"
)<{
  readonly actionId: string;
  readonly mandateId: string;
  readonly message: string;
  readonly reason:
    | "ACTION_NOT_ALLOWED"
    | "BUDGET_EXCEEDED"
    | "OBJECT_NOT_ALLOWED"
    | "SOURCE_UNAVAILABLE";
}> {}

/**
 * MemoryAccessDeniedError (S12 / OPR-AGT-005):
 * Memory access rejected due to cross-tenant boundary, expired TTL, or unauthorized sensitivity level.
 */
export class MemoryAccessDeniedError extends Data.TaggedError(
  "MemoryAccessDeniedError"
)<{
  readonly memoryId: string;
  readonly message: string;
  readonly reason:
    | "EXPIRED"
    | "FORBIDDEN_AUTHORITY_INJECTION"
    | "TENANT_MISMATCH";
  readonly tenantId: string;
}> {}
