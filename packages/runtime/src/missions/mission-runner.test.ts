import type {
  MissionTaskMandate,
  ObservablePredicate,
  PlanDAG,
} from "@operon/schema";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  MissionRunnerService,
  MissionRunnerServiceLive,
} from "./mission-runner.js";
import type { MissionWorldState } from "./mission-runner.js";

function createBaseMandate(
  overrides?: Partial<MissionTaskMandate>
): MissionTaskMandate {
  return {
    deadline: 10_000,
    envelope: {
      allowedActionClasses: [
        "INVENTORY_ADJUST",
        "PURCHASE_ORDER",
        "NOTIFY_OPS",
      ],
      budgetLimit: 500,
      expiresAt: 10_000,
      mandateId: "mandate-v2-03-test",
      maxRiskBand: "MEDIUM",
      objectSet: ["warehouse:ord-*", "inventory:item-*"],
      principalId: "agent-planner-01",
      spentBudget: 50,
      tier: "TIER_4_BOUNDED_AUTONOMY",
    },
    issuerId: "human-ops-lead",
    mandateId: "mandate-v2-03-test",
    objective: "Replenish low stock items and notify operations",
    ownerId: "agent-planner-01",
    stopConditions: [
      {
        _tag: "MAX_BUDGET_EXCEEDED",
        maxBudget: 500,
      },
      {
        _tag: "EXPIRED_DEADLINE",
        deadline: 10_000,
      },
      {
        _tag: "MANDATORY_CONSTRAINT",
        constraintId: "REQUIRE_HUMAN_SECURITY_REVIEW",
        description:
          "Must not skip security review or bypass authorization controls",
      },
      {
        _tag: "SAFETY_TRIPWIRE",
        reason: "Active data breach or audit lockdown",
        tripwireId: "LOCKDOWN_TRIPWIRE",
      },
    ],
    successPredicates: [
      {
        _tag: "PROPERTY_EQUALS",
        expectedValue: 150,
        objectId: "inventory:item-101",
        property: "stockLevel",
      },
      {
        _tag: "STATE_MATCHES",
        expectedState: "CONFIRMED",
        objectId: "warehouse:ord-999",
      },
      {
        _tag: "RECEIPT_EXISTS",
        actionId: "act-po-999",
        requiredStatus: "COMPLETED",
      },
    ],
    ...overrides,
  };
}

