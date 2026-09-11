import { Schema } from "effect";

/**
 * Quota violation classification (S16, OPR-FULL-048)
 */
export const QuotaTypeSchema = Schema.Literal(
  "CONCURRENCY",
  "RATE_LIMIT",
  "BUDGET_EXHAUSTED"
);

export type QuotaType = Schema.Schema.Type<typeof QuotaTypeSchema>;

/**
 * Locality channel subject to sovereign regional boundary fences (S16, OPR-FULL-050)
 */
export const LocalityChannelSchema = Schema.Literal(
  "MODEL_INVOCATION",
  "LOG_EXPORT",
  "BACKUP_TRANSFER",
  "ARTIFACT_EGRESS"
);

export type LocalityChannel = Schema.Schema.Type<typeof LocalityChannelSchema>;

/**
 * Tenant resource quota and guaranteed capacity policy (S16, OPR-FULL-048)
 */
export const TenantQuotaPolicySchema = Schema.Struct({
  guaranteedCapacityMissions: Schema.Number,
  maxConcurrentMissions: Schema.Number,
  maxRatePerMinute: Schema.Number,
  spendBudgetCents: Schema.Number,
  tenantId: Schema.String,
});

export type TenantQuotaPolicy = Schema.Schema.Type<
  typeof TenantQuotaPolicySchema
>;

/**
 * Sovereign regional boundary and data residency policy (S16, OPR-FULL-050)
 */
export const LocalityPolicySchema = Schema.Struct({
  allowedRegions: Schema.Array(Schema.String),
  enforceStrictLocality: Schema.Boolean,
  tenantId: Schema.String,
});

export type LocalityPolicy = Schema.Schema.Type<typeof LocalityPolicySchema>;

/**
 * Transactional mission capacity reservation token (S16)
 */
export const MissionCapacityReservationSchema = Schema.Struct({
  reservationId: Schema.String,
  reservedAt: Schema.Number,
  status: Schema.Literal("ACTIVE", "RELEASED", "EXPIRED"),
  tenantId: Schema.String,
});

export type MissionCapacityReservation = Schema.Schema.Type<
  typeof MissionCapacityReservationSchema
>;

/**
 * Measured contention, queue backlog, and capacity isolation report (S16, FULL-ACC-048)
 */
export const TenantContentionReportSchema = Schema.Struct({
  activeMissions: Schema.Number,
  guaranteedCapacityPreserved: Schema.Boolean,
  queuedMissions: Schema.Number,
  tenantId: Schema.String,
  throttledCount: Schema.Number,
  totalSpendCents: Schema.Number,
});

export type TenantContentionReport = Schema.Schema.Type<
  typeof TenantContentionReportSchema
>;
