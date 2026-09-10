import { Schema } from "effect";

import { computeCanonicalDigest } from "./definition.js";
import { ObjectInstanceSchema } from "./object-type.js";
import { WorldViewSchema } from "./reconciliation.js";
import { DecisionVerdictSchema, SubjectSchema } from "./security.js";

/**
 * TaskMandate (S06 / D-CONS-01):
 * Authorized outcome with constraints and an issuer.
 */
export const TaskMandateSchema = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  issuerId: Schema.String,
  authorizedOutcome: Schema.String,
  constraints: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type TaskMandate = Schema.Schema.Type<typeof TaskMandateSchema>;

/**
 * IntentGrant (S06 / D-CONS-01):
 * Enforceable delegation of a subset of a mandate to an actor or service.
 */
export const IntentGrantSchema = Schema.Struct({
  id: Schema.String,
  mandateId: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  actorId: Schema.String,
  purpose: Schema.String,
  version: Schema.String,
  eligibleActions: Schema.Array(Schema.String),
  eligibleResources: Schema.Array(Schema.String),
  dataUseConditions: Schema.Array(Schema.String),
  destinationAudiences: Schema.Array(Schema.String),
  budget: Schema.Struct({
    maxReservations: Schema.Number,
    committedReservations: Schema.Number,
  }),
  expiresAt: Schema.Number,
  revocationEpoch: Schema.Number,
  createdAt: Schema.Number,
});
export type IntentGrant = Schema.Schema.Type<typeof IntentGrantSchema>;

/**
 * Pinned object revision reference during preparation
 */
export const ObjectRevisionRefSchema = Schema.Struct({
  objectId: Schema.String,
  typeId: Schema.String,
  revision: Schema.Number,
  propertyRevisions: Schema.optional(
    Schema.Record(Schema.String, Schema.Number)
  ),
});
export type ObjectRevisionRef = Schema.Schema.Type<
  typeof ObjectRevisionRefSchema
>;

/**
 * Evaluated predicate / criterion dependency
 */
export const PredicateDependencySchema = Schema.Struct({
  criterionId: Schema.String,
  description: Schema.String,
  passed: Schema.Boolean,
  verdict: Schema.optional(DecisionVerdictSchema),
});
export type PredicateDependency = Schema.Schema.Type<
  typeof PredicateDependencySchema
>;

/**
 * Evidence closure item binding provenance digests
 */
export const EvidenceClosureItemSchema = Schema.Struct({
  evidenceId: Schema.String,
  digest: Schema.String,
  description: Schema.String,
  recordedAt: Schema.Number,
});
export type EvidenceClosureItem = Schema.Schema.Type<
  typeof EvidenceClosureItemSchema
>;

/**
 * Declared requested effect for an action
 */
export const RequestedEffectSchema = Schema.Struct({
  effectId: Schema.String,
  description: Schema.String,
  mutationTypes: Schema.optional(Schema.Array(Schema.String)),
  isLiveExternal: Schema.Boolean,
});
export type RequestedEffect = Schema.Schema.Type<typeof RequestedEffectSchema>;

/**
 * Usage reservation required for execution
 */
export const UsageReservationSchema = Schema.Struct({
  resource: Schema.String,
  amount: Schema.Number,
});
export type UsageReservation = Schema.Schema.Type<
  typeof UsageReservationSchema
>;

/**
 * Distinct check execution record during preparation preview
 */
export const ActionCheckResultSchema = Schema.Struct({
  checkId: Schema.String,
  name: Schema.String,
  executed: Schema.Boolean,
  status: Schema.Literals(["passed", "failed", "needs_execution_revalidation"]),
  reason: Schema.optional(Schema.String),
});
export type ActionCheckResult = Schema.Schema.Type<
  typeof ActionCheckResultSchema
>;

/**
 * PreparedAction (S07 / D-CONS-01):
 * Normalized proposal with release, evidence closure, and canonical digest.
 * Zero business side effects during preparation.
 */
