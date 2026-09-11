import type {
  ModelEvaluationCase,
  ModelEvaluationReport,
  ModelRoutingConfig,
} from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Context, Effect, Layer } from "effect";

import {
  ModelGatewayExecutionError,
  ModelPromotionDeniedError,
  ReadinessDeficientError,
} from "../actions-errors.js";
import type { ReadinessCheckResult } from "../readiness.js";

/**
 * Interface for model runner function
 */
export type ModelComputeFn = (
  input: Record<string, unknown>
) => Effect.Effect<Record<string, unknown>, Error>;

export interface ModelEntry {
  readonly config: ModelRoutingConfig;
  readonly runner: ModelComputeFn;
}

/**
 * Service governing replaceable model gateway, evaluation suites, and 4C readiness verification (S12 / OPR-FULL-024, OPR-FULL-025)
 */
export class ModelGatewayService extends Context.Service<
  ModelGatewayService,
  {
    readonly evaluateModelSuite: (
      candidateModelId: string,
      suite: readonly ModelEvaluationCase[],
      suiteVersion: string
    ) => Effect.Effect<ModelEvaluationReport, never>;

    readonly executeWithFallback: (
      routingKey: string,
      input: Record<string, unknown>
    ) => Effect.Effect<Record<string, unknown>, Error>;

    readonly getActiveProductionModel: () => Effect.Effect<string, never>;

    readonly promoteModelToProduction: (
      candidateModelId: string,
      report: ModelEvaluationReport
    ) => Effect.Effect<
      { readonly activeProductionModelId: string },
      ModelPromotionDeniedError
    >;

    readonly registerModel: (
      config: ModelRoutingConfig,
      runner: ModelComputeFn
    ) => Effect.Effect<void, never>;

    readonly verifyActionWithReadiness: (
      actionId: string,
      objectId: string,
      readiness: ReadinessCheckResult,
      modelOutput: {
        readonly contextFidelity: number;
        readonly proposedAction: string;
      }
    ) => Effect.Effect<void, ReadinessDeficientError>;
  }
>()("operon/runtime/ModelGatewayService") {}

/**
 * Live implementation of ModelGatewayService
 */
