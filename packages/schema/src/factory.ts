import { Schema } from "effect";

/**
 * Normative requirement case specification in the immutable requirements ledger (S17)
 */
export const NormativeCaseRequirementSchema = Schema.Struct({
  caseId: Schema.String,
  description: Schema.String,
  expectedOutcome: Schema.Literal("PASS", "FAIL"),
  isProtected: Schema.Boolean,
  minimumAssertions: Schema.Number,
  requirementId: Schema.String,
});

export type NormativeCaseRequirement = Schema.Schema.Type<
  typeof NormativeCaseRequirementSchema
>;

/**
 * Immutable normative requirements ledger defining the authoritative test & contract universe (S17)
 */
export const NormativeLedgerSchema = Schema.Struct({
  digest: Schema.String,
  ledgerId: Schema.String,
  requirements: Schema.Array(NormativeCaseRequirementSchema),
  version: Schema.String,
});

export type NormativeLedger = Schema.Schema.Type<typeof NormativeLedgerSchema>;

/**
 * Candidate observation recording an empirical test execution result (S17)
 */
export const CandidateObservationSchema = Schema.Struct({
  assertionCount: Schema.Number,
  caseId: Schema.String,
  executionReceiptHash: Schema.String,
  observedAt: Schema.Number,
  status: Schema.Literal("PASS", "FAIL", "INCONCLUSIVE"),
});

export type CandidateObservation = Schema.Schema.Type<
  typeof CandidateObservationSchema
>;

/**
 * Candidate observations ledger containing all test run evidence and runner attestations (S17)
 */
export const CandidateObservationLedgerSchema = Schema.Struct({
  candidateDigest: Schema.String,
  observations: Schema.Array(CandidateObservationSchema),
  runnerId: Schema.String,
  signature: Schema.String,
});

export type CandidateObservationLedger = Schema.Schema.Type<
  typeof CandidateObservationLedgerSchema
>;

/**
 * Declaration of contract version and ownership across parallel modules (S17, OPR-FULL-053)
 */
export const ContractVersionDeclarationSchema = Schema.Struct({
  contractId: Schema.String,
  interfaceVersion: Schema.String,
  moduleId: Schema.String,
  owner: Schema.String,
});

export type ContractVersionDeclaration = Schema.Schema.Type<
  typeof ContractVersionDeclarationSchema
>;

/**
 * Factory task contract declaring inputs, scope, dependencies, and required evidence (S17, OPR-FULL-051)
 */
export const FactoryTaskContractSchema = Schema.Struct({
  approved: Schema.Boolean,
  dependencies: Schema.Array(Schema.String),
  inputs: Schema.Array(Schema.String),
  requiredEvidence: Schema.Array(Schema.String),
  scope: Schema.Array(Schema.String),
  taskId: Schema.String,
});

export type FactoryTaskContract = Schema.Schema.Type<
  typeof FactoryTaskContractSchema
>;
