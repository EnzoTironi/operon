import type {
  MissionOutcomeEvaluation,
  MissionStatus,
  MissionTaskMandate,
  ObservablePredicate,
  PlanDAG,
  PlanStep,
  PlanValidationResult,
  PredicateEvaluationResult,
} from "@operon/schema";
import { isObjectInSet, isRiskBandAllowed } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Context, Effect, Layer, Match } from "effect";

import {
  FictionalSuccessRejectedError,
  PlanValidationError,
  StopConditionTriggeredError,
} from "../actions-errors.js";

/**
 * World state representation for independent mission evaluation
 */
export interface MissionWorldState {
  readonly customAssertions?: ReadonlyMap<
    string,
    (params?: Record<string, unknown>) => boolean
  >;
  readonly objects: ReadonlyMap<
    string,
    {
      readonly properties: Record<string, unknown>;
      readonly state?: string;
    }
  >;
  readonly receipts: ReadonlyMap<
    string,
    {
      readonly actionClass?: string;
      readonly actionId: string;
      readonly status: "COMPLETED" | "EXECUTED" | "FAILED" | "PENDING";
    }
  >;
}

/**
 * Result of executing a single validated plan step
 */
export interface PlanStepExecutionResult {
  readonly confirmedAt: number;
  readonly newSpentBudget: number;
  readonly receiptId: string;
  readonly status: "COMPLETED" | "EXECUTED";
  readonly stepId: string;
}

/**
 * Execution context for stop conditions and budget checking
 */
export interface MissionExecutionContext {
  readonly activeTripwires?: readonly string[];
  readonly currentSpentBudget: number;
  readonly currentTime: number;
}

export interface ExecutePlanStepOptions {
  readonly mandate: MissionTaskMandate;
  readonly plan: PlanDAG;
  readonly stepId: string;
  readonly worldState: MissionWorldState;
  readonly context: MissionExecutionContext;
}

/**
 * Service governing Verifiable Mission Objectives and Planning DAGs (S12 / OPR-FULL-021, OPR-FULL-023)
 */
export class MissionRunnerService extends Context.Service<
  MissionRunnerService,
  {
    readonly checkStopConditions: (
      mandate: MissionTaskMandate,
      context: MissionExecutionContext
    ) => Effect.Effect<void, StopConditionTriggeredError>;

    readonly evaluateMissionOutcome: (
      mandate: MissionTaskMandate,
      worldState: MissionWorldState,
      plannerReportedDone: boolean
    ) => Effect.Effect<MissionOutcomeEvaluation, never>;

    readonly executePlanStep: (
      options: ExecutePlanStepOptions
    ) => Effect.Effect<
      PlanStepExecutionResult,
      PlanValidationError | StopConditionTriggeredError
    >;

    readonly validatePlanDAG: (
      plan: PlanDAG,
      mandate: MissionTaskMandate
    ) => Effect.Effect<PlanValidationResult, PlanValidationError>;

    readonly verifyMissionCompletion: (
      mandate: MissionTaskMandate,
      worldState: MissionWorldState,
      plannerReportedDone: boolean
    ) => Effect.Effect<MissionOutcomeEvaluation, FictionalSuccessRejectedError>;
  }
>()("operon/runtime/MissionRunnerService") {}

function buildPlanStepMap(steps: readonly PlanStep[]): Map<string, PlanStep> {
  const stepMap = new Map<string, PlanStep>();
  for (const step of steps) {
    stepMap.set(step.stepId, step);
  }
  return stepMap;
}

function buildAdjacencyAndInDegree(
  steps: readonly PlanStep[],
  stepMap: Map<string, PlanStep>
): {
  adjacency: Map<string, string[]>;
  inDegree: Map<string, number>;
  violations: string[];
} {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const violations: string[] = [];

  for (const step of steps) {
    inDegree.set(step.stepId, step.dependencies.length);
    for (const dep of step.dependencies) {
      if (!stepMap.has(dep)) {
        violations.push(
          `Step '${step.stepId}' references missing dependency '${dep}'`
        );
      }
      const list = adjacency.get(dep) ?? [];
      list.push(step.stepId);
      adjacency.set(dep, list);
    }
  }

  return { adjacency, inDegree, violations };
}

function runTopologicalSort(
  inDegree: Map<string, number>,
  adjacency: Map<string, string[]>
): number {
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let visitedCount = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    visitedCount += 1;
    const dependents = adjacency.get(current) ?? [];
    for (const dep of dependents) {
      const currentDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, currentDeg);
      if (currentDeg === 0) {
        queue.push(dep);
      }
    }
  }
  return visitedCount;
}