export const PreparedActionSchema = Schema.Struct({
  id: Schema.String,
  actionId: Schema.String,
  actionRelease: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  proposer: SubjectSchema,
  grantId: Schema.optional(Schema.String),
  normalizedParameters: Schema.Record(Schema.String, Schema.Unknown),
  objectRevisions: Schema.Array(ObjectRevisionRefSchema),
  predicateDependencies: Schema.Array(PredicateDependencySchema),
  evidenceClosure: Schema.Array(EvidenceClosureItemSchema),
  requestedEffects: Schema.Array(RequestedEffectSchema),
  intendedRecipients: Schema.Array(Schema.String),
  usageReservations: Schema.Array(UsageReservationSchema),
  worldView: WorldViewSchema,
  verdict: DecisionVerdictSchema,
  reviewReasons: Schema.optional(Schema.Array(Schema.String)),
  checks: Schema.Array(ActionCheckResultSchema),
  preparedAt: Schema.Number,
  expiresAt: Schema.Number,
  canonicalDigest: Schema.String,
});
export type PreparedAction = Schema.Schema.Type<typeof PreparedActionSchema>;

export function computePreparedActionDigest(
  actionWithoutDigest: Omit<PreparedAction, "canonicalDigest">
): string {
  return computeCanonicalDigest(actionWithoutDigest);
}

/**
 * Reviewer Context (S06 / S07)
 */
export const ReviewerContextSchema = Schema.Struct({
  reviewer: SubjectSchema,
  tenantId: Schema.String,
  environmentId: Schema.String,
  assurance: Schema.Literals(["human_verified", "delegated_service"]),
  purpose: Schema.optional(Schema.String),
});
export type ReviewerContext = Schema.Schema.Type<typeof ReviewerContextSchema>;

/**
 * ApprovalRecord (S07):
 * Binds reviewer identity, exact viewed bundle digest, and release versions.
 */
export const ApprovalRecordSchema = Schema.Struct({
  id: Schema.String,
  preparedId: Schema.String,
  preparedDigest: Schema.String,
  viewedDigest: Schema.String,
  decision: Schema.Literals(["approved", "rejected"]),
  reviewerContext: ReviewerContextSchema,
  actionRelease: Schema.String,
  policyRelease: Schema.String,
  approvedAt: Schema.Number,
  expiresAt: Schema.Number,
  reason: Schema.optional(Schema.String),
  recordHash: Schema.String,
});
export type ApprovalRecord = Schema.Schema.Type<typeof ApprovalRecordSchema>;

export function computeApprovalRecordHash(
  recordWithoutHash: Omit<ApprovalRecord, "recordHash">
): string {
  return computeCanonicalDigest(recordWithoutHash);
}

/**
 * Operation state machine per S08
 */
export const OperationStatusSchema = Schema.Literals([
  "PREPARED",
  "COMMITTED",
  "DISPATCH_PENDING",
  "DISPATCHING",
  "SUCCEEDED",
  "EXTERNAL_UNKNOWN",
  "RECONCILING",
  "FAILED",
  "PARTIALLY_APPLIED",
  "COMPENSATION_PENDING",
  "COMPENSATED",
  "COMPENSATION_FAILED",
]);
export type OperationStatus = Schema.Schema.Type<typeof OperationStatusSchema>;

/**
 * Outbox item for durable side effect delivery (S08)
 */
export const OutboxItemSchema = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  operationId: Schema.String,
  command: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.Literals([
    "pending",
    "in_flight",
    "succeeded",
    "failed",
    "external_unknown",
  ]),
  attemptCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  error: Schema.optional(Schema.String),
});
export type OutboxItem = Schema.Schema.Type<typeof OutboxItemSchema>;

/**
 * OperationReceipt (S08):
 * Atomic receipt of committed business state, decision, approval consumption,
 * reservation, and outbox.
 */