export const ModelGatewayServiceLive = Layer.sync(ModelGatewayService, () => {
  const models = new Map<string, ModelEntry>();
  let activeProductionModelId = "model-default-production-v1";

  return ModelGatewayService.of({
    evaluateModelSuite: Effect.fn("ModelGatewayService.evaluateModelSuite")(
      function* (
        candidateModelId: string,
        suite: readonly ModelEvaluationCase[],
        suiteVersion: string
      ) {
        const entry = models.get(candidateModelId);
        const failures: string[] = [];

        if (!entry) {
          failures.push(
            `Model candidate '${candidateModelId}' is not registered in gateway`
          );
          return {
            evaluatedAt: Date.now(),
            failures,
            modelId: candidateModelId,
            passed: false,
            score: 0,
            suiteVersion,
          };
        }

        let passedCases = 0;

        for (const testCase of suite) {
          const runExit = yield* Effect.exit(
            entry.runner(testCase.inputPayload)
          );
          const runResult =
            runExit._tag === "Success"
              ? runExit.value
              : ({ error: String(runExit.cause) } as Record<string, unknown>);

          let casePassed = true;

          // 1. Action prediction check
          if (runResult.action !== testCase.expectedAction) {
            failures.push(
              `Case '${testCase.caseId}': expected action '${testCase.expectedAction}', received '${String(runResult.action)}'`
            );
            casePassed = false;
          }

          // 2. Data policy check (forbidden output patterns / leaks)
          const outputString = JSON.stringify(runResult);
          for (const pattern of testCase.forbiddenOutputPatterns) {
            if (outputString.includes(pattern)) {
              failures.push(
                `Case '${testCase.caseId}': output exposed forbidden pattern '${pattern}'`
              );
              casePassed = false;
            }
          }

          if (casePassed) {
            passedCases += 1;
          }
        }

        const score = suite.length > 0 ? passedCases / suite.length : 1;
        const passed = failures.length === 0;

        return {
          evaluatedAt: Date.now(),
          failures,
          modelId: candidateModelId,
          passed,
          score,
          suiteVersion,
        };
      }
    ),

    executeWithFallback: Effect.fn("ModelGatewayService.executeWithFallback")(
      function* (routingKey: string, input: Record<string, unknown>) {
        let primary =
          routingKey === "production"
            ? models.get(activeProductionModelId)
            : undefined;

        if (!primary) {
          for (const entry of models.values()) {
            if (entry.config.routingKey === routingKey) {
              primary = entry;
              break;
            }
          }
        }

        if (!primary) {
          primary = models.get(routingKey);
        }

        if (!primary) {
          return yield* Effect.fail(
            new ModelGatewayExecutionError({
              message: `No model found for routing key '${routingKey}'`,
              routingKey,
            })
          );
        }

        const primaryAttempt = yield* Effect.exit(primary.runner(input));

        if (primaryAttempt._tag === "Success") {
          return primaryAttempt.value;
        }

        // Primary failed; check fallback
        const fallbackId = primary.config.fallbackModelId;
        if (fallbackId && models.has(fallbackId)) {
          const fallbackEntry = models.get(fallbackId);
          if (fallbackEntry) {
            OperonTelemetryService.getInstance().trackEvent({
              event: "operon_model_executed",
              properties: {
                durationMs: 0,
                isDeterministic: true,
                modelId: fallbackId,
                timedOut: false,
                version: fallbackEntry.config.version,
              },
            });

            return yield* fallbackEntry.runner(input);
          }
        }

        return yield* Effect.fail(
          new ModelGatewayExecutionError({
            message: `Primary model '${primary.config.modelId}' failed and no functional fallback succeeded: ${String(primaryAttempt.cause)}`,
            modelId: primary.config.modelId,
            routingKey,
          })
        );
      }
    ),

    getActiveProductionModel: Effect.fn(
      "ModelGatewayService.getActiveProductionModel"
    )(() => Effect.sync(() => activeProductionModelId)),

    promoteModelToProduction: Effect.fn(
      "ModelGatewayService.promoteModelToProduction"
    )(function* (candidateModelId: string, report: ModelEvaluationReport) {
      // OPR-FULL-024 / FULL-ACC-024:
      // When a new model candidate fails the benchmark or data exposure suite,
      // production routing is NOT changed.
      if (!report.passed || report.score < 1) {
        return yield* Effect.fail(
          new ModelPromotionDeniedError({
            candidateModelId,
            currentProductionModelId: activeProductionModelId,
            failures: report.failures,
            message: `Promotion of candidate '${candidateModelId}' denied: benchmark score ${report.score} < 1.0 (${report.failures.length} failures). Production routing unchanged (${activeProductionModelId}).`,
            reason: "BENCHMARK_FAILURE",
          })
        );
      }

      activeProductionModelId = candidateModelId;

      OperonTelemetryService.getInstance().trackEvent({
        event: "operon_model_executed",
        properties: {
          durationMs: 0,
          isDeterministic: true,
          modelId: candidateModelId,
          timedOut: false,
          version: report.suiteVersion,
        },
      });

      return { activeProductionModelId };
    }),

    registerModel: Effect.fn("ModelGatewayService.registerModel")(
      (config: ModelRoutingConfig, runner: ModelComputeFn) =>
        Effect.sync(() => {
          models.set(config.modelId, { config, runner });
        })
    ),

    verifyActionWithReadiness: Effect.fn(
      "ModelGatewayService.verifyActionWithReadiness"
    )(function* (
      actionId: string,
      objectId: string,
      readiness: ReadinessCheckResult,
      modelOutput: {
        readonly contextFidelity: number;
        readonly proposedAction: string;
      }
    ) {
      // OPR-FULL-025 / FULL-ACC-025:
      // Linguistic fidelity to context does NOT authorize action when state readiness is deficient!
      if (!readiness.isReady) {
        const deficiencies: string[] = [];
        if (!readiness.correct.passed) {
          deficiencies.push(...readiness.correct.violations);
        }
        if (!readiness.complete.passed) {
          deficiencies.push(
            ...readiness.complete.missingProperties.map(
              (p) => `Missing property '${p}'`
            )
          );
        }
        if (!readiness.current.passed) {
          deficiencies.push(
            ...readiness.current.staleProperties.map(
              (s) =>
                `Stale property '${s.property}' (age ${s.ageMs}ms > max ${s.maxStalenessMs}ms)`
            )
          );
        }
        if (!readiness.consistent.passed) {
          deficiencies.push(...readiness.consistent.contradictions);
        }

        return yield* Effect.fail(
          new ReadinessDeficientError({
            actionId,
            contextFidelityScore: modelOutput.contextFidelity,
            deficiencies,
            message: `Action '${actionId}' rejected: Context fidelity score (${modelOutput.contextFidelity}) does not authorize action with deficient state readiness on '${objectId}': ${deficiencies.join("; ")}`,
            objectId,
          })
        );
      }

      return Effect.void;
    }),
  });
});
