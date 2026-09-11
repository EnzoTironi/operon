import { Schema } from "effect";

/**
 * Formal assurance report outcome classification (S19, OPR-FULL-026, OPR-FULL-029)
 */
export const FormalAssuranceOutcomeSchema = Schema.Literals([
  "PROVEN_IN_MODEL",
  "COUNTEREXAMPLE",
  "BOUNDED_NO_COUNTEREXAMPLE",
  "INCONCLUSIVE",
  "TIMEOUT",
  "UNSUPPORTED",
]);

export type FormalAssuranceOutcome = Schema.Schema.Type<
  typeof FormalAssuranceOutcomeSchema
>;

/**
 * Declared executable fragment for formal assurance (S19)
 */
export const FormalExecutableFragmentSchema = Schema.Struct({
  assumptions: Schema.Array(Schema.String),
  fragmentId: Schema.String,
  solverVersion: Schema.String,
  supportedActions: Schema.Array(Schema.String),
  supportedTypes: Schema.Array(Schema.String),
});

export type FormalExecutableFragment = Schema.Schema.Type<
  typeof FormalExecutableFragmentSchema
>;

/**
 * Formal assurance case report documenting assumptions, bounds, and outcomes (S19, OPR-FULL-026)
 */
export const AssuranceCaseSchema = Schema.Struct({
  candidateDigest: Schema.String,
  caseId: Schema.String,
  counterexampleFixture: Schema.optional(Schema.String),
  fragment: FormalExecutableFragmentSchema,
  outcome: FormalAssuranceOutcomeSchema,
  searchDepthBound: Schema.optional(Schema.Number),
  verifiedAt: Schema.Number,
});

export type AssuranceCase = Schema.Schema.Type<typeof AssuranceCaseSchema>;

/**
 * Action execution record in a simulation scenario (S19, OPR-FULL-028)
 */
export const ScenarioActionRecordSchema = Schema.Struct({
  actionName: Schema.String,
  simulated: Schema.Boolean,
});

export type ScenarioActionRecord = Schema.Schema.Type<
  typeof ScenarioActionRecordSchema
>;

/**
 * Simulation scenario plan and sandbox containment boundary (S19, OPR-FULL-028)
 */
export const ScenarioExecutionPlanSchema = Schema.Struct({
  actions: Schema.Array(ScenarioActionRecordSchema),
  containedInSandbox: Schema.Boolean,
  realCredentialsExposed: Schema.Boolean,
  scenarioId: Schema.String,
});

export type ScenarioExecutionPlan = Schema.Schema.Type<
  typeof ScenarioExecutionPlanSchema
>;

/**
 * Compiler Gate I verification verdict: rules respected without over-restriction (S19)
 */
export const GateIVerdictSchema = Schema.Struct({
  arbitrarilyBlockedCount: Schema.Number,
  overRestricted: Schema.Boolean,
  passed: Schema.Boolean,
  respectedRules: Schema.Array(Schema.String),
});

export type GateIVerdict = Schema.Schema.Type<typeof GateIVerdictSchema>;

/**
 * Compiler Gate II verification verdict: knowledge admission against evidence and policy (S19)
 */
export const GateIIVerdictSchema = Schema.Struct({
  admitted: Schema.Boolean,
  claimId: Schema.String,
  evidencePointers: Schema.Array(Schema.String),
  policySatisfied: Schema.Boolean,
});

export type GateIIVerdict = Schema.Schema.Type<typeof GateIIVerdictSchema>;