export const OperationReceiptSchema = Schema.Struct({
  operationId: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  actionId: Schema.String,
  preparedDigest: Schema.String,
  approvalId: Schema.optional(Schema.String),
  status: OperationStatusSchema,
  idempotencyKey: Schema.String,
  updatedObjects: Schema.Array(ObjectInstanceSchema),
  decisionRecordId: Schema.String,
  outboxItems: Schema.Array(OutboxItemSchema),
  committedAt: Schema.Number,
  receiptDigest: Schema.String,
});
export type OperationReceipt = Schema.Schema.Type<
  typeof OperationReceiptSchema
>;

export function computeOperationReceiptDigest(
  receiptWithoutDigest: Omit<OperationReceipt, "receiptDigest">
): string {
  return computeCanonicalDigest(receiptWithoutDigest);
}

/**
 * Compute RFC 8785 canonical digest of normalized action effects (S07 / V1-04)
 */
export function computeEffectDigest(effects: {
  readonly actionId: string;
  readonly normalizedParameters: Record<string, unknown>;
  readonly requestedEffects?: readonly RequestedEffect[];
  readonly intendedRecipients?: readonly string[];
}): string {
  return computeCanonicalDigest({
    actionId: effects.actionId,
    intendedRecipients: effects.intendedRecipients ?? [],
    normalizedParameters: effects.normalizedParameters,
    requestedEffects: effects.requestedEffects ?? [],
  });
}

/**
 * ActionProposal (S07 / V1-04):
 * Immutable durable proposal binding normalized parameters, releases,
 * evidence closure, requested effects, and canonical digests.
 */
export const ActionProposalSchema = Schema.Struct({
  id: Schema.String,
  actionId: Schema.String,
  actionRelease: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  proposer: SubjectSchema,
  grantId: Schema.optional(Schema.String),
  normalizedParameters: Schema.Record(Schema.String, Schema.Unknown),
  objectRevisions: Schema.Array(ObjectRevisionRefSchema),
  predicateDependencies: Schema.Array(PredicateDependencySchema),
  evidenceClosure: Schema.Array(EvidenceClosureItemSchema),
  requestedEffects: Schema.Array(RequestedEffectSchema),
  intendedRecipients: Schema.Array(Schema.String),
  usageReservations: Schema.Array(UsageReservationSchema),
  worldView: WorldViewSchema,
  verdict: DecisionVerdictSchema,
  reviewReasons: Schema.optional(Schema.Array(Schema.String)),
  checks: Schema.Array(ActionCheckResultSchema),
  effectDigest: Schema.String,
  canonicalDigest: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type ActionProposal = Schema.Schema.Type<typeof ActionProposalSchema>;

export function computeActionProposalDigest(
  proposalWithoutDigest: Omit<ActionProposal, "canonicalDigest">
): string {
  return computeCanonicalDigest(proposalWithoutDigest);
}

/**
 * ApprovalReceipt (S07 / V1-04):
 * Durable receipt produced when an authorized principal approves a proposal,
 * binding exact normalized proposal, releases, evidence, and effect digest.
 */
export const ApprovalReceiptSchema = Schema.Struct({
  id: Schema.String,
  proposalId: Schema.String,
  expectedDigest: Schema.String,
  effectDigest: Schema.String,
  proposalDigest: Schema.String,
  decision: Schema.Literals(["approved", "rejected"]),
  principal: SubjectSchema,
  actionRelease: Schema.String,
  policyRelease: Schema.String,
  approvedAt: Schema.Number,
  expiresAt: Schema.Number,
  reason: Schema.optional(Schema.String),
  receiptHash: Schema.String,
});
export type ApprovalReceipt = Schema.Schema.Type<typeof ApprovalReceiptSchema>;

export function computeApprovalReceiptHash(
  receiptWithoutHash: Omit<ApprovalReceipt, "receiptHash">
): string {
  return computeCanonicalDigest(receiptWithoutHash);
}