/**
 * Validates a plan DAG against mandate envelope, cycles, and mandatory constraints
 */
function validatePlanDagAcyclic(
  plan: PlanDAG
): Effect.Effect<void, PlanValidationError> {
  const stepMap = buildPlanStepMap(plan.steps);
  const { adjacency, inDegree, violations } = buildAdjacencyAndInDegree(
    plan.steps,
    stepMap
  );

  if (violations.length > 0) {
    return new PlanValidationError({
      message: `Plan '${plan.planId}' has missing dependencies: ${violations.join(", ")}`,
      planId: plan.planId,
      reason: "CYCLE_DETECTED",
      violations,
    });
  }

  const visitedCount = runTopologicalSort(inDegree, adjacency);
  if (visitedCount !== plan.steps.length) {
    return new PlanValidationError({
      message: `Plan '${plan.planId}' contains a circular dependency (DAG cycle detected)`,
      planId: plan.planId,
      reason: "CYCLE_DETECTED",
      violations: [
        `Circular dependency detected: visited ${visitedCount} of ${plan.steps.length} steps`,
      ],
    });
  }

  return Effect.void;
}

function validatePlanEnvelope(
  plan: PlanDAG,
  envelope: MissionTaskMandate["envelope"]
): Effect.Effect<void, PlanValidationError> {
  for (const step of plan.steps) {
    if (!envelope.allowedActionClasses.includes(step.actionClass)) {
      return new PlanValidationError({
        message: `Step '${step.stepId}' action class '${step.actionClass}' not allowed in envelope`,
        planId: plan.planId,
        reason: "UNAUTHORIZED_ACTION_CLASS",
        violations: [
          `Action class '${step.actionClass}' is not in allowed classes [${envelope.allowedActionClasses.join(", ")}]`,
        ],
      });
    }

    if (!isObjectInSet(envelope.objectSet, step.targetObjectId)) {
      return new PlanValidationError({
        message: `Step '${step.stepId}' target object '${step.targetObjectId}' is outside mandate object set`,
        planId: plan.planId,
        reason: "UNAUTHORIZED_TARGET_OBJECT",
        violations: [
          `Target object '${step.targetObjectId}' not in allowed set [${envelope.objectSet.join(", ")}]`,
        ],
      });
    }

    if (!isRiskBandAllowed(envelope.maxRiskBand, step.riskBand)) {
      return new PlanValidationError({
        message: `Step '${step.stepId}' risk band '${step.riskBand}' exceeds mandate max risk band '${envelope.maxRiskBand}'`,
        planId: plan.planId,
        reason: "RISK_BAND_EXCEEDED",
        violations: [
          `Risk band '${step.riskBand}' exceeds allowed '${envelope.maxRiskBand}'`,
        ],
      });
    }
  }

  const totalCost = plan.steps.reduce(
    (sum, step) => sum + step.estimatedCost,
    0
  );
  if (envelope.spentBudget + totalCost > envelope.budgetLimit) {
    return new PlanValidationError({
      message: `Plan '${plan.planId}' estimated cost ${totalCost} + spent ${envelope.spentBudget} exceeds budget limit ${envelope.budgetLimit}`,
      planId: plan.planId,
      reason: "BUDGET_EXCEEDED",
      violations: [
        `Total estimated cost ${totalCost + envelope.spentBudget} exceeds limit ${envelope.budgetLimit}`,
      ],
    });
  }

  return Effect.void;
}

type MandatoryConstraint = Extract<
  MissionTaskMandate["stopConditions"][number],
  { _tag: "MANDATORY_CONSTRAINT" }
>;

function checkStepConstraintViolation(
  step: PlanStep,
  cond: MandatoryConstraint
): boolean {
  const params = step.parameters;
  const attemptsBypass =
    params.skipSecurityReview === true ||
    params.bypassConstraint === true ||
    params.overridePolicy === true;

  return (
    attemptsBypass ||
    (params.forbiddenFlag === true &&
      cond.constraintId.includes("NO_FORBIDDEN_FLAG")) ||
    (params.unauthorizedMutation === true &&
      cond.constraintId.includes("READ_ONLY_PROD"))
  );
}

function validateMandatoryConstraints(
  plan: PlanDAG,
  stopConditions: MissionTaskMandate["stopConditions"]
): Effect.Effect<void, PlanValidationError> {
  for (const cond of stopConditions) {
    if (cond._tag === "MANDATORY_CONSTRAINT") {
      for (const step of plan.steps) {
        if (checkStepConstraintViolation(step, cond)) {
          return new PlanValidationError({
            message: `Plan '${plan.planId}' violates mandatory constraint '${cond.constraintId}': ${cond.description} (objective score: ${plan.objectiveScore})`,
            planId: plan.planId,
            reason: "MANDATORY_CONSTRAINT_VIOLATED",
            violations: [
              `Step '${step.stepId}' violates mandatory constraint '${cond.constraintId}': ${cond.description}`,
            ],
          });
        }
      }
    }
  }

  return Effect.void;
}

