import { Schema } from "effect";

/**
 * Transport mechanisms for inbound and outbound connectors (S15)
 */
export const ConnectorTransportTypeSchema = Schema.Literals([
  "CDC",
  "POLLING",
  "WEBHOOK",
  "MESSAGE_QUEUE",
  "BATCH_TABULAR",
  "REST_API",
]);

export type ConnectorTransportType = Schema.Schema.Type<
  typeof ConnectorTransportTypeSchema
>;

/**
 * Isolation levels supported by storage and operational connectors (S15)
 */
export const ConnectorIsolationLevelSchema = Schema.Literals([
  "READ_COMMITTED",
  "REPEATABLE_READ",
  "SERIALIZABLE",
  "NONE",
]);

export type ConnectorIsolationLevel = Schema.Schema.Type<
  typeof ConnectorIsolationLevelSchema
>;

/**
 * Declared capabilities and guarantees of a contracted connector (S15, OPR-FULL-043)
 */
export const ConnectorCapabilityProfileSchema = Schema.Struct({
  isolationLevel: ConnectorIsolationLevelSchema,
  maxBatchSize: Schema.Number,
  sourceFreshnessIntervalMs: Schema.Number,
  supportsAtomicBatch: Schema.Boolean,
  supportsChangeDataCapture: Schema.Boolean,
  supportsCompensatingActions: Schema.Boolean,
  supportsConditionalWrites: Schema.Boolean,
  supportsIdempotencyKeys: Schema.Boolean,
});

export type ConnectorCapabilityProfile = Schema.Schema.Type<
  typeof ConnectorCapabilityProfileSchema
>;

/**
 * Full contract declaration for an inbound/outbound connector (S15, OPR-FULL-043)
 */
export const ConnectorContractDeclarationSchema = Schema.Struct({
  capabilities: ConnectorCapabilityProfileSchema,
  connectorId: Schema.String,
  connectorVersion: Schema.String,
  credentialIsolationBoundary: Schema.Literals([
    "BROKER_WORKER",
    "SANDBOX_EXTERNAL",
  ]),
  sourceSystem: Schema.String,
  transport: ConnectorTransportTypeSchema,
});

export type ConnectorContractDeclaration = Schema.Schema.Type<
  typeof ConnectorContractDeclarationSchema
>;

/**
 * Required connector guarantees demanded by a domain package or workflow (OPR-FULL-043)
 */
export const PackageConnectorRequirementSchema = Schema.Struct({
  packageId: Schema.String,
  requiredCapabilities: Schema.Struct({
    supportsAtomicBatch: Schema.optional(Schema.Boolean),
    supportsChangeDataCapture: Schema.optional(Schema.Boolean),
    supportsCompensatingActions: Schema.optional(Schema.Boolean),
    supportsConditionalWrites: Schema.optional(Schema.Boolean),
    supportsIdempotencyKeys: Schema.optional(Schema.Boolean),
  }),
});

export type PackageConnectorRequirement = Schema.Schema.Type<
  typeof PackageConnectorRequirementSchema
>;

/**
 * Outbound operation declaration with broker credential boundary and compensation (OPR-FULL-044)
 */
export const OutboundOperationDeclarationSchema = Schema.Struct({
  actionName: Schema.String,
  compensationAction: Schema.optional(Schema.String),
  idempotencyKeyField: Schema.String,
  operationId: Schema.String,
  requiresBusinessGrant: Schema.Boolean,
  retryable: Schema.Boolean,
  timeoutMs: Schema.Number,
});

export type OutboundOperationDeclaration = Schema.Schema.Type<
  typeof OutboundOperationDeclarationSchema
>;

/**
 * Receipt emitted upon executing or compensating an outbound operation (OPR-FULL-044)
 */
export const OutboundInvocationReceiptSchema = Schema.Struct({
  dispatchedAt: Schema.Number,
  idempotencyKey: Schema.String,
  operationId: Schema.String,
  receiptDigest: Schema.String,
  status: Schema.Literals(["EXECUTED", "COMPENSATED", "FAILED"]),
  targetSystem: Schema.String,
});

export type OutboundInvocationReceipt = Schema.Schema.Type<
  typeof OutboundInvocationReceiptSchema
>;
