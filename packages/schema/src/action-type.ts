import type { Effect, Schema } from "effect";

import type { ObjectInstance } from "./object-type.js";
import type {
  AgentAuthorizationTier,
  DecisionVerdict,
  SecurityContext,
} from "./security.js";
import type { ActionTypeId, ObjectTypeId } from "./types.js";

export type RiskTier = "low" | "medium" | "high" | "critical";

export type ExecutionMode = "manual" | "proposal" | "automated";

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

/**
 * Declarative submission criterion / guard (Line 1 verification)
 */
export interface SubmissionCriterion<Params> {
  readonly id: string;
  readonly description: string;
  readonly evaluate: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<{
    readonly passed: boolean;
    readonly verdict?: DecisionVerdict;
    readonly failureReason?: string;
  }>;
}

/**
 * Handler for business mutations staged by an action
 */
export type ActionMutationHandler<Params> = (
  params: Params,
  context: ActionEvaluationContext
) => Effect.Effect<readonly ObjectInstance[], Error>;

/**
 * Definition of an Action Type
 */
export interface ActionType<Params = any> {
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
  readonly sideEffects?: readonly {
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
  }[];
}

export function defineActionType<Params>(config: {
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
  readonly sideEffects?: readonly {
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
  }[];
}): ActionType<Params> {
  return {
    ...config,
    id: config.id as ActionTypeId,
    mutation: config.mutation,
    requiredFreshnessProperties: config.requiredFreshnessProperties?.map(
      (p) => ({
        ...p,
        objectTypeId: p.objectTypeId as ObjectTypeId,
      })
    ),
    sideEffects: config.sideEffects,
    submissionCriteria: config.submissionCriteria ?? [],
    targetObjectTypeId: config.targetObjectTypeId as ObjectTypeId | undefined,
  };
}