describe("MissionRunnerService (S12 / OPR-FULL-021 & OPR-FULL-023)", () => {
  describe("FULL-ACC-021: Independent Outcome Evaluation and Fictional Success Prevention", () => {
    it("does prevent fictional success when model declares done but state predicates are unsatisfied", async () => {
      const mandate = createBaseMandate();

      // World state where only 1 of 3 predicates is satisfied
      const partialWorldState: MissionWorldState = {
        objects: new Map([
          [
            "inventory:item-101",
            {
              properties: { stockLevel: 50 }, // Expected 150! Unsatisfied
              state: "LOW_STOCK",
            },
          ],
          [
            "warehouse:ord-999",
            {
              properties: {},
              state: "CONFIRMED", // Satisfied
            },
          ],
        ]),
        receipts: new Map([
          [
            "act-po-999",
            {
              actionId: "act-po-999",
              status: "PENDING", // Expected COMPLETED! Unsatisfied
            },
          ],
        ]),
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;

        // Model reports done = true
        const evalResult = yield* runner.evaluateMissionOutcome(
          mandate,
          partialWorldState,
          true
        );

        // Verification must fail with explicit FictionalSuccessRejectedError
        const verifyExit = yield* Effect.exit(
          runner.verifyMissionCompletion(mandate, partialWorldState, true)
        );

        return { evalResult, verifyExit };
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const { evalResult, verifyExit } = await Effect.runPromise(program);

      // Status must remain PARTIAL, never SUCCEEDED
      expect(evalResult.status).toBe("PARTIAL");
      expect(evalResult.allPredicatesSatisfied).toBe(false);
      expect(evalResult.fictionalSuccessPrevented).toBe(true);

      // Verify exit is a failure with FictionalSuccessRejectedError
      expect(Exit.isFailure(verifyExit)).toBe(true);
      if (Exit.isFailure(verifyExit)) {
        const causeStr = JSON.stringify(verifyExit.cause);
        expect(causeStr).toContain("FictionalSuccessRejectedError");
        expect(causeStr).toContain(mandate.mandateId);
      }
    });

    it("does confirm success when all independent predicates evaluate to true", async () => {
      const mandate = createBaseMandate();

      // Canonical world state where all 3 predicates match
      const fullySatisfiedWorldState: MissionWorldState = {
        objects: new Map([
          [
            "inventory:item-101",
            {
              properties: { stockLevel: 150 },
              state: "OPTIMAL",
            },
          ],
          [
            "warehouse:ord-999",
            {
              properties: {},
              state: "CONFIRMED",
            },
          ],
        ]),
        receipts: new Map([
          [
            "act-po-999",
            {
              actionId: "act-po-999",
              status: "COMPLETED",
            },
          ],
        ]),
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* runner.verifyMissionCompletion(
          mandate,
          fullySatisfiedWorldState,
          true
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.status).toBe("SUCCEEDED");
      expect(result.allPredicatesSatisfied).toBe(true);
      expect(result.fictionalSuccessPrevented).toBe(false);
      expect(result.predicatesEvaluated.every((p) => p.satisfied)).toBe(true);
    });

    it("does evaluate custom assertion predicates against world state", async () => {
      const customPred: ObservablePredicate = {
        _tag: "CUSTOM_ASSERTION",
        assertionId: "ASSERT_NO_BACKLOG",
        parameters: { maxAllowedBacklog: 0 },
      };

      const mandate = createBaseMandate({
        successPredicates: [customPred],
      });

      const worldStatePass: MissionWorldState = {
        customAssertions: new Map([
          [
            "ASSERT_NO_BACKLOG",
            (params?: Record<string, unknown>) =>
              params?.maxAllowedBacklog === 0,
          ],
        ]),
        objects: new Map(),
        receipts: new Map(),
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* runner.evaluateMissionOutcome(
          mandate,
          worldStatePass,
          false
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.status).toBe("SUCCEEDED");
      expect(result.allPredicatesSatisfied).toBe(true);
    });
  });

  describe("FULL-ACC-023: Bounded Planning & Mandatory Constraint Enforcement", () => {
    it("does reject plan violating mandatory constraint regardless of high objective score", async () => {
      const mandate = createBaseMandate();

      // Optimizer proposes a "high-scoring" plan (score: 0.98) that attempts to bypass security review
      const violatingPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.98,
        planId: "plan-optimizer-fast-path",
        proposerAgentId: "agent-optimizer-01",
        steps: [
          {
            actionClass: "INVENTORY_ADJUST",
            actionId: "act-adjust-01",
            dependencies: [],
            estimatedCost: 20,
            parameters: {
              amount: 100,
              itemId: "inventory:item-101",
              skipSecurityReview: true, // Violates REQUIRE_HUMAN_SECURITY_REVIEW!
            },
            riskBand: "LOW",
            stepId: "step-1",
            targetObjectId: "inventory:item-101",
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.validatePlanDAG(violatingPlan, mandate)
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("MANDATORY_CONSTRAINT_VIOLATED");
        expect(causeStr).toContain("REQUIRE_HUMAN_SECURITY_REVIEW");
      }
    });

    it("does validate compliant plan DAG with dependencies", async () => {
      const mandate = createBaseMandate();

      const compliantPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.85,
        planId: "plan-compliant-replenishment",
        proposerAgentId: "agent-optimizer-01",
        steps: [
          {
            actionClass: "INVENTORY_ADJUST",
            actionId: "act-inspect",
            dependencies: [],
            estimatedCost: 10,
            parameters: { itemId: "inventory:item-101" },
            riskBand: "LOW",
            stepId: "step-1-inspect",
            targetObjectId: "inventory:item-101",
          },
          {
            actionClass: "PURCHASE_ORDER",
            actionId: "act-po",
            dependencies: ["step-1-inspect"],
            estimatedCost: 50,
            parameters: { orderId: "warehouse:ord-999" },
            riskBand: "MEDIUM",
            stepId: "step-2-purchase",
            targetObjectId: "warehouse:ord-999",
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* runner.validatePlanDAG(compliantPlan, mandate);
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("DAG-001 & DAG-002: Graph Integrity and Envelope Validation", () => {
    it("does reject plan DAG containing circular dependencies (DAG-001)", async () => {
      const mandate = createBaseMandate();

      // Step 1 depends on Step 2; Step 2 depends on Step 1 (Cycle)
      const cyclicPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.7,
        planId: "plan-cyclic",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "INVENTORY_ADJUST",
            actionId: "act-1",
            dependencies: ["step-2"],
            estimatedCost: 10,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-1",
            targetObjectId: "inventory:item-101",
          },
          {
            actionClass: "PURCHASE_ORDER",
            actionId: "act-2",
            dependencies: ["step-1"],
            estimatedCost: 10,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-2",
            targetObjectId: "warehouse:ord-999",
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(runner.validatePlanDAG(cyclicPlan, mandate));
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("CYCLE_DETECTED");
      }
    });

    it("does reject plan with unlisted action class (DAG-002)", async () => {
      const mandate = createBaseMandate();

      const unlistedActionPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.5,
        planId: "plan-unlisted-action",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "UNAUTHORIZED_TRANSFER", // Not in allowedActionClasses!
            actionId: "act-transfer",
            dependencies: [],
            estimatedCost: 10,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-1",
            targetObjectId: "inventory:item-101",
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.validatePlanDAG(unlistedActionPlan, mandate)
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("UNAUTHORIZED_ACTION_CLASS");
      }
    });

    it("does reject plan with target object outside authorized set (DAG-002)", async () => {
      const mandate = createBaseMandate();

      const outOfSetPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.5,
        planId: "plan-out-of-set-object",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "INVENTORY_ADJUST",
            actionId: "act-adjust",
            dependencies: [],
            estimatedCost: 10,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-1",
            targetObjectId: "payroll:employee-555", // Not in objectSet!
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.validatePlanDAG(outOfSetPlan, mandate)
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("UNAUTHORIZED_TARGET_OBJECT");
      }
    });

    it("does reject plan when risk band exceeds mandate maximum", async () => {
      const mandate = createBaseMandate(); // maxRiskBand: MEDIUM

      const highRiskPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.9,
        planId: "plan-high-risk",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "INVENTORY_ADJUST",
            actionId: "act-adjust",
            dependencies: [],
            estimatedCost: 10,
            parameters: {},
            riskBand: "HIGH", // Exceeds MEDIUM!
            stepId: "step-1",
            targetObjectId: "inventory:item-101",
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.validatePlanDAG(highRiskPlan, mandate)
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("RISK_BAND_EXCEEDED");
      }
    });

    it("does reject plan when total estimated cost exceeds available budget", async () => {
      const mandate = createBaseMandate(); // budgetLimit: 500, spentBudget: 50 => remaining 450

      const overBudgetPlan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.9,
        planId: "plan-over-budget",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "PURCHASE_ORDER",
            actionId: "act-po-huge",
            dependencies: [],
            estimatedCost: 500, // 500 + 50 = 550 > 500
            parameters: {},
            riskBand: "LOW",
            stepId: "step-1",
            targetObjectId: "warehouse:ord-999",
          },
        ],
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.validatePlanDAG(overBudgetPlan, mandate)
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("BUDGET_EXCEEDED");
      }
    });
  });

  describe("DAG-003 & DAG-004: Stop Conditions and Step Execution", () => {
    it("does halt execution when deadline is expired (DAG-003)", async () => {
      const mandate = createBaseMandate({ deadline: 5000 });

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.checkStopConditions(mandate, {
            currentSpentBudget: 10,
            currentTime: 6000, // Expired!
          })
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("StopConditionTriggeredError");
        expect(causeStr).toContain("EXPIRED_DEADLINE");
      }
    });

    it("does halt execution when safety tripwire is activated (DAG-003)", async () => {
      const mandate = createBaseMandate();

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.checkStopConditions(mandate, {
            activeTripwires: ["LOCKDOWN_TRIPWIRE"],
            currentSpentBudget: 10,
            currentTime: 1000,
          })
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("StopConditionTriggeredError");
        expect(causeStr).toContain("SAFETY_TRIPWIRE");
      }
    });

    it("does execute plan step when dependencies are satisfied and budget is within limit (DAG-004)", async () => {
      const mandate = createBaseMandate();

      const plan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.8,
        planId: "plan-exec-test",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "INVENTORY_ADJUST",
            actionId: "act-1",
            dependencies: [],
            estimatedCost: 25,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-1",
            targetObjectId: "inventory:item-101",
          },
          {
            actionClass: "PURCHASE_ORDER",
            actionId: "act-2",
            dependencies: ["step-1"],
            estimatedCost: 35,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-2",
            targetObjectId: "warehouse:ord-999",
          },
        ],
      };

      // World state where step-1 is already completed
      const worldState: MissionWorldState = {
        objects: new Map(),
        receipts: new Map([
          [
            "step-1",
            {
              actionId: "step-1",
              status: "COMPLETED",
            },
          ],
        ]),
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* runner.executePlanStep({
          context: {
            currentSpentBudget: 100,
            currentTime: 2000,
          },
          mandate,
          plan,
          stepId: "step-2",
          worldState,
        });
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.stepId).toBe("step-2");
      expect(result.status).toBe("EXECUTED");
      expect(result.newSpentBudget).toBe(135); // 100 + 35
    });

    it("does fail step execution when dependency is unmet", async () => {
      const mandate = createBaseMandate();

      const plan: PlanDAG = {
        mandateId: mandate.mandateId,
        objectiveScore: 0.8,
        planId: "plan-exec-test",
        proposerAgentId: "agent-01",
        steps: [
          {
            actionClass: "PURCHASE_ORDER",
            actionId: "act-2",
            dependencies: ["step-unmet"],
            estimatedCost: 35,
            parameters: {},
            riskBand: "LOW",
            stepId: "step-2",
            targetObjectId: "warehouse:ord-999",
          },
        ],
      };

      const emptyWorldState: MissionWorldState = {
        objects: new Map(),
        receipts: new Map(),
      };

      const program = Effect.gen(function* () {
        const runner = yield* MissionRunnerService;
        return yield* Effect.exit(
          runner.executePlanStep({
            context: {
              currentSpentBudget: 100,
              currentTime: 2000,
            },
            mandate,
            plan,
            stepId: "step-2",
            worldState: emptyWorldState,
          })
        );
      }).pipe(Effect.provide(MissionRunnerServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("PlanValidationError");
        expect(causeStr).toContain("step-unmet");
      }
    });
  });
});
