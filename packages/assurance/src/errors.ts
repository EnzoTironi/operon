import { Data } from "effect";

/**
 * F1TamperError (V0-CH-10 / S17):
 * Candidate attempted to self-approve or modify oracle, expected result, or threshold.
 */
export class F1TamperError extends Data.TaggedError("F1TamperError")<{
  readonly reason: string;
  readonly target?: string;
}> {}

/**
 * F1EmptyAssertionsError (V0-CH-10 / S17):
 * Test suite contains missing, skipped, duplicate, or zero-assertion test cases.
 */
export class F1EmptyAssertionsError extends Data.TaggedError(
  "F1EmptyAssertionsError"
)<{
  readonly caseId: string;
  readonly reason: string;
}> {}

/**
 * F1SignatureVerificationError (V0-CH-10 / S17):
 * Cryptographic Ed25519 signature on F1 receipt failed verification.
 */
export class F1SignatureVerificationError extends Data.TaggedError(
  "F1SignatureVerificationError"
)<{
  readonly candidateDigest: string;
  readonly signature: string;
}> {}

/**
 * F1IdempotencyConflictError (V0-CH-10):
 * Same idempotency key provided with different evaluation inputs.
 */
export class F1IdempotencyConflictError extends Data.TaggedError(
  "F1IdempotencyConflictError"
)<{
  readonly idempotencyKey: string;
  readonly details: string;
}> {}

/**
 * F2ConsentViolationError (V0-CH-11 / S17):
 * Consent scope missing, expired, or participant mismatch in real-company mirror.
 */
export class F2ConsentViolationError extends Data.TaggedError(
  "F2ConsentViolationError"
)<{
  readonly participantId: string;
  readonly reason: string;
}> {}

/**
 * F2InternalBypassError (V0-CH-11 / S17):
 * External agent attempted kernel bypass instead of public contracts.
 */
export class F2InternalBypassError extends Data.TaggedError(
  "F2InternalBypassError"
)<{
  readonly actorId: string;
  readonly attemptedPath: string;
  readonly reason: string;
}> {}

/**
 * F2MissingCorrectionError (V0-CH-11 / S17):
 * No traceable correction recorded during real-company mirror evaluation.
 */
export class F2MissingCorrectionError extends Data.TaggedError(
  "F2MissingCorrectionError"
)<{
  readonly participantId: string;
  readonly reason: string;
}> {}

/**
 * PublicationLeakError (V0-CH-12 / S11 / S17):
 * Protected benchmark material, gold output, or private oracle detected in public artifact.
 */
export class PublicationLeakError extends Data.TaggedError(
  "PublicationLeakError"
)<{
  readonly path: string;
  readonly violation: string;
  readonly matchedDigest?: string;
}> {}

/**
 * NonDisclosureError (V0-CH-01 / V0-CH-10 / V0-CH-11 / S17):
 * Non-disclosure boundary: wrong tenant, environment, or resource does not reveal existence.
 */
export class NonDisclosureError extends Data.TaggedError("NonDisclosureError")<{
  readonly code: "NOT_FOUND" | "DENIED";
  readonly message: string;
}> {}

/**
 * UnapprovedTaskContractError (S17 / OPR-FULL-051 / FULL-ACC-051):
 * Agent attempted protected write without an approved task contract.
 */
export class UnapprovedTaskContractError extends Data.TaggedError(
  "UnapprovedTaskContractError"
)<{
  readonly message: string;
  readonly missingRequirements: readonly string[];
  readonly taskId: string;
}> {}

/**
 * AdversarialScenarioTamperError (S17 / OPR-FULL-052 / FULL-ACC-052):
 * Implementer diff deleted or tampered with protected adversarial scenarios.
 */
export class AdversarialScenarioTamperError extends Data.TaggedError(
  "AdversarialScenarioTamperError"
)<{
  readonly message: string;
  readonly removedScenarios: readonly string[];
}> {}

/**
 * ContractRevisionConflictError (S17 / OPR-FULL-053 / FULL-ACC-053):
 * Release assembly detected incompatible interface revisions across parallel modules.
 */
export class ContractRevisionConflictError extends Data.TaggedError(
  "ContractRevisionConflictError"
)<{
  readonly conflictingModules: readonly {
    readonly moduleId: string;
    readonly version: string;
  }[];
  readonly contractId: string;
  readonly message: string;
}> {}

/**
 * ExternalGateRequiredError (S17 / OPR-FULL-054 / FULL-ACC-054):
 * Platform attempted self-modification of executor without satisfying external publication gate.
 */
export class ExternalGateRequiredError extends Data.TaggedError(
  "ExternalGateRequiredError"
)<{
  readonly message: string;
  readonly policyDigest: string;
  readonly targetComponent: string;
}> {}

/**
 * EvidenceMutationRejectedError (S17):
 * Candidate observation ledger contains dropped, duplicated, or zero-assertion test cases, or an untrusted runner.
 */
export class EvidenceMutationRejectedError extends Data.TaggedError(
  "EvidenceMutationRejectedError"
)<{
  readonly details: string;
  readonly message: string;
  readonly mutationType:
    | "DROPPED_CASE"
    | "DUPLICATE_CASE"
    | "ZERO_ASSERTIONS"
    | "UNTRUSTED_RUNNER"
    | "RECEIPT_TAMPERED";
}> {}
