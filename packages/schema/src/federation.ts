import { Schema } from "effect";

/**
 * Uncertainty status of a remote federated claim (S15, OPR-FULL-046)
 */
export const FederatedUncertaintyStatusSchema = Schema.Literals([
  "FRESH",
  "STALE",
  "UNREACHABLE",
  "DISPUTED",
]);

export type FederatedUncertaintyStatus = Schema.Schema.Type<
  typeof FederatedUncertaintyStatusSchema
>;

/**
 * Metadata capturing remote freshness, verification, and partition uncertainty (S15)
 */
export const FederatedUncertaintyMetadataSchema = Schema.Struct({
  freshnessDeadlineMs: Schema.optional(Schema.Number),
  lastVerifiedAt: Schema.optional(Schema.String),
  reconciliationNotes: Schema.optional(Schema.String),
  status: FederatedUncertaintyStatusSchema,
});

export type FederatedUncertaintyMetadata = Schema.Schema.Type<
  typeof FederatedUncertaintyMetadataSchema
>;

/**
 * Attribution of a federated claim to its source cell authority (S15, OPR-FULL-046)
 */
export const FederatedClaimAttributionSchema = Schema.Struct({
  assertedAt: Schema.String,
  sourceAuthority: Schema.String,
  sourceCellId: Schema.String,
  sourceSignature: Schema.optional(Schema.String),
});

export type FederatedClaimAttribution = Schema.Schema.Type<
  typeof FederatedClaimAttributionSchema
>;

/**
 * Remote claim received across federation boundaries (S15, OPR-FULL-046)
 */
export const FederatedRemoteClaimSchema = Schema.Struct({
  attribution: FederatedClaimAttributionSchema,
  claimId: Schema.String,
  claimType: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  subjectEntityId: Schema.String,
  targetCellId: Schema.String,
  uncertainty: FederatedUncertaintyMetadataSchema,
});

export type FederatedRemoteClaim = Schema.Schema.Type<
  typeof FederatedRemoteClaimSchema
>;

/**
 * Contract governing selective view sharing between cells (S15, OPR-FULL-044)
 */
export const FederatedViewContractSchema = Schema.Struct({
  allowedLinkRelations: Schema.Array(Schema.String),
  allowedProperties: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  allowedPurposes: Schema.Array(Schema.String),
  allowedSchemaTypes: Schema.Array(Schema.String),
  contractId: Schema.String,
  revoked: Schema.Boolean,
  sourceCellId: Schema.String,
  targetCellId: Schema.String,
  tenantId: Schema.String,
  validityWindow: Schema.optional(
    Schema.Struct({
      validFrom: Schema.String,
      validUntil: Schema.String,
    })
  ),
});

export type FederatedViewContract = Schema.Schema.Type<
  typeof FederatedViewContractSchema
>;

/**
 * Action specification for a multi-cell saga step or compensation (OPR-FULL-046)
 */
export const MultiCellStepActionSchema = Schema.Struct({
  actionName: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});

export type MultiCellStepAction = Schema.Schema.Type<
  typeof MultiCellStepActionSchema
>;

/**
 * Step in a multi-cell operation with optional compensating action (OPR-FULL-046)
 */
export const MultiCellOperationStepSchema = Schema.Struct({
  actionName: Schema.String,
  cellId: Schema.String,
  compensatingAction: Schema.optional(MultiCellStepActionSchema),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  stepId: Schema.String,
  timeoutMs: Schema.optional(Schema.Number),
});

export type MultiCellOperationStep = Schema.Schema.Type<
  typeof MultiCellOperationStepSchema
>;

/**
 * Coordinated multi-cell operation plan (OPR-FULL-046)
 */
export const MultiCellOperationPlanSchema = Schema.Struct({
  coordinatorCellId: Schema.String,
  operationId: Schema.String,
  steps: Schema.Array(MultiCellOperationStepSchema),
  tenantId: Schema.String,
  timeoutMs: Schema.Number,
});

export type MultiCellOperationPlan = Schema.Schema.Type<
  typeof MultiCellOperationPlanSchema
>;

/**
 * Result of executing an individual step in a multi-cell operation (OPR-FULL-046)
 */
export const MultiCellStepResultSchema = Schema.Struct({
  cellId: Schema.String,
  error: Schema.optional(Schema.String),
  executedAt: Schema.String,
  receiptId: Schema.optional(Schema.String),
  status: Schema.Literals([
    "COMMITTED",
    "FAILED",
    "UNREACHABLE",
    "COMPENSATED",
    "COMPENSATION_FAILED",
  ]),
  stepId: Schema.String,
});

export type MultiCellStepResult = Schema.Schema.Type<
  typeof MultiCellStepResultSchema
>;

/**
 * Full outcome of a multi-cell saga execution (OPR-FULL-046)
 * Note: globalCommitPromised is strictly false — Operon never invents a fictional global commit across independent cells.
 */
export const MultiCellSagaOutcomeSchema = Schema.Struct({
  globalCommitPromised: Schema.Literal(false),
  operationId: Schema.String,
  remotePendingClaims: Schema.Array(FederatedRemoteClaimSchema),
  status: Schema.Literals([
    "COMPLETED",
    "PARTIALLY_FAILED_COMPENSATED",
    "COMPENSATION_FAILED",
    "PENDING_RECONCILIATION",
  ]),
  stepResults: Schema.Array(MultiCellStepResultSchema),
});

export type MultiCellSagaOutcome = Schema.Schema.Type<
  typeof MultiCellSagaOutcomeSchema
>;
