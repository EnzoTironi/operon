import { Schema } from "effect";

/**
 * Metadata for a sovereign export bundle (S15, OPR-FULL-045)
 */
export const SovereignExportMetadataSchema = Schema.Struct({
  checksum: Schema.String,
  decisionCount: Schema.Number,
  entityCount: Schema.Number,
  exportedAt: Schema.String,
  exportId: Schema.String,
  formatVersion: Schema.String,
  receiptCount: Schema.Number,
  sourceCellId: Schema.String,
  tenantId: Schema.String,
});

export type SovereignExportMetadata = Schema.Schema.Type<
  typeof SovereignExportMetadataSchema
>;

/**
 * Canonical exported entity preserving full bitemporal history and identity (OPR-FULL-045)
 */
export const SovereignExportedEntitySchema = Schema.Struct({
  id: Schema.String,
  lastModifiedAt: Schema.Number,
  properties: Schema.Record(Schema.String, Schema.Unknown),
  typeId: Schema.String,
  version: Schema.Number,
});

export type SovereignExportedEntity = Schema.Schema.Type<
  typeof SovereignExportedEntitySchema
>;

/**
 * Exported decision record preserving governance lineage (OPR-FULL-045)
 */
export const SovereignExportedDecisionSchema = Schema.Struct({
  actionId: Schema.String,
  decisionRecordId: Schema.String,
  evaluatedAt: Schema.Number,
  operationId: Schema.String,
  result: Schema.Literals([
    "ALLOW",
    "DENY",
    "REVIEW_REQUIRED",
    "EVIDENCE_INSUFFICIENT",
  ]),
});

export type SovereignExportedDecision = Schema.Schema.Type<
  typeof SovereignExportedDecisionSchema
>;

/**
 * Exported execution receipt preserving immutable outcome proof (OPR-FULL-045)
 */
export const SovereignExportedReceiptSchema = Schema.Struct({
  actionId: Schema.String,
  committedAt: Schema.Number,
  operationId: Schema.String,
  receiptDigest: Schema.String,
  status: Schema.String,
});

export type SovereignExportedReceipt = Schema.Schema.Type<
  typeof SovereignExportedReceiptSchema
>;

/**
 * Exported evidence dossier preserving audit lineage (OPR-FULL-045)
 */
export const SovereignExportedDossierSchema = Schema.Struct({
  dossierId: Schema.String,
  evidenceItems: Schema.Array(Schema.Unknown),
  operationId: Schema.String,
  sealedAt: Schema.String,
});

export type SovereignExportedDossier = Schema.Schema.Type<
  typeof SovereignExportedDossierSchema
>;

/**
 * Sovereign export bundle containing zero credentials or raw secrets (S15, OPR-FULL-045)
 */
export const SovereignExportBundleSchema = Schema.Struct({
  canonicalDefinitions: Schema.Array(Schema.Unknown),
  decisions: Schema.Array(SovereignExportedDecisionSchema),
  entities: Schema.Array(SovereignExportedEntitySchema),
  evidenceDossiers: Schema.Array(SovereignExportedDossierSchema),
  metadata: SovereignExportMetadataSchema,
  receipts: Schema.Array(SovereignExportedReceiptSchema),
  secretsSanitized: Schema.Literal(true),
});

export type SovereignExportBundle = Schema.Schema.Type<
  typeof SovereignExportBundleSchema
>;

/**
 * Report certifying clean, replay-free restore into a target cell (S15, OPR-FULL-045, FULL-ACC-045)
 * Guarantees zero historical notifications or side effects were re-emitted.
 */
export const SovereignRestoreReportSchema = Schema.Struct({
  decisionsRestored: Schema.Number,
  dossiersMatchSource: Schema.Boolean,
  entitiesRestored: Schema.Number,
  historicalNotificationsReplayed: Schema.Literal(0),
  outboxSideEffectsDispatched: Schema.Literal(0),
  queryVerificationPassed: Schema.Boolean,
  receiptsRestored: Schema.Number,
  restoredAt: Schema.String,
  restoreId: Schema.String,
  sourceCellId: Schema.String,
  targetCellId: Schema.String,
  tenantId: Schema.String,
});

export type SovereignRestoreReport = Schema.Schema.Type<
  typeof SovereignRestoreReportSchema
>;
