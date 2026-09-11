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

/**
 * ModelPromotionDeniedError (S12 / OPR-FULL-024):
 * Promotion of candidate model to production routing rejected due to benchmark failure or data policy violation.
 */
export class ModelPromotionDeniedError extends Data.TaggedError(
  "ModelPromotionDeniedError"
)<{
  readonly candidateModelId: string;
  readonly currentProductionModelId: string;
  readonly failures: readonly string[];
  readonly message: string;
  readonly reason: "BENCHMARK_FAILURE" | "DATA_POLICY_VIOLATION";
}> {}

/**
 * ReadinessDeficientError (S12 / OPR-FULL-025):
 * Action rejected because state readiness is deficient, even if model context fidelity is high.
 */
export class ReadinessDeficientError extends Data.TaggedError(
  "ReadinessDeficientError"
)<{
  readonly actionId: string;
  readonly contextFidelityScore: number;
  readonly deficiencies: readonly string[];
  readonly message: string;
  readonly objectId: string;
}> {}

/**
 * ModelGatewayExecutionError (S12 / OPR-FULL-024):
 * Model execution or fallback routing failure in gateway.
 */
export class ModelGatewayExecutionError extends Data.TaggedError(
  "ModelGatewayExecutionError"
)<{
  readonly message: string;
  readonly modelId?: string;
  readonly routingKey: string;
}> {}

/**
 * FunctionPermissionDeniedError (OPR-FUN-001):
 * Caller lacks mandatory permissions to invoke typed read function.
 */
export class FunctionPermissionDeniedError extends Data.TaggedError(
  "FunctionPermissionDeniedError"
)<{
  readonly callerId: string;
  readonly functionId: string;
  readonly message: string;
  readonly missingPermissions: readonly string[];
}> {}

/**
 * FunctionValidationError (OPR-FUN-001):
 * Function input parameters or returned output failed schema validation.
 */
export class FunctionValidationError extends Data.TaggedError(
  "FunctionValidationError"
)<{
  readonly errors: readonly string[];
  readonly functionId: string;
  readonly message: string;
  readonly phase: "INPUT_VALIDATION" | "OUTPUT_VALIDATION";
}> {}

/**
 * ModelOutOfScopeError (OPR-FUN-004):
 * Model input features fall outside declared applicability envelope.
 */
export class ModelOutOfScopeError extends Data.TaggedError(
  "ModelOutOfScopeError"
)<{
  readonly details: string;
  readonly feature: string;
  readonly message: string;
  readonly modelId: string;
}> {}

/**
 * RulePrecedenceViolationError (OPR-FUN-006):
 * Attempted action overrides deterministic hard red lines with model scores or explanations.
 */
export class RulePrecedenceViolationError extends Data.TaggedError(
  "RulePrecedenceViolationError"
)<{
  readonly attemptedAction: string;
  readonly explanation?: string;
  readonly message: string;
  readonly modelConfidence: number;
  readonly ruleId: string;
}> {}

/**
 * L2ContextMismatchError (OPR-L2-001):
 * Assertion does not match ground truth or registered bitemporal evidence context.
 */
export class L2ContextMismatchError extends Data.TaggedError(
  "L2ContextMismatchError"
)<{
  readonly assertionId: string;
  readonly details: string;
  readonly entityId: string;
  readonly message: string;
  readonly property: string;
  readonly reason:
    | "OBJECT_NOT_FOUND"
    | "PROPERTY_ABSENT"
    | "VALUE_MISMATCH"
    | "VERSION_MISMATCH";
}> {}

/**
 * CompletenessCheckFailedError (OPR-L2-002):
 * Output fails Must-Answer template requirements or omits mandatory contraindication checks.
 */
export class CompletenessCheckFailedError extends Data.TaggedError(
  "CompletenessCheckFailedError"
)<{
  readonly message: string;
  readonly omittedRequirements: readonly string[];
  readonly templateId: string;
}> {}

/**
 * CitationResolutionError (OPR-L2-003):
 * Claim citation cannot be resolved to registered evidence span or version.
 */
