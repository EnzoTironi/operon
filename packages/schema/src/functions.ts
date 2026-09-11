import { Schema } from "effect";

/**
 * Caller execution context for pure typed read functions (OPR-FUN-001)
 */
export const FunctionExecutionContext = Schema.Struct({
  callerId: Schema.String,
  callerPermissions: Schema.Array(Schema.String),
  correlationId: Schema.String,
  tenantId: Schema.String,
});
export type FunctionExecutionContext = Schema.Schema.Type<
  typeof FunctionExecutionContext
>;

/**
 * Dependency record for tracking materialized output lineage (OPR-FUN-003)
 */
export const DependencyRecord = Schema.Struct({
  entityId: Schema.String,
  recordedAt: Schema.Number,
  version: Schema.Union([Schema.String, Schema.Number]),
});
export type DependencyRecord = Schema.Schema.Type<typeof DependencyRecord>;

/**
 * Materialized output record preserving source and logic lineage (OPR-FUN-003)
 */
export const MaterializedOutputRecord = Schema.Struct({
  computedAt: Schema.Number,
  dependencies: Schema.Array(DependencyRecord),
  functionId: Schema.String,
  inputHash: Schema.String,
  isStale: Schema.Boolean,
  logicVersion: Schema.String,
  outputId: Schema.String,
  result: Schema.Unknown,
});
export type MaterializedOutputRecord = Schema.Schema.Type<
  typeof MaterializedOutputRecord
>;

/**
 * Model applicability envelope defining scope boundaries (OPR-FUN-004)
 */
export const ApplicabilityEnvelope = Schema.Struct({
  allowedFeatures: Schema.Array(Schema.String),
  domain: Schema.String,
  featureRanges: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        max: Schema.optional(Schema.Number),
        min: Schema.optional(Schema.Number),
      })
    )
  ),
  targetEntities: Schema.Array(Schema.String),
});
export type ApplicabilityEnvelope = Schema.Schema.Type<
  typeof ApplicabilityEnvelope
>;

/**
 * Governed model release status (OPR-FUN-004)
 */
export const ModelReleaseStatus = Schema.Literals([
  "DRAFT",
  "STAGED",
  "RELEASED",
  "DEPRECATED",
]);
export type ModelReleaseStatus = Schema.Schema.Type<typeof ModelReleaseStatus>;

/**
 * Governed model definition record (OPR-FUN-004)
 */
export const ModelDefinitionRecord = Schema.Struct({
  applicabilityEnvelope: ApplicabilityEnvelope,
  evaluationEvidence: Schema.Struct({
    benchmarkScore: Schema.Number,
    evalSuiteVersion: Schema.String,
    passed: Schema.Boolean,
  }),
  modelId: Schema.String,
  releasedAt: Schema.optional(Schema.Number),
  status: ModelReleaseStatus,
  version: Schema.String,
});
export type ModelDefinitionRecord = Schema.Schema.Type<
  typeof ModelDefinitionRecord
>;

/**
 * Six-part prediction contract (OPR-FUN-005):
 * 1. value: predicted outcome/classification/payload
 * 2. uncertainty: confidence and interval (separated from readiness)
 * 3. inputSnapshot: exact snapshot of inputs used
 * 4. versionChain: model ID, version, and logic hash
 * 5. scopeCheck: applicability envelope check
 * 6. readiness: 4C decision readiness check
 */
export const SixPartPrediction = Schema.Struct({
  inputSnapshot: Schema.Record(Schema.String, Schema.Unknown),
  readiness: Schema.Struct({
    complete: Schema.Boolean,
    consistent: Schema.Boolean,
    correct: Schema.Boolean,
    current: Schema.Boolean,
    isReady: Schema.Boolean,
    missingProperties: Schema.Array(Schema.String),
    staleProperties: Schema.Array(Schema.String),
  }),
  scopeCheck: Schema.Struct({
    inScope: Schema.Boolean,
    reason: Schema.optional(Schema.String),
  }),
  uncertainty: Schema.Struct({
    confidence: Schema.Number,
    distributionType: Schema.optional(Schema.String),
    interval: Schema.optional(
      Schema.Struct({
        lower: Schema.Number,
        upper: Schema.Number,
      })
    ),
  }),
  value: Schema.Unknown,
  versionChain: Schema.Struct({
    logicHash: Schema.String,
    modelId: Schema.String,
    promptReleaseId: Schema.optional(Schema.String),
    version: Schema.String,
  }),
});
export type SixPartPrediction = Schema.Schema.Type<typeof SixPartPrediction>;

/**
 * Calibration and override metric record (OPR-FUN-006)
 */
export const CalibrationMetricRecord = Schema.Struct({
  calculatedAt: Schema.Number,
  calibrationScore: Schema.Number,
  deterministicOverrides: Schema.Number,
  metricId: Schema.String,
  modelId: Schema.String,
  modelVersion: Schema.String,
  observedAgreements: Schema.Number,
  totalPredictions: Schema.Number,
});
export type CalibrationMetricRecord = Schema.Schema.Type<
  typeof CalibrationMetricRecord
>;
