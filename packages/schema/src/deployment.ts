import { Schema } from "effect";

/**
 * Standard deployment profiles recognized by Operon (S16)
 */
export const DeploymentProfileSchema = Schema.Literals([
  "LOCAL_DEMO",
  "LOCAL_PERSISTENT",
  "REFERENCE_PRODUCTION_CELL",
  "QUALIFIED_CLOUD_PROVIDER",
  "DEDICATED_SOVEREIGN",
]);

export type DeploymentProfile = Schema.Schema.Type<
  typeof DeploymentProfileSchema
>;

/**
 * Underlying storage engine types (S16)
 */
export const StorageEngineTypeSchema = Schema.Literals([
  "MEMORY",
  "SQLITE",
  "POSTGRESQL",
]);

export type StorageEngineType = Schema.Schema.Type<
  typeof StorageEngineTypeSchema
>;

/**
 * Authority lease mode (S16)
 * In-memory is prohibited in production cells.
 */
export const AuthorityModeSchema = Schema.Literals([
  "IN_MEMORY",
  "DURABLE_LEASE",
  "DISTRIBUTED_FENCED",
]);

export type AuthorityMode = Schema.Schema.Type<typeof AuthorityModeSchema>;

/**
 * Deployment profile configuration (S16)
 */
export const DeploymentConfigurationSchema = Schema.Struct({
  authorityMode: AuthorityModeSchema,
  environmentId: Schema.String,
  profile: DeploymentProfileSchema,
  simulatedDispatcher: Schema.Boolean,
  storageEngine: StorageEngineTypeSchema,
  tenantId: Schema.String,
  unsupportedGuarantees: Schema.Array(Schema.String),
});

export type DeploymentConfiguration = Schema.Schema.Type<
  typeof DeploymentConfigurationSchema
>;

/**
 * Active writer fencing lease per tenant (S16, OPR-FULL-047)
 */
export const WriterFencingLeaseSchema = Schema.Struct({
  acquiredAt: Schema.Number,
  epoch: Schema.Number,
  fencingToken: Schema.Number,
  holderProcessId: Schema.String,
  leaseExpiresAt: Schema.Number,
  tenantId: Schema.String,
});

export type WriterFencingLease = Schema.Schema.Type<
  typeof WriterFencingLeaseSchema
>;

/**
 * Receipt proving fenced effect dispatch (OPR-FULL-047)
 */
export const FencedEffectReceiptSchema = Schema.Struct({
  dispatchedAt: Schema.String,
  effectId: Schema.String,
  fencingToken: Schema.Number,
  processId: Schema.String,
  status: Schema.Literals(["DISPATCHED", "REJECTED_FENCED"]),
  tenantId: Schema.String,
});

export type FencedEffectReceipt = Schema.Schema.Type<
  typeof FencedEffectReceiptSchema
>;