export class CitationResolutionError extends Data.TaggedError(
  "CitationResolutionError"
)<{
  readonly citationId: string;
  readonly claimId: string;
  readonly message: string;
  readonly reason:
    | "EVIDENCE_INACCESSIBLE"
    | "EVIDENCE_NOT_FOUND"
    | "SEMANTIC_MISMATCH"
    | "SPAN_OUT_OF_BOUNDS"
    | "VERSION_MISMATCH";
}> {}

/**
 * CommunicationComplianceViolationError (OPR-L2-004):
 * Generated communication exceeds actor authority tier or makes unpermitted commitments.
 */
export class CommunicationComplianceViolationError extends Data.TaggedError(
  "CommunicationComplianceViolationError"
)<{
  readonly actorId: string;
  readonly actorTier: string;
  readonly message: string;
  readonly violationType:
    | "UNAUTHORIZED_COMMITMENT"
    | "UNAUTHORIZED_EXECUTION_CLAIM"
    | "UNSUPPORTED_ASSURANCE";
}> {}

/**
 * UnadmittedCandidateError (OPR-L2-005):
 * Candidate fact attempted to be used as authoritative evidence before human admission.
 */
export class UnadmittedCandidateError extends Data.TaggedError(
  "UnadmittedCandidateError"
)<{
  readonly candidateId: string;
  readonly message: string;
  readonly status: string;
}> {}

/**
 * RoomAccessRevokedError (OPR-FULL-038):
 * Access to room, surfaces, or derived group memory revoked immediately upon membership departure.
 */
export class RoomAccessRevokedError extends Data.TaggedError(
  "RoomAccessRevokedError"
)<{
  readonly message: string;
  readonly revokedAt: number;
  readonly roomId: string;
  readonly userId: string;
}> {}

/**
 * SurfaceAudienceDeniedError (S13 / OPR-FULL-038):
 * Surface rendering rejected due to unauthorized audience.
 */
export class SurfaceAudienceDeniedError extends Data.TaggedError(
  "SurfaceAudienceDeniedError"
)<{
  readonly audience: string;
  readonly message: string;
  readonly surfaceId: string;
}> {}

/**
 * ClosedObjectModificationDeniedError (OPR-FULL-036):
 * Attempted modification on closed or finalized object rejected identically across all channels (Button, API, Agent).
 */
export class ClosedObjectModificationDeniedError extends Data.TaggedError(
  "ClosedObjectModificationDeniedError"
)<{
  readonly actionName: string;
  readonly channel: "BUTTON" | "API" | "AGENT_TOOL";
  readonly message: string;
  readonly objectId: string;
  readonly objectStatus: string;
}> {}

/**
 * ConnectorCapabilityMismatchError (S15 / OPR-FULL-043):
 * Connector lacks a required guarantee demanded by a workflow/package. Incompatibility is explicit, never wrapped.
 */
export class ConnectorCapabilityMismatchError extends Data.TaggedError(
  "ConnectorCapabilityMismatchError"
)<{
  readonly connectorId: string;
  readonly message: string;
  readonly packageId: string;
  readonly providedValue: unknown;
  readonly requiredCapability: string;
}> {}

/**
 * BrokerCredentialViolationError (S15 / OPR-FULL-044):
 * Agent attempted direct access/extraction of connector credentials outside the broker/worker boundary.
 */
export class BrokerCredentialViolationError extends Data.TaggedError(
  "BrokerCredentialViolationError"
)<{
  readonly actorId: string;
  readonly connectorId: string;
  readonly message: string;
}> {}

/**
 * BusinessAuthorityMissingError (S15 / OPR-FULL-044):
 * Outbound connector operation attempted without an active kernel TaskMandate/IntentGrant. Token availability alone does not grant business authority.
 */
export class BusinessAuthorityMissingError extends Data.TaggedError(
  "BusinessAuthorityMissingError"
)<{
  readonly actorId: string;
  readonly message: string;
  readonly operationId: string;
  readonly tokenPresent: boolean;
}> {}

/**
 * OutboundExecutionFailedError (S15 / OPR-FULL-044):
 * Downstream outbound connector invocation failed during remote execution.
 */
