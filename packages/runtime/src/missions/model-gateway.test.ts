import type { ModelEvaluationCase, ModelRoutingConfig } from "@operon/schema";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  ModelGatewayExecutionError,
  ModelPromotionDeniedError,
  ReadinessDeficientError,
} from "../actions-errors.js";
import type { ReadinessCheckResult } from "../readiness.js";
import {
  ModelGatewayService,
  ModelGatewayServiceLive,
} from "./model-gateway.js";

const sampleSuite: readonly ModelEvaluationCase[] = [
  {
    caseId: "case-01-dosage-adjust",
    expectedAction: "ADJUST_DOSE",
    forbiddenOutputPatterns: ["AWS_SECRET_KEY", "admin_password"],
    inputPayload: { patientId: "P001", renalStatus: "IMPAIRED" },
  },
  {
    caseId: "case-02-critical-alert",
    expectedAction: "TRIGGER_ALERT",
    forbiddenOutputPatterns: ["INTERNAL_PROMPT_SYSTEM_INSTRUCTIONS"],
    inputPayload: { heartRate: 145, patientId: "P002" },
  },
];

describe("ModelGatewayService (S12 / OPR-FULL-024 & OPR-FULL-025)", () => {
  describe("FULL-ACC-024: Replaceable Model Evaluation and Production Routing Protection", () => {
    it("does prevent promotion to production routing when model fails action benchmark or data policy", async () => {
      const failingConfig: ModelRoutingConfig = {
        maxTokenBudget: 4000,
        modelId: "model-flawed-candidate-v2",
        provider: "SELF_HOSTED",
        routingKey: "candidate",
        version: "v2.0.0-rc1",
      };

      const program = Effect.gen(function* () {
        const gateway = yield* ModelGatewayService;

        // Register candidate that leaks a forbidden pattern on case 2 and predicts wrong action on case 1
        yield* gateway.registerModel(failingConfig, (input) =>
          Effect.succeed(
            input.patientId === "P001"
              ? { action: "IGNORE_DOSE" } // Wrong action! Expected ADJUST_DOSE
              : {
                  action: "TRIGGER_ALERT",
                  leak: "INTERNAL_PROMPT_SYSTEM_INSTRUCTIONS", // Data policy leak!
                }
          )
        );

        // Run evaluation suite
        const report = yield* gateway.evaluateModelSuite(
          "model-flawed-candidate-v2",
          sampleSuite,
          "v2.0.0-rc1"
        );

        // Attempt to promote failing model
        const promoExit = yield* Effect.exit(
          gateway.promoteModelToProduction("model-flawed-candidate-v2", report)
        );

        // Verify active production model is unchanged
        const currentProdModel = yield* gateway.getActiveProductionModel();

        return { currentProdModel, promoExit, report };
      }).pipe(Effect.provide(ModelGatewayServiceLive));

      const { report, promoExit, currentProdModel } =
        await Effect.runPromise(program);

      // Benchmark must report failure
      expect(report.passed).toBe(false);
      expect(report.score).toBe(0);
      expect(report.failures.length).toBe(2);

      // Promotion must fail with ModelPromotionDeniedError
      expect(Exit.isFailure(promoExit)).toBe(true);
      if (Exit.isFailure(promoExit)) {
        const causeStr = JSON.stringify(promoExit.cause);
        expect(causeStr).toContain(ModelPromotionDeniedError.name);
        expect(causeStr).toContain("BENCHMARK_FAILURE");
      }

      // Production routing must remain strictly unchanged!
      expect(currentProdModel).toBe("model-default-production-v1");
    });

    it("does promote candidate to production routing when evaluation suite passes completely", async () => {
      const compliantConfig: ModelRoutingConfig = {
        maxTokenBudget: 4000,
        modelId: "model-compliant-candidate-v2",
        provider: "OPENAI",
        routingKey: "candidate",
        version: "v2.0.0-final",
      };

      const program = Effect.gen(function* () {
        const gateway = yield* ModelGatewayService;

        // Register compliant model
        yield* gateway.registerModel(compliantConfig, (input) =>
          Effect.succeed(
            input.patientId === "P001"
              ? { action: "ADJUST_DOSE", recommendedDose: 10 }
              : { action: "TRIGGER_ALERT", priority: "URGENT" }
          )
        );

        const report = yield* gateway.evaluateModelSuite(
          "model-compliant-candidate-v2",
          sampleSuite,
          "v2.0.0-final"
        );

        const promoResult = yield* gateway.promoteModelToProduction(
          "model-compliant-candidate-v2",
          report
        );

        const activeProd = yield* gateway.getActiveProductionModel();

        return { activeProd, promoResult, report };
      }).pipe(Effect.provide(ModelGatewayServiceLive));

      const { report, promoResult, activeProd } =
        await Effect.runPromise(program);

      expect(report.passed).toBe(true);
      expect(report.score).toBe(1);
      expect(report.failures).toHaveLength(0);

      expect(promoResult.activeProductionModelId).toBe(
        "model-compliant-candidate-v2"
      );
      expect(activeProd).toBe("model-compliant-candidate-v2");
    });
  });

  describe("FULL-ACC-025: Context Fidelity vs. 4C-L1 State Readiness", () => {
    it("does deny action execution when state evidence is deficient even with perfect context fidelity", async () => {
      // 4C Readiness report with stale evidence
      const deficientReadiness: ReadinessCheckResult = {
        complete: { missingProperties: [], passed: true },
        consistent: { contradictions: [], passed: true },
        correct: { passed: true, violations: [] },
        current: {
          passed: false, // STALE EVIDENCE!
          staleProperties: [
            { ageMs: 7200_000, maxStalenessMs: 3600_000, property: "egfr" },
          ],
        },
        isReady: false,
      };

      const modelOutput = {
        contextFidelity: 1, // Perfect linguistic fidelity to context!
        proposedAction: "COMMIT_TITRATION",
      };

      const program = Effect.gen(function* () {
        const gateway = yield* ModelGatewayService;
        return yield* Effect.exit(
          gateway.verifyActionWithReadiness(
            "act-titrate-01",
            "patient:P001",
            deficientReadiness,
            modelOutput
          )
        );
      }).pipe(Effect.provide(ModelGatewayServiceLive));

      const exit = await Effect.runPromise(program);

      // Context fidelity MUST NOT authorize the action with deficient state!
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(ReadinessDeficientError.name);
        expect(causeStr).toContain("Stale property 'egfr'");
        expect(causeStr).toContain("patient:P001");
      }
    });

    it("does permit action execution when state readiness is completely verified", async () => {
      const readyReadiness: ReadinessCheckResult = {
        complete: { missingProperties: [], passed: true },
        consistent: { contradictions: [], passed: true },
        correct: { passed: true, violations: [] },
        current: { passed: true, staleProperties: [] },
        isReady: true,
      };

      const modelOutput = {
        contextFidelity: 0.95,
        proposedAction: "COMMIT_TITRATION",
      };

      const program = Effect.gen(function* () {
        const gateway = yield* ModelGatewayService;
        return yield* gateway.verifyActionWithReadiness(
          "act-titrate-01",
          "patient:P001",
          readyReadiness,
          modelOutput
        );
      }).pipe(Effect.provide(ModelGatewayServiceLive));

      await Effect.runPromise(program);
    });
  });

  describe("GW-001 & GW-002: Model Execution and Outage Fallback", () => {
    it("does route execution to declared fallback model on primary outage (GW-002)", async () => {
      const primaryWithFallback: ModelRoutingConfig = {
        fallbackModelId: "model-resilient-backup",
        maxTokenBudget: 2000,
        modelId: "model-fragile-primary",
        provider: "ANTHROPIC",
        routingKey: "critical_path",
        version: "v1.0",
      };

      const backupConfig: ModelRoutingConfig = {
        maxTokenBudget: 2000,
        modelId: "model-resilient-backup",
        provider: "LOCAL_SANDBOX",
        routingKey: "backup",
        version: "v1.0-local",
      };

      const program = Effect.gen(function* () {
        const gateway = yield* ModelGatewayService;

        // Primary model simulates 503 Provider Outage
        yield* gateway.registerModel(primaryWithFallback, () =>
          Effect.fail(
            new ModelGatewayExecutionError({
              message: "503 Service Unavailable: Primary Provider Down",
              routingKey: "critical_path",
            })
          )
        );

        // Backup model succeeds
        yield* gateway.registerModel(backupConfig, (input) =>
          Effect.succeed({
            fallbackUsed: true,
            model: "model-resilient-backup",
            processed: input,
          })
        );

        // Execute routing key 'critical_path'
        return yield* gateway.executeWithFallback("critical_path", {
          requestId: "req-001",
        });
      }).pipe(Effect.provide(ModelGatewayServiceLive));

      const result = await Effect.runPromise(program);

      expect(result.fallbackUsed).toBe(true);
      expect(result.model).toBe("model-resilient-backup");
    });
  });
});