/**
 * Validates a plan DAG against mandate envelope, cycles, and mandatory constraints
 */
function validatePlan(
  plan: PlanDAG,
  mandate: MissionTaskMandate
): Effect.Effect<PlanValidationResult, PlanValidationError> {
  if (plan.steps.length === 0) {
    return new PlanValidationError({
      message: `Plan '${plan.planId}' has no steps`,
      planId: plan.planId,
      reason: "MANDATORY_CONSTRAINT_VIOLATED",
      violations: ["Plan must contain at least one step"],
    });
  }

  return Effect.gen(function* () {
    yield* validatePlanDagAcyclic(plan);
    yield* validatePlanEnvelope(plan, mandate.envelope);
    yield* validateMandatoryConstraints(plan, mandate.stopConditions);

    return {
      isValid: true,
      planId: plan.planId,
      violations: [],
    };
  });
}

/**
 * Checks active stop conditions (deadlines, budgets, safety tripwires)
 */
function evaluateStopConditions(
  mandate: MissionTaskMandate,
  context: MissionExecutionContext
): Effect.Effect<void, StopConditionTriggeredError> {
  // 1. Deadline check
  if (context.currentTime > mandate.deadline) {
    return new StopConditionTriggeredError({
      conditionType: "EXPIRED_DEADLINE",
      detail: `Current time ${context.currentTime} exceeds mission deadline ${mandate.deadline}`,
      mandateId: mandate.mandateId,
      message: `Stop condition triggered: Mission deadline expired`,
    });
  }

  // 2. Budget check
  if (context.currentSpentBudget >= mandate.envelope.budgetLimit) {
    return new StopConditionTriggeredError({
      conditionType: "MAX_BUDGET_EXCEEDED",
      detail: `Spent budget ${context.currentSpentBudget} reached or exceeded limit ${mandate.envelope.budgetLimit}`,
      mandateId: mandate.mandateId,
      message: `Stop condition triggered: Maximum budget exceeded`,
    });
  }

  // 3. Safety tripwire check
  if (context.activeTripwires && context.activeTripwires.length > 0) {
    for (const cond of mandate.stopConditions) {
      if (
        cond._tag === "SAFETY_TRIPWIRE" &&
        context.activeTripwires.includes(cond.tripwireId)
      ) {
        return new StopConditionTriggeredError({
          conditionType: "SAFETY_TRIPWIRE",
          detail: `Safety tripwire '${cond.tripwireId}' triggered: ${cond.reason}`,
          mandateId: mandate.mandateId,
          message: `Stop condition triggered: Safety tripwire active`,
        });
      }
    }
  }

  return Effect.void;
}

function evalPropertyEquals(
  predicate: Extract<ObservablePredicate, { _tag: "PROPERTY_EQUALS" }>,
  worldState: MissionWorldState
): PredicateEvaluationResult {
  const obj = worldState.objects.get(predicate.objectId);
  if (!obj) {
    return {
      detail: `Target object '${predicate.objectId}' not found in canonical world state`,
      predicate,
      satisfied: false,
    };
  }
  const actualVal = obj.properties[predicate.property];
  const satisfied = actualVal === predicate.expectedValue;
  return {
    detail: satisfied
      ? undefined
      : `Property '${predicate.property}' actual value (${String(actualVal)}) does not equal expected (${String(predicate.expectedValue)})`,
    predicate,
    satisfied,
  };
}

function evalStateMatches(
  predicate: Extract<ObservablePredicate, { _tag: "STATE_MATCHES" }>,
  worldState: MissionWorldState
): PredicateEvaluationResult {
  const obj = worldState.objects.get(predicate.objectId);
  if (!obj) {
    return {
      detail: `Target object '${predicate.objectId}' not found in canonical world state`,
      predicate,
      satisfied: false,
    };
  }
  const satisfied = obj.state === predicate.expectedState;
  return {
    detail: satisfied
      ? undefined
      : `Object state '${obj.state}' does not match expected state '${predicate.expectedState}'`,
    predicate,
    satisfied,
  };
}