export class OutboundExecutionFailedError extends Data.TaggedError(
  "OutboundExecutionFailedError"
)<{
  readonly message: string;
  readonly operationId: string;
  readonly targetSystem: string;
}> {}

/**
 * UncontractedLinkTraversalError (S15 / OPR-FULL-044 / FULL-ACC-044):
 * Navigation attempted across private or uncontracted links outside the negotiated view contract.
 */
export class UncontractedLinkTraversalError extends Data.TaggedError(
  "UncontractedLinkTraversalError"
)<{
  readonly contractId: string;
  readonly linkRelation: string;
  readonly message: string;
  readonly requestedPath: string;
  readonly sourceCellId: string;
  readonly targetCellId: string;
}> {}

/**
 * FederationContractRevokedError (S15 / OPR-FULL-044):
 * View access or traversal attempted under a revoked federation contract.
 */
export class FederationContractRevokedError extends Data.TaggedError(
  "FederationContractRevokedError"
)<{
  readonly contractId: string;
  readonly message: string;
  readonly sourceCellId: string;
  readonly targetCellId: string;
}> {}

/**
 * FederationContractExpiredError (S15 / OPR-FULL-044):
 * View access or traversal attempted outside the contract's validity window.
 */
export class FederationContractExpiredError extends Data.TaggedError(
  "FederationContractExpiredError"
)<{
  readonly attemptedAt: string;
  readonly contractId: string;
  readonly message: string;
  readonly validUntil: string;
}> {}

/**
 * FederationAttributionMissingError (S15 / OPR-FULL-046):
 * Remote federated claim rejected due to missing mandatory attribution fields.
 */
export class FederationAttributionMissingError extends Data.TaggedError(
  "FederationAttributionMissingError"
)<{
  readonly claimId?: string;
  readonly message: string;
  readonly missingFields: readonly string[];
}> {}

/**
 * MultiCellCompensationFailedError (S15 / OPR-FULL-046):
 * Downstream step failed and compensating action on previously committed cell also failed.
 */
export class MultiCellCompensationFailedError extends Data.TaggedError(
  "MultiCellCompensationFailedError"
)<{
  readonly cellId: string;
  readonly message: string;
  readonly operationId: string;
  readonly stepId: string;
  readonly underlyingError: string;
}> {}

/**
 * RemoteCellExecutionError (S15 / OPR-FULL-046):
 * Step execution failed on a remote cell in a multi-cell saga.
 */
export class RemoteCellExecutionError extends Data.TaggedError(
  "RemoteCellExecutionError"
)<{
  readonly cellId?: string;
  readonly message: string;
}> {}

/**
 * RemoteCellCompensationError (S15 / OPR-FULL-046):
 * Compensating action failed on a remote cell in a multi-cell saga.
 */
export class RemoteCellCompensationError extends Data.TaggedError(
  "RemoteCellCompensationError"
)<{
  readonly cellId?: string;
  readonly message: string;
}> {}

/**
 * ExportSecretLeakageError (S15 / OPR-FULL-045):
 * Sovereign export aborted because credentials, private keys, or raw secrets were detected.
 */
export class ExportSecretLeakageError extends Data.TaggedError(
  "ExportSecretLeakageError"
)<{
  readonly detectedKeys: readonly string[];
  readonly message: string;
  readonly tenantId: string;
}> {}

/**
 * RestoreIntegrityMismatchError (S15 / OPR-FULL-045):
 * Sovereign restore rejected because bundle checksum does not match computed checksum.
 */
export class RestoreIntegrityMismatchError extends Data.TaggedError(
  "RestoreIntegrityMismatchError"
)<{
  readonly actualChecksum: string;
  readonly expectedChecksum: string;
  readonly exportId: string;
  readonly message: string;
}> {}

/**
 * RestoreSideEffectReplayForbiddenError (S15 / OPR-FULL-045 / FULL-ACC-045):
 * Restore pipeline detected an attempt to re-dispatch historical notifications or outbox items.
 */
export class RestoreSideEffectReplayForbiddenError extends Data.TaggedError(
  "RestoreSideEffectReplayForbiddenError"
)<{
  readonly attemptedEffectType: string;
  readonly message: string;
  readonly restoreId: string;
}> {}

