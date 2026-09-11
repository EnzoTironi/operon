import type { Effect } from "effect";
import { Schema } from "effect";

import type { ActionParameters } from "./actions.js";
import type { ObjectInstance } from "./object-type.js";
import type { AgentAuthorizationTier, SecurityContext } from "./security.js";
import { DecisionVerdict } from "./security.js";
import { ActionTypeId, ObjectTypeId } from "./types.js";

export const RiskTier = Schema.Literals(["low", "medium", "high", "critical"]);
export type RiskTier = typeof RiskTier.Type;
export const RiskTierSchema = RiskTier;

export const ExecutionMode = Schema.Literals([
  "manual",
  "proposal",
  "automated",
]);
export type ExecutionMode = typeof ExecutionMode.Type;
export const ExecutionModeSchema = ExecutionMode;

/**
 * Context provided to guard rules during Submission Criteria evaluation
 */
export interface ActionEvaluationContext {
  readonly security: SecurityContext;
  readonly getObject: (
    typeId: ObjectTypeId,
    id: string
  ) => Effect.Effect<ObjectInstance | undefined>;
  readonly now: number;
}

export const CriterionEvaluationPassed = Schema.Struct({
  passed: Schema.Literal(true),
  verdict: Schema.optionalKey(Schema.Literal("allow")),
  failureReason: Schema.optionalKey(Schema.Undefined),
});

export const CriterionEvaluationFailed = Schema.Struct({
  passed: Schema.Literal(false),
  verdict: DecisionVerdict,
  failureReason: Schema.String,
});

export const CriterionEvaluationResult = Schema.Union([
  CriterionEvaluationPassed,
  CriterionEvaluationFailed,
]);
export type CriterionEvaluationResult = typeof CriterionEvaluationResult.Type;

/**
 * Declarative submission criterion / guard (Line 1 verification)
 */
export interface SubmissionCriterion<Params> {
  readonly id: string;
  readonly description: string;
  readonly evaluate: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<CriterionEvaluationResult>;
}

/**
 * Handler for business mutations staged by an action
 */
export type ActionMutationHandler<Params> = (
  params: Params,
  context: ActionEvaluationContext
) => Effect.Effect<readonly ObjectInstance[], Error>;

/**
 * Definition of an Action Side Effect
 */
export interface ActionSideEffect<Params = ActionParameters> {
  readonly id: string;
  readonly description: string;
  readonly execute: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<void, Error>;
  readonly compensate?: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<void>;
}

/**
 * Definition of an Action Type
 */
export interface ActionType<Params = ActionParameters> {
  readonly id: ActionTypeId;
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: Schema.Schema<Params>;
  readonly targetObjectTypeId?: ObjectTypeId;
  readonly riskTier: RiskTier;
  readonly defaultExecutionMode: ExecutionMode;
  readonly minimumAgentTier: AgentAuthorizationTier;
  readonly submissionCriteria: readonly SubmissionCriterion<Params>[];
  readonly requiredFreshnessProperties?: readonly {
    readonly objectTypeId: ObjectTypeId;
    readonly propertyName: string;
    readonly maxStalenessMs: number;
  }[];
  readonly mutation?: ActionMutationHandler<Params>;
  readonly sideEffects?: readonly ActionSideEffect<Params>[];
}

export function defineActionType<Params = ActionParameters>(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: Schema.Schema<Params>;
  readonly targetObjectTypeId?: string;
  readonly riskTier: RiskTier;
  readonly defaultExecutionMode: ExecutionMode;
  readonly minimumAgentTier: AgentAuthorizationTier;
  readonly submissionCriteria?: readonly SubmissionCriterion<Params>[];
  readonly requiredFreshnessProperties?: readonly {
    readonly objectTypeId: string;
    readonly propertyName: string;
    readonly maxStalenessMs: number;
  }[];
  readonly mutation?: ActionMutationHandler<Params>;
  readonly sideEffects?: readonly ActionSideEffect<Params>[];
}): ActionType<Params> {
  return {
    ...config,
    id: ActionTypeId.make(config.id),
    mutation: config.mutation,
    requiredFreshnessProperties: config.requiredFreshnessProperties?.map(
      (p) => ({
        ...p,
        objectTypeId: ObjectTypeId.make(p.objectTypeId),
      })
    ),
    sideEffects: config.sideEffects,
    submissionCriteria: config.submissionCriteria ?? [],
    targetObjectTypeId: config.targetObjectTypeId
      ? ObjectTypeId.make(config.targetObjectTypeId)
      : undefined,
  };
}