function evalReceiptExists(
  predicate: Extract<ObservablePredicate, { _tag: "RECEIPT_EXISTS" }>,
  worldState: MissionWorldState
): PredicateEvaluationResult {
  const receipt = worldState.receipts.get(predicate.actionId);
  if (!receipt) {
    return {
      detail: `Execution receipt for action '${predicate.actionId}' not found`,
      predicate,
      satisfied: false,
    };
  }
  const satisfied = receipt.status === predicate.requiredStatus;
  return {
    detail: satisfied
      ? undefined
      : `Receipt status '${receipt.status}' does not match required '${predicate.requiredStatus}'`,
    predicate,
    satisfied,
  };
}

function evalCustomAssertion(
  predicate: Extract<ObservablePredicate, { _tag: "CUSTOM_ASSERTION" }>,
  worldState: MissionWorldState
): PredicateEvaluationResult {
  const assertionFn = worldState.customAssertions?.get(predicate.assertionId);
  if (!assertionFn) {
    return {
      detail: `Custom assertion '${predicate.assertionId}' not registered in world state`,
      predicate,
      satisfied: false,
    };
  }
  const satisfied = assertionFn(predicate.parameters);
  return {
    detail: satisfied
      ? undefined
      : `Custom assertion '${predicate.assertionId}' returned false`,
    predicate,
    satisfied,
  };
}

/**
 * Independently evaluates an individual observable predicate against canonical world state
 */
function evaluatePredicate(
  predicate: ObservablePredicate,
  worldState: MissionWorldState
): PredicateEvaluationResult {
  return Match.value(predicate).pipe(
    Match.tag("PROPERTY_EQUALS", (p) => evalPropertyEquals(p, worldState)),
    Match.tag("STATE_MATCHES", (p) => evalStateMatches(p, worldState)),
    Match.tag("RECEIPT_EXISTS", (p) => evalReceiptExists(p, worldState)),
    Match.tag("CUSTOM_ASSERTION", (p) => evalCustomAssertion(p, worldState)),
    Match.exhaustive
  );
}

/**
 * Live implementation of MissionRunnerService
 */