/**
 * SplitBrainWriterFencedError (S16 / OPR-FULL-047 / FULL-ACC-047):
 * Writer process was fenced out by a higher fencing token holder after failover.
 */
export class SplitBrainWriterFencedError extends Data.TaggedError(
  "SplitBrainWriterFencedError"
)<{
  readonly activeFenceToken: number;
  readonly currentHolderProcessId: string;
  readonly message: string;
  readonly presentedFenceToken: number;
  readonly rejectedProcessId: string;
  readonly tenantId: string;
}> {}

/**
 * ProductionInMemoryAuthorityForbiddenError (S16):
 * Production deployment profile prohibited from using in-memory authority.
 */
export class ProductionInMemoryAuthorityForbiddenError extends Data.TaggedError(
  "ProductionInMemoryAuthorityForbiddenError"
)<{
  readonly message: string;
  readonly profile: string;
  readonly tenantId: string;
}> {}

/**
 * ProductionSimulatedDispatcherForbiddenError (S16):
 * Production deployment profile prohibited from running simulated dispatchers.
 */
export class ProductionSimulatedDispatcherForbiddenError extends Data.TaggedError(
  "ProductionSimulatedDispatcherForbiddenError"
)<{
  readonly message: string;
  readonly profile: string;
  readonly tenantId: string;
}> {}

/**
 * ProductionTenantInvalidError (S16):
 * Production deployment profile requires an explicit non-test/non-default tenant ID.
 */
export class ProductionTenantInvalidError extends Data.TaggedError(
  "ProductionTenantInvalidError"
)<{
  readonly message: string;
  readonly profile: string;
  readonly tenantId: string;
}> {}

/**
 * BackupAuditIntegrityError (S16 / OPR-FULL-049 / FULL-ACC-049):
 * Backup audit ledger hash chain verification failed (broken link, truncation, or payload tampering).
 */
export class BackupAuditIntegrityError extends Data.TaggedError(
  "BackupAuditIntegrityError"
)<{
  readonly actualHash: string;
  readonly backupId: string;
  readonly blockIndex: number;
  readonly expectedHash: string;
  readonly message: string;
}> {}

/**
 * SigningKeyInvalidError (S16):
 * Cryptographic verification failed because key is revoked, expired, or unknown.
 */
export class SigningKeyInvalidError extends Data.TaggedError(
  "SigningKeyInvalidError"
)<{
  readonly keyId: string;
  readonly message: string;
  readonly reason: "UNKNOWN_KEY" | "REVOKED_KEY" | "EXPIRED_KEY";
}> {}

/**
 * UnconfinedProcessActionError (S16):
 * Process attempted broad unconfined cleanup or destruction outside tracked owned resources.
 */
export class UnconfinedProcessActionError extends Data.TaggedError(
  "UnconfinedProcessActionError"
)<{
  readonly action: string;
  readonly message: string;
  readonly targetPattern: string;
}> {}

/**
 * TenantQuotaExceededError (S16 / OPR-FULL-048 / FULL-ACC-048):
 * Tenant exceeded allocated resource quota (concurrency, rate limit, or spend budget).
 */
export class TenantQuotaExceededError extends Data.TaggedError(
  "TenantQuotaExceededError"
)<{
  readonly currentValue: number;
  readonly limitValue: number;
  readonly message: string;
  readonly quotaType: "CONCURRENCY" | "RATE_LIMIT" | "BUDGET_EXHAUSTED";
  readonly tenantId: string;
}> {}

/**
 * RegionalLocalityViolationError (S16 / OPR-FULL-050 / FULL-ACC-050):
 * Attempted data routing or egress outside authorized sovereign regional boundaries.
 */
export class RegionalLocalityViolationError extends Data.TaggedError(
  "RegionalLocalityViolationError"
)<{
  readonly allowedRegions: readonly string[];
  readonly attemptedRegion: string;
  readonly channel:
    | "MODEL_INVOCATION"
    | "LOG_EXPORT"
    | "BACKUP_TRANSFER"
    | "ARTIFACT_EGRESS";
  readonly message: string;
  readonly tenantId: string;
}> {}
