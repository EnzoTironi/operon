import { Schema } from "effect";

/**
 * Hash chain block recording sequential ledger commitments (S16, OPR-FULL-049)
 */
export const AuditHashBlockSchema = Schema.Struct({
  blockIndex: Schema.Number,
  currentHash: Schema.String,
  operationId: Schema.String,
  payloadHash: Schema.String,
  previousHash: Schema.String,
  timestamp: Schema.Number,
});

export type AuditHashBlock = Schema.Schema.Type<typeof AuditHashBlockSchema>;

/**
 * Audited backup package containing data, definitions, receipts, and ledger hash chain (OPR-FULL-049)
 */
export const AuditedBackupPackageSchema = Schema.Struct({
  backupId: Schema.String,
  canonicalEntities: Schema.Array(Schema.Unknown),
  checkpointHash: Schema.String,
  createdAt: Schema.Number,
  decisions: Schema.Array(Schema.Unknown),
  definitions: Schema.Array(Schema.Unknown),
  hashChain: Schema.Array(AuditHashBlockSchema),
  receipts: Schema.Array(Schema.Unknown),
  sourceCellId: Schema.String,
  tenantId: Schema.String,
});

export type AuditedBackupPackage = Schema.Schema.Type<
  typeof AuditedBackupPackageSchema
>;

/**
 * Measured recovery metrics validating restore against declared RPO/RTO objectives (S16, FULL-ACC-049)
 */
export const RecoveryMetricsReportSchema = Schema.Struct({
  backupId: Schema.String,
  blocksVerified: Schema.Number,
  hashChainValid: Schema.Boolean,
  measuredRpoMs: Schema.Number,
  measuredRtoMs: Schema.Number,
  qualificationPassed: Schema.Boolean,
  reconciledEntityCount: Schema.Number,
  restoredAt: Schema.String,
  rpoObjectiveMs: Schema.Number,
  rtoObjectiveMs: Schema.Number,
  slaCompliant: Schema.Boolean,
  targetCellId: Schema.String,
  tenantId: Schema.String,
});

export type RecoveryMetricsReport = Schema.Schema.Type<
  typeof RecoveryMetricsReportSchema
>;

/**
 * Descriptor for cryptographic signing keys supporting zero-downtime rotation (S16)
 */
export const SigningKeyDescriptorSchema = Schema.Struct({
  algorithm: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.optional(Schema.Number),
  keyId: Schema.String,
  publicKey: Schema.String,
  revoked: Schema.Boolean,
});

export type SigningKeyDescriptor = Schema.Schema.Type<
  typeof SigningKeyDescriptorSchema
>;

/**
 * Active key rotation policy with multi-key verification window (S16)
 */
export const KeyRotationPolicySchema = Schema.Struct({
  activeKeyId: Schema.String,
  recognizedKeys: Schema.Array(SigningKeyDescriptorSchema),
  tenantId: Schema.String,
});

export type KeyRotationPolicy = Schema.Schema.Type<
  typeof KeyRotationPolicySchema
>;
