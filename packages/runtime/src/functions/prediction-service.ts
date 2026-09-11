import { createHash } from "node:crypto";

import { serializeJson } from "@operon/schema";
import type {
  CalibrationMetricRecord,
  ModelDefinitionRecord,
  ObjectInstance,
  ObjectType,
  SixPartPrediction,
} from "@operon/schema";
import { Clock, Context, Effect, Layer } from "effect";

import {
  ModelOutOfScopeError,
  RulePrecedenceViolationError,
} from "../actions-errors.js";
import { evaluateDecisionReadiness } from "../readiness.js";

/**
 * Hard deterministic business rule that overrides model scores (OPR-FUN-006)
 */
export interface HardDeterministicRule {
  readonly ruleId: string;
  readonly description: string;
  readonly check: (input: Record<string, unknown>) => {
    readonly violated: boolean;
    readonly reason?: string;
  };
}

/**
 * Service managing model applicability envelopes, six-part predictions, and rule authority (OPR-FUN-004, 005, 006)
 */
export class PredictionService extends Context.Service<
  PredictionService,
  {
    readonly generateSixPartPrediction: (params: {
      readonly contextInstance?: ObjectInstance;
      readonly hardRules?: readonly HardDeterministicRule[];
      readonly input: Record<string, unknown>;
      readonly modelId: string;
      readonly objectType?: ObjectType;
      readonly promptReleaseId?: string;
      readonly runner: (input: Record<string, unknown>) => Effect.Effect<
        {
          readonly confidence: number;
          readonly explanation?: string;
          readonly interval?: {
            readonly lower: number;
            readonly upper: number;
          };
          readonly value: unknown;
        },
        Error
      >;
    }) => Effect.Effect<
      SixPartPrediction,
      ModelOutOfScopeError | RulePrecedenceViolationError | Error
    >;

    readonly getCalibrationMetrics: (
      modelId: string
    ) => Effect.Effect<CalibrationMetricRecord | undefined>;

    readonly getModelDefinition: (
      modelId: string
    ) => Effect.Effect<ModelDefinitionRecord | undefined>;

    readonly recordObservation: (params: {
      readonly agreed: boolean;
      readonly modelAdvised: string;
      readonly modelId: string;
      readonly ruleOverridden: boolean;
    }) => Effect.Effect<CalibrationMetricRecord, never>;

    readonly registerModel: (
      modelDef: ModelDefinitionRecord
    ) => Effect.Effect<void, never>;
  }
>()("operon/runtime/PredictionService") {}

function validateApplicabilityEnvelope(
  model: ModelDefinitionRecord,
  input: Record<string, unknown>
): Effect.Effect<void, ModelOutOfScopeError> {
  const envelope = model.applicabilityEnvelope;
  if (!envelope.featureRanges) {
    return Effect.void;
  }

  for (const [feature, range] of Object.entries(envelope.featureRanges)) {
    const val = input[feature];
    if (typeof val === "number") {
      if (range.min !== undefined && val < range.min) {
        return new ModelOutOfScopeError({
          details: `Feature '${feature}' value ${val} is below envelope minimum ${range.min}`,
          feature,
          message: `Input outside applicability envelope for model '${model.modelId}'`,
          modelId: model.modelId,
        });
      }
      if (range.max !== undefined && val > range.max) {
        return new ModelOutOfScopeError({
          details: `Feature '${feature}' value ${val} is above envelope maximum ${range.max}`,
          feature,
          message: `Input outside applicability envelope for model '${model.modelId}'`,
          modelId: model.modelId,
        });
      }
    }
  }

  return Effect.void;
}

function validateHardRules(
  hardRules: readonly HardDeterministicRule[],
  input: Record<string, unknown>
): Effect.Effect<void, RulePrecedenceViolationError> {
  for (const rule of hardRules) {
    const ruleRes = rule.check(input);
    if (ruleRes.violated) {
      return new RulePrecedenceViolationError({
        attemptedAction: String(input.action ?? "INFERENCE"),
        explanation: ruleRes.reason,
        message: `Deterministic hard rule '${rule.ruleId}' denied action regardless of model confidence`,
        modelConfidence: 1,
        ruleId: rule.ruleId,
      });
    }
  }
  return Effect.void;
}

