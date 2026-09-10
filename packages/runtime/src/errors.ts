import { Data } from "effect";

export class ParameterValidationError extends Data.TaggedError(
  "ParameterValidationError"
)<{
  readonly actionTypeId: string;
  readonly message: string;
  readonly details?: unknown;
}> {}

export class PermissionDeniedError extends Data.TaggedError(
  "PermissionDeniedError"
)<{
  readonly subjectId: string;
  readonly actionTypeId: string;
  readonly reason: string;
}> {}

export class SubmissionCriteriaFailedError extends Data.TaggedError(
  "SubmissionCriteriaFailedError"
)<{
  readonly actionTypeId: string;
  readonly criterionId: string;
  readonly reason: string;
  readonly verdict: "deny" | "review";
}> {}

export class FreshnessBudgetExceededError extends Data.TaggedError(
  "FreshnessBudgetExceededError"
)<{
  readonly objectId: string;
  readonly propertyName: string;
  readonly currentAgeMs: number;
  readonly maxAllowedStalenessMs: number;
}> {}

export class ObjectNotFoundError extends Data.TaggedError(
  "ObjectNotFoundError"
)<{
  readonly objectTypeId: string;
  readonly objectId: string;
}> {}

export class ConcurrentModificationError extends Data.TaggedError(
  "ConcurrentModificationError"
)<{
  readonly objectId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}> {}

export class SideEffectExecutionError extends Data.TaggedError(
  "SideEffectExecutionError"
)<{
  readonly sideEffectId: string;
  readonly cause: unknown;
}> {}

export class CompensationFailedError extends Data.TaggedError(
  "CompensationFailedError"
)<{
  readonly sideEffectId: string;
  readonly cause: unknown;
}> {}

export class ProposalNotFoundError extends Data.TaggedError(
  "ProposalNotFoundError"
)<{
  readonly proposalId: string;
  readonly message: string;
}> {}

export class ProposalExecutionStateError extends Data.TaggedError(
  "ProposalExecutionStateError"
)<{
  readonly proposalId: string;
  readonly message: string;
}> {}

export class AuthenticationError extends Data.TaggedError(
  "AuthenticationError"
)<{
  readonly reason: string;
}> {}

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly reason: string;
}> {}

export class IdempotencyConflictError extends Data.TaggedError(
  "IdempotencyConflictError"
)<{
  readonly idempotencyKey: string;
  readonly message: string;
}> {}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly entityId: string;
  readonly message: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly entityId: string;
  readonly rule: string;
  readonly details?: unknown;
}> {}

export class LockAcquisitionError extends Data.TaggedError(
  "LockAcquisitionError"
)<{
  readonly resource: string;
  readonly currentOwner: string;
}> {}

export class StaleFencingTokenError extends Data.TaggedError(
  "StaleFencingTokenError"
)<{
  readonly resource: string;
  readonly presentedToken: number;
  readonly expectedToken: number;
}> {}

export class SandboxExecutionError extends Data.TaggedError(
  "SandboxExecutionError"
)<{
  readonly modelId: string;
  readonly reason: string;
  readonly details?: unknown;
}> {}

export class ArtifactSizeExceededError extends Data.TaggedError(
  "ArtifactSizeExceededError"
)<{
  readonly actualBytes: number;
  readonly maxAllowedBytes: number;
}> {}

export class CompilationError extends Data.TaggedError("CompilationError")<{
  readonly errors: readonly string[];
  readonly message: string;
}> {}

export class ReleaseConflictError extends Data.TaggedError(
  "ReleaseConflictError"
)<{
  readonly expectedDigest?: string;
  readonly actualDigest?: string;
  readonly message: string;
}> {}

export class SelfReviewDeniedError extends Data.TaggedError(
  "SelfReviewDeniedError"
)<{
  readonly authorId: string;
  readonly reviewerId: string;
  readonly message: string;
}> {}

export class StaleReviewError extends Data.TaggedError("StaleReviewError")<{
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly reviewDigest: string;
  readonly message: string;
}> {}

export class CandidateNotFoundError extends Data.TaggedError(
  "CandidateNotFoundError"
)<{
  readonly candidateDigest: string;
  readonly message: string;
}> {}

export class PublicationNotFoundError extends Data.TaggedError(
  "PublicationNotFoundError"
)<{
  readonly identifier: string;
  readonly message: string;
}> {}
