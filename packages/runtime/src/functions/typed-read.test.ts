import type {
  ApplicabilityEnvelope,
  DependencyRecord,
  FunctionExecutionContext,
  ModelDefinitionRecord,
  ObjectInstance,
  ObjectType,
} from "@operon/schema";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  FunctionPermissionDeniedError,
  FunctionValidationError,
  ModelOutOfScopeError,
  RulePrecedenceViolationError,
} from "../actions-errors.js";
import type { HardDeterministicRule } from "./prediction-service.js";
import {
  PredictionService,
  PredictionServiceLive,
} from "./prediction-service.js";
import type {
  StagedEditMutation,
  TypedReadFunction,
} from "./typed-read-service.js";
import {
  TypedReadService,
  TypedReadServiceLive,
} from "./typed-read-service.js";

describe("Typed Read Functions & Predictions (S12 / OPR-FUN-001..006)", () => {
  const callerContext: FunctionExecutionContext = {
    callerId: "clinician-001",
    callerPermissions: ["READ_PATIENT_VITALS", "READ_LAB_RESULTS"],
    correlationId: "corr-101",
    tenantId: "hospital-central",
  };

  const calculateEGFR: TypedReadFunction = {
    description:
      "Calculates estimated Glomerular Filtration Rate using CKD-EPI formula",
    execute: (rawInput) =>
      Effect.sync(() => {
        const input = rawInput as {
          age: number;
          creatinine: number;
          isFemale: boolean;
        };
        // Deterministic pure calculation
        const base =
          input.creatinine <= 0.7
            ? 144
            : 144 * (input.creatinine / 0.7) ** -1.2;
        const ageFactor = 0.9938 ** input.age;
        const genderFactor = input.isFemale ? 1.018 : 1;
        const egfr = Math.round(base * ageFactor * genderFactor);
        const stage =
          egfr >= 90 ? "G1_NORMAL" : egfr >= 60 ? "G2_MILD" : "G3_MODERATE";
        return { egfr, stage };
      }),
    functionId: "fn_calculate_egfr",
    inputSchema: Schema.Struct({
      age: Schema.Number,
      creatinine: Schema.Number,
      isFemale: Schema.Boolean,
    }),
    isPure: true,
    outputSchema: Schema.Struct({
      egfr: Schema.Number,
      stage: Schema.String,
    }),
    requiredPermissions: ["READ_LAB_RESULTS"],
    version: "1.2.0",
  };

  describe("OPR-FUN-001: Typed, versioned read functions", () => {
    it("does evaluate pure function identically twice on identical inputs with zero state mutation (FUN-001.T01)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;
        yield* service.registerFunction(calculateEGFR);

        const input = { age: 52, creatinine: 0.9, isFemale: true };
        const run1 = yield* service.invokeFunction(
          "fn_calculate_egfr",
          input,
          callerContext
        );
        const run2 = yield* service.invokeFunction(
          "fn_calculate_egfr",
          input,
          callerContext
        );

        return { run1, run2 };
      }).pipe(Effect.provide(TypedReadServiceLive));

      const { run1, run2 } = await Effect.runPromise(program);
      expect(run1).toEqual(run2);
      expect(run1).toEqual({ egfr: 78, stage: "G2_MILD" });
    });

    it("does reject invocation when caller lacks required permissions (FUN-001.T02)", async () => {
      const unauthorizedCaller: FunctionExecutionContext = {
        callerId: "guest-user",
        callerPermissions: ["READ_PUBLIC_DIRECTORY"],
        correlationId: "corr-102",
        tenantId: "hospital-central",
      };

      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;
        yield* service.registerFunction(calculateEGFR);

        return yield* service.invokeFunction(
          "fn_calculate_egfr",
          { age: 52, creatinine: 0.9, isFemale: true },
          unauthorizedCaller
        );
      }).pipe(Effect.provide(TypedReadServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(FunctionPermissionDeniedError.name);
        expect(causeStr).toContain("READ_LAB_RESULTS");
      }
    });

    it("does fail schema validation before executing function when input schema is invalid", async () => {
      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;
        yield* service.registerFunction(calculateEGFR);

        return yield* service.invokeFunction(
          "fn_calculate_egfr",
          { age: "FIFTY_TWO", creatinine: 0.9, isFemale: true },
          callerContext
        );
      }).pipe(Effect.provide(TypedReadServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(FunctionValidationError.name);
        expect(causeStr).toContain("INPUT_VALIDATION");
      }
    });
  });

  describe("OPR-FUN-002: Staged edit discipline", () => {
    it("does abort without leaking state when staged edits fail halfway (FUN-002.T01)", async () => {
      const edits: readonly StagedEditMutation[] = [
        {
          entityId: "patient-101",
          entityType: "Patient",
          mutationType: "UPDATE",
          payload: { status: "DISCHARGED" },
        },
      ];

      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;

        const stageExit = yield* Effect.exit(
          service.stageEdits(edits, () =>
            Effect.fail(
              new FunctionValidationError({
                errors: ["Database constraint failure in staging transaction"],
                functionId: "stageEdits",
                message: "Database constraint failure in staging transaction",
                phase: "INPUT_VALIDATION",
              })
            )
          )
        );

        const visibleEdits = yield* service.getVisibleStagedEdits();
        return { stageExit, visibleEdits };
      }).pipe(Effect.provide(TypedReadServiceLive));

      const { stageExit, visibleEdits } = await Effect.runPromise(program);
      expect(Exit.isFailure(stageExit)).toBe(true);
      expect(visibleEdits.length).toBe(0);
    });

    it("does block direct write execution or undeclared remote side effects in staging (FUN-002.T02)", async () => {
      const illegalEdits: readonly StagedEditMutation[] = [
        {
          entityId: "patient-101",
          entityType: "Patient",
          hasUndeclaredSideEffect: true,
          mutationType: "UPDATE",
          payload: { remoteWebhookFired: "https://external-api.com" },
        },
      ];

      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;
        return yield* service.stageEdits(illegalEdits, () => Effect.void);
      }).pipe(Effect.provide(TypedReadServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(FunctionValidationError.name);
        expect(causeStr).toContain(
          "Undeclared side effect in staging is forbidden"
        );
      }
    });
  });

  describe("OPR-FUN-003: Materialization and invalidation", () => {
    it("does invalidate materialized output when dependency version changes (FUN-003.T01)", async () => {
      const dependencies: readonly DependencyRecord[] = [
        { entityId: "lab-creatinine-001", recordedAt: 1000, version: 1 },
      ];

      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;
        yield* service.registerFunction(calculateEGFR);

        const record = yield* service.materializeOutput(
          "fn_calculate_egfr",
          { age: 52, creatinine: 0.9, isFemale: true },
          callerContext,
          dependencies
        );

        // Check freshness with identical version
        const checkBefore = yield* service.checkFreshness(record.outputId, {
          "lab-creatinine-001": 1,
        });

        // Mutate dependency version (new lab result ingested)
        const checkAfter = yield* service.checkFreshness(record.outputId, {
          "lab-creatinine-001": 2,
        });

        return { checkAfter, checkBefore, record };
      }).pipe(Effect.provide(TypedReadServiceLive));

      const { record, checkBefore, checkAfter } =
        await Effect.runPromise(program);
      expect(record.isStale).toBe(false);
      expect(checkBefore.isStale).toBe(false);
      expect(checkAfter.isStale).toBe(true);
      expect(checkAfter.staleDependencies).toContain("lab-creatinine-001");
    });

    it("does preserve logic version and input hash for audit lineage (FUN-003.T02)", async () => {
      const dependencies: readonly DependencyRecord[] = [
        { entityId: "lab-creatinine-001", recordedAt: 1000, version: 1 },
      ];

      const program = Effect.gen(function* () {
        const service = yield* TypedReadService;
        yield* service.registerFunction(calculateEGFR);

        const record = yield* service.materializeOutput(
          "fn_calculate_egfr",
          { age: 52, creatinine: 0.9, isFemale: true },
          callerContext,
          dependencies
        );

        return yield* service.getAuditLineage(record.outputId);
      }).pipe(Effect.provide(TypedReadServiceLive));

      const lineage = await Effect.runPromise(program);
      expect(lineage).toBeDefined();
      expect(lineage?.logicVersion).toBe("1.2.0");
      expect(lineage?.inputHash).toBeDefined();
      expect(lineage?.dependencies.length).toBe(1);
    });
  });

  describe("OPR-FUN-004..006: Prediction lifecycle, 6-part contract & rule authority", () => {
    const envelope: ApplicabilityEnvelope = {
      allowedFeatures: ["patientAge", "systolicBP", "diastolicBP"],
      domain: "cardiology",
      featureRanges: {
        patientAge: { max: 95, min: 18 },
        systolicBP: { max: 240, min: 60 },
      },
      targetEntities: ["Patient"],
    };

    const modelDef: ModelDefinitionRecord = {
      applicabilityEnvelope: envelope,
      evaluationEvidence: {
        benchmarkScore: 0.95,
        evalSuiteVersion: "suite-v1.0",
        passed: true,
      },
      modelId: "cardio-risk-eval-v1",
      status: "RELEASED",
      version: "1.0.0",
    };

    const dummyObjectType: ObjectType<any> = {
      description: "Patient",
      id: "Patient",
      name: "Patient",
      properties: {
        age: { required: true, schema: Schema.Number },
        systolicBP: { required: true, schema: Schema.Number },
      },
      titleProperty: "name",
      typology: "OBJECT",
    };

    it("does report out_of_scope when input is outside applicability envelope (FUN-004.T01)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PredictionService;
        yield* service.registerModel(modelDef);

        // Supply systolicBP = 290 (above max 240)
        return yield* service.generateSixPartPrediction({
          input: { diastolicBP: 90, patientAge: 45, systolicBP: 290 },
          modelId: "cardio-risk-eval-v1",
          runner: () =>
            Effect.succeed({
              confidence: 0.92,
              value: { riskLevel: "HIGH" },
            }),
        });
      }).pipe(Effect.provide(PredictionServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(ModelOutOfScopeError.name);
        expect(causeStr).toContain("systolicBP");
      }
    });

    it("does generate full six-part prediction when all checks pass (FUN-005.T01)", async () => {
      const patientInstance: ObjectInstance = {
        id: "pat-101",
        lastModifiedAt: Date.now(),
        properties: {
          age: 45,
          systolicBP: 130,
        },
        schemaVersion: "1.0.0",
        typeId: "Patient",
      };

      const program = Effect.gen(function* () {
        const service = yield* PredictionService;
        yield* service.registerModel(modelDef);

        return yield* service.generateSixPartPrediction({
          contextInstance: patientInstance,
          input: { diastolicBP: 85, patientAge: 45, systolicBP: 130 },
          modelId: "cardio-risk-eval-v1",
          objectType: dummyObjectType,
          promptReleaseId: "prompt-v1.0",
          runner: () =>
            Effect.succeed({
              confidence: 0.88,
              interval: { lower: 0.82, upper: 0.94 },
              value: { riskScore: 0.22, stratum: "LOW" },
            }),
        });
      }).pipe(Effect.provide(PredictionServiceLive));

      const prediction = await Effect.runPromise(program);

      // Part 1: value
      expect(prediction.value).toEqual({ riskScore: 0.22, stratum: "LOW" });
      // Part 2: uncertainty
      expect(prediction.uncertainty.confidence).toBe(0.88);
      expect(prediction.uncertainty.interval).toEqual({
        lower: 0.82,
        upper: 0.94,
      });
      // Part 3: inputSnapshot
      expect(prediction.inputSnapshot.systolicBP).toBe(130);
      // Part 4: versionChain
      expect(prediction.versionChain.modelId).toBe("cardio-risk-eval-v1");
      expect(prediction.versionChain.promptReleaseId).toBe("prompt-v1.0");
      // Part 5: scopeCheck
      expect(prediction.scopeCheck.inScope).toBe(true);
      // Part 6: readiness
      expect(prediction.readiness.isReady).toBe(true);
      expect(prediction.readiness.complete).toBe(true);
    });

    it("does reflect readiness failure when context evidence is missing (FUN-005.T02)", async () => {
      // Missing required property 'systolicBP'
      const deficientPatient: ObjectInstance = {
        id: "pat-102",
        lastModifiedAt: Date.now(),
        properties: {
          age: 45,
        },
        schemaVersion: "1.0.0",
        typeId: "Patient",
      };

      const program = Effect.gen(function* () {
        const service = yield* PredictionService;
        yield* service.registerModel(modelDef);

        return yield* service.generateSixPartPrediction({
          contextInstance: deficientPatient,
          input: { diastolicBP: 85, patientAge: 45, systolicBP: 130 },
          modelId: "cardio-risk-eval-v1",
          objectType: dummyObjectType,
          runner: () =>
            Effect.succeed({
              confidence: 0.99, // High confidence!
              value: { recommendation: "NO_TREATMENT" },
            }),
        });
      }).pipe(Effect.provide(PredictionServiceLive));

      const prediction = await Effect.runPromise(program);
      // High confidence cannot bypass incomplete readiness!
      expect(prediction.uncertainty.confidence).toBe(0.99);
      expect(prediction.readiness.isReady).toBe(false);
      expect(prediction.readiness.complete).toBe(false);
      expect(prediction.readiness.missingProperties).toContain("systolicBP");
    });

    it("does enforce hard deterministic rule over high model confidence (FUN-006.T01)", async () => {
      const allergyRule: HardDeterministicRule = {
        check: (input) => ({
          reason:
            "Patient has documented severe anaphylactic penicillin allergy",
          violated: input.prescribedDrug === "PENICILLIN",
        }),
        description: "Hard stop: penicillin allergy",
        ruleId: "RULE-ALLERGY-PENICILLIN",
      };

      const program = Effect.gen(function* () {
        const service = yield* PredictionService;
        yield* service.registerModel(modelDef);

        return yield* service.generateSixPartPrediction({
          hardRules: [allergyRule],
          input: {
            action: "ADMINISTER_MEDICATION",
            diastolicBP: 80,
            patientAge: 45,
            prescribedDrug: "PENICILLIN",
            systolicBP: 120,
          },
          modelId: "cardio-risk-eval-v1",
          runner: () =>
            Effect.succeed({
              confidence: 0.999, // Model claims 99.9% confidence
              explanation: "Antibiotic regimen indicated by infection markers",
              value: { proceed: true },
            }),
        });
      }).pipe(Effect.provide(PredictionServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(RulePrecedenceViolationError.name);
        expect(causeStr).toContain("RULE-ALLERGY-PENICILLIN");
      }
    });

    it("does calculate calibration and override indicators from real observations (FUN-006.T02)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PredictionService;

        // Record 3 observations: 2 agreed, 1 overridden by hard rule
        yield* service.recordObservation({
          agreed: true,
          modelAdvised: "DISCHARGE",
          modelId: "discharge-model-v1",
          ruleOverridden: false,
        });

        yield* service.recordObservation({
          agreed: true,
          modelAdvised: "DISCHARGE",
          modelId: "discharge-model-v1",
          ruleOverridden: false,
        });

        yield* service.recordObservation({
          agreed: false,
          modelAdvised: "DISCHARGE",
          modelId: "discharge-model-v1",
          ruleOverridden: true,
        });

        return yield* service.getCalibrationMetrics("discharge-model-v1");
      }).pipe(Effect.provide(PredictionServiceLive));

      const metrics = await Effect.runPromise(program);
      expect(metrics).toBeDefined();
      expect(metrics?.totalPredictions).toBe(3);
      expect(metrics?.observedAgreements).toBe(2);
      expect(metrics?.deterministicOverrides).toBe(1);
      expect(metrics?.calibrationScore).toBeCloseTo(2 / 3);
    });
  });
});