function evaluateReadinessResult(
  contextInstance?: ObjectInstance,
  objectType?: ObjectType
) {
  if (!contextInstance || !objectType) {
    return {
      complete: true,
      consistent: true,
      correct: true,
      current: true,
      isReady: true,
      missingProperties: [] as string[],
      staleProperties: [] as string[],
    };
  }

  const readiness4C = evaluateDecisionReadiness(contextInstance, objectType);
  return {
    complete: readiness4C.complete.passed,
    consistent: readiness4C.consistent.passed,
    correct: readiness4C.correct.passed,
    current: readiness4C.current.passed,
    isReady: readiness4C.isReady,
    missingProperties: [...readiness4C.complete.missingProperties],
    staleProperties: readiness4C.current.staleProperties.map((s) => s.property),
  };
}

/**
 * Live layer for PredictionService
 */
export const PredictionServiceLive = Layer.sync(PredictionService, () => {
  const modelRegistry = new Map<string, ModelDefinitionRecord>();
  const calibrationMap = new Map<string, CalibrationMetricRecord>();

  return PredictionService.of({
    generateSixPartPrediction: Effect.fn(
      "PredictionService.generateSixPartPrediction"
    )(function* (params) {
      const {
        contextInstance,
        hardRules = [],
        input,
        modelId,
        objectType,
        promptReleaseId,
        runner,
      } = params;

      const model = modelRegistry.get(modelId);
      if (!model) {
        return yield* new ModelOutOfScopeError({
          details: "Model not registered",
          feature: "modelId",
          message: `Model '${modelId}' is not registered in prediction service`,
          modelId,
        });
      }

      // 1. Check Applicability Envelope (OPR-FUN-004)
      yield* validateApplicabilityEnvelope(model, input);

      // 2. Deterministic Hard Rules Retain Final Authority (OPR-FUN-006)
      yield* validateHardRules(hardRules, input);

      // 3. Evaluate 4C Decision Readiness (OPR-FUN-005)
      const readinessResult = evaluateReadinessResult(
        contextInstance,
        objectType
      );

      // 4. Execute model runner
      const runResult = yield* runner(input);

      // Compute logic hash
      const logicHash = createHash("sha256")
        .update(model.modelId + model.version + serializeJson(input))
        .digest("hex");

      // 5. Construct Six-Part Prediction (OPR-FUN-005)
      const prediction: SixPartPrediction = {
        inputSnapshot: { ...input },
        readiness: readinessResult,
        scopeCheck: { inScope: true },
        uncertainty: {
          confidence: runResult.confidence,
          interval: runResult.interval,
        },
        value: runResult.value,
        versionChain: {
          logicHash,
          modelId: model.modelId,
          promptReleaseId,
          version: model.version,
        },
      };

      return prediction;
    }),

    getCalibrationMetrics: Effect.fn("PredictionService.getCalibrationMetrics")(
      (modelId: string) => Effect.sync(() => calibrationMap.get(modelId))
    ),

    getModelDefinition: Effect.fn("PredictionService.getModelDefinition")(
      (modelId: string) => Effect.sync(() => modelRegistry.get(modelId))
    ),

    recordObservation: Effect.fn("PredictionService.recordObservation")(
      function* (params) {
        const { agreed, modelId, ruleOverridden } = params;
        const now = yield* Clock.currentTimeMillis;
        const current = calibrationMap.get(modelId) ?? {
          calculatedAt: now,
          calibrationScore: 1,
          deterministicOverrides: 0,
          metricId: `cal-${modelId}`,
          modelId,
          modelVersion: "1.0.0",
          observedAgreements: 0,
          totalPredictions: 0,
        };

        const totalPredictions = current.totalPredictions + 1;
        const observedAgreements =
          current.observedAgreements + (agreed ? 1 : 0);
        const deterministicOverrides =
          current.deterministicOverrides + (ruleOverridden ? 1 : 0);
        const calibrationScore =
          totalPredictions > 0 ? observedAgreements / totalPredictions : 0;

        const updated: CalibrationMetricRecord = {
          calculatedAt: now,
          calibrationScore,
          deterministicOverrides,
          metricId: current.metricId,
          modelId,
          modelVersion: current.modelVersion,
          observedAgreements,
          totalPredictions,
        };

        calibrationMap.set(modelId, updated);
        return updated;
      }
    ),

    registerModel: Effect.fn("PredictionService.registerModel")(
      (modelDef: ModelDefinitionRecord) =>
        Effect.sync(() => {
          modelRegistry.set(modelDef.modelId, modelDef);
        })
    ),
  });
});