export const MissionRunnerServiceLive = Layer.succeed(
  MissionRunnerService,
  MissionRunnerService.of({
    checkStopConditions: Effect.fn("MissionRunnerService.checkStopConditions")(
      (mandate: MissionTaskMandate, context: MissionExecutionContext) =>
        evaluateStopConditions(mandate, context)
    ),

    evaluateMissionOutcome: Effect.fn(
      "MissionRunnerService.evaluateMissionOutcome"
    )(
      (
        mandate: MissionTaskMandate,
        worldState: MissionWorldState,
        plannerReportedDone: boolean
      ) =>
        Effect.sync(() => {
          const predicatesEvaluated: PredicateEvaluationResult[] =
            mandate.successPredicates.map((p) =>
              evaluatePredicate(p, worldState)
            );

          const allPredicatesSatisfied =
            predicatesEvaluated.length > 0 &&
            predicatesEvaluated.every((p) => p.satisfied);

          const fictionalSuccessPrevented =
            plannerReportedDone && !allPredicatesSatisfied;

          let status: MissionStatus;
          if (allPredicatesSatisfied) {
            status = "SUCCEEDED";
          } else if (plannerReportedDone) {
            // OPR-FULL-021 / FULL-ACC-021: Planner claimed done, but predicates not satisfied: mission remains PARTIAL!
            status = "PARTIAL";
          } else if (predicatesEvaluated.some((p) => p.satisfied)) {
            status = "EXECUTING";
          } else {
            status = "PENDING";
          }

          const result: MissionOutcomeEvaluation = {
            allPredicatesSatisfied,
            fictionalSuccessPrevented,
            mandateId: mandate.mandateId,
            plannerReportedDone,
            predicatesEvaluated,
            status,
            stopConditionsTriggered: [],
          };

          OperonTelemetryService.getInstance().trackEvent({
            event: "operon_mission_evaluated",
            properties: {
              allPredicatesSatisfied,
              fictionalSuccessPrevented,
              mandateId: mandate.mandateId,
              plannerReportedDone,
              status,
            },
          });

          return result;
        })
    ),

    executePlanStep: Effect.fn("MissionRunnerService.executePlanStep")(
      function* (
        options: ExecutePlanStepOptions
      ): Effect.fn.Return<
        PlanStepExecutionResult,
        StopConditionTriggeredError | PlanValidationError
      > {
        const { mandate, plan, stepId, worldState, context } = options;
        // 1. Check stop conditions
        yield* evaluateStopConditions(mandate, context);

        // 2. Find step
        const step = plan.steps.find((s) => s.stepId === stepId);
        if (!step) {
          return yield* new PlanValidationError({
            message: `Step '${stepId}' not found in plan '${plan.planId}'`,
            planId: plan.planId,
            reason: "MANDATORY_CONSTRAINT_VIOLATED",
            violations: [`Step '${stepId}' does not exist in plan`],
          });
        }

        // 3. Verify all dependencies have completed receipts
        yield* Effect.forEach(
          step.dependencies,
          (depId) => {
            const depReceipt = worldState.receipts.get(depId);
            const isDone =
              depReceipt &&
              (depReceipt.status === "COMPLETED" ||
                depReceipt.status === "EXECUTED");
            if (!isDone) {
              return new PlanValidationError({
                message: `Step '${stepId}' dependency '${depId}' is not satisfied`,
                planId: plan.planId,
                reason: "MANDATORY_CONSTRAINT_VIOLATED",
                violations: [
                  `Dependency '${depId}' missing completed execution receipt`,
                ],
              });
            }
            return Effect.void;
          },
          { concurrency: 1, discard: true }
        );

        // 4. Budget check for step execution
        const newSpentBudget = context.currentSpentBudget + step.estimatedCost;
        if (newSpentBudget > mandate.envelope.budgetLimit) {
          return yield* new StopConditionTriggeredError({
            conditionType: "MAX_BUDGET_EXCEEDED",
            detail: `Executing step '${stepId}' requires cost ${step.estimatedCost}, which increases spent budget to ${newSpentBudget}, exceeding limit ${mandate.envelope.budgetLimit}`,
            mandateId: mandate.mandateId,
            message: `Stop condition triggered: Step execution exceeds budget limit`,
          });
        }

        const result: PlanStepExecutionResult = {
          confirmedAt: context.currentTime,
          newSpentBudget,
          receiptId: `rcpt-${step.stepId}`,
          status: "EXECUTED",
          stepId: step.stepId,
        };

        return result;
      }
    ),

    validatePlanDAG: Effect.fn("MissionRunnerService.validatePlanDAG")(
      function* (plan: PlanDAG, mandate: MissionTaskMandate) {
        const result = yield* validatePlan(plan, mandate);

        yield* Effect.sync(() => {
          OperonTelemetryService.getInstance().trackEvent({
            event: "operon_plan_validated",
            properties: {
              isValid: result.isValid,
              mandateId: mandate.mandateId,
              planId: plan.planId,
              stepsCount: plan.steps.length,
              violationsCount: result.violations.length,
            },
          });
        });

        return result;
      }
    ),

    verifyMissionCompletion: Effect.fn(
      "MissionRunnerService.verifyMissionCompletion"
    )(function* (
      mandate: MissionTaskMandate,
      worldState: MissionWorldState,
      plannerReportedDone: boolean
    ) {
      const evalEffect = Effect.sync(() => {
        const predicatesEvaluated: PredicateEvaluationResult[] =
          mandate.successPredicates.map((p) =>
            evaluatePredicate(p, worldState)
          );

        const allPredicatesSatisfied =
          predicatesEvaluated.length > 0 &&
          predicatesEvaluated.every((p) => p.satisfied);

        const fictionalSuccessPrevented =
          plannerReportedDone && !allPredicatesSatisfied;

        let status: MissionStatus;
        if (allPredicatesSatisfied) {
          status = "SUCCEEDED";
        } else if (plannerReportedDone) {
          status = "PARTIAL";
        } else if (predicatesEvaluated.some((p) => p.satisfied)) {
          status = "EXECUTING";
        } else {
          status = "PENDING";
        }

        const result: MissionOutcomeEvaluation = {
          allPredicatesSatisfied,
          fictionalSuccessPrevented,
          mandateId: mandate.mandateId,
          plannerReportedDone,
          predicatesEvaluated,
          status,
          stopConditionsTriggered: [],
        };
        return result;
      });

      const evaluation = yield* evalEffect;

      // OPR-FULL-021 / FULL-ACC-021:
      // When model reports done but operation/predicates remain unsatisfied:
      // Reject fictional success with explicit FictionalSuccessRejectedError!
      if (plannerReportedDone && !evaluation.allPredicatesSatisfied) {
        const unsatisfied = evaluation.predicatesEvaluated
          .filter((p) => !p.satisfied)
          .map((p) => p.detail ?? "Predicate unsatisfied");

        return yield* new FictionalSuccessRejectedError({
          mandateId: mandate.mandateId,
          message: `Model reported mission success, but independent kernel evaluation failed: ${unsatisfied.join("; ")}`,
          unsatisfiedPredicates: unsatisfied,
        });
      }

      return evaluation;
    }),
  })
);
