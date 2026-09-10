import { Data } from "effect";

export class ParameterValidationError extends Data.TaggedError(
  "ParameterValidationError"
)<{
  readonly actionTypeId: string;
  readonly message: string;
  readonly details?: unknown;
}> {
  constructor(args: {
    readonly actionTypeId: string;
    readonly message: string;
    readonly details?: unknown;
  }) {
    super(args as any);
  }
}

export class PermissionDeniedError extends Data.TaggedError(
  "PermissionDeniedError"
)<{
  readonly subjectId: string;
  readonly actionTypeId: string;
  readonly reason: string;
}> {
  constructor(args: {
    readonly subjectId: string;
    readonly actionTypeId: string;
    readonly reason: string;
  }) {
    super(args as any);
  }
}

export class SubmissionCriteriaFailedError extends Data.TaggedError(
  "SubmissionCriteriaFailedError"
)<{
  readonly actionTypeId: string;
  readonly criterionId: string;
  readonly reason: string;
  readonly verdict: "deny" | "review";
}> {
  constructor(args: {
    readonly actionTypeId: string;
    readonly criterionId: string;
    readonly reason: string;
    readonly verdict: "deny" | "review";
  }) {
    super(args as any);
  }
}

export class FreshnessBudgetExceededError extends Data.TaggedError(
  "FreshnessBudgetExceededError"
)<{
  readonly objectId: string;
  readonly propertyName: string;
  readonly currentAgeMs: number;
  readonly maxAllowedStalenessMs: number;
}> {
  constructor(args: {
    readonly objectId: string;
    readonly propertyName: string;
    readonly currentAgeMs: number;
    readonly maxAllowedStalenessMs: number;
  }) {
    super(args as any);
  }
}

export class ObjectNotFoundError extends Data.TaggedError(
  "ObjectNotFoundError"
)<{
  readonly objectTypeId: string;
  readonly objectId: string;
}> {
  constructor(args: {
    readonly objectTypeId: string;
    readonly objectId: string;
  }) {
    super(args as any);
  }
}

export class ConcurrentModificationError extends Data.TaggedError(
  "ConcurrentModificationError"
)<{
  readonly objectId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}> {
  constructor(args: {
    readonly objectId: string;
    readonly expectedVersion: number;
    readonly actualVersion: number;
  }) {
    super(args as any);
  }
}

export class SideEffectExecutionError extends Data.TaggedError(
  "SideEffectExecutionError"
)<{
  readonly sideEffectId: string;
  readonly cause: unknown;
}> {
  constructor(args: {
    readonly sideEffectId: string;
    readonly cause: unknown;
  }) {
    super(args as any);
  }
}

export class CompensationFailedError extends Data.TaggedError(
  "CompensationFailedError"
)<{
  readonly sideEffectId: string;
  readonly cause: unknown;
}> {
  constructor(args: {
    readonly sideEffectId: string;
    readonly cause: unknown;
  }) {
    super(args as any);
  }
}

export class ProposalNotFoundError extends Data.TaggedError(
  "ProposalNotFoundError"
)<{
  readonly proposalId: string;
  readonly message: string;
}> {
  constructor(args: { readonly proposalId: string; readonly message: string }) {
    super(args as any);
  }
}

export class ProposalExecutionStateError extends Data.TaggedError(
  "ProposalExecutionStateError"
)<{
  readonly proposalId: string;
  readonly message: string;
}> {
  constructor(args: { readonly proposalId: string; readonly message: string }) {
    super(args as any);
  }
}

export class AuthenticationError extends Data.TaggedError(
  "AuthenticationError"
)<{
  readonly reason: string;
}> {
  constructor(args: { readonly reason: string }) {
    super(args as any);
  }
}

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly reason: string;
}> {
  constructor(args: { readonly reason: string }) {
    super(args as any);
  }
}

export class IdempotencyConflictError extends Data.TaggedError(
  "IdempotencyConflictError"
)<{
  readonly idempotencyKey: string;
  readonly message: string;
}> {
  constructor(args: {
    readonly idempotencyKey: string;
    readonly message: string;
  }) {
    super(args as any);
  }
}

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(args: { readonly message: string; readonly cause?: unknown }) {
    super(args as any);
  }
}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly entityId: string;
  readonly message: string;
}> {
  constructor(args: { readonly entityId: string; readonly message: string }) {
    super(args as any);
  }
}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly entityId: string;
  readonly rule: string;
  readonly details?: unknown;
}> {
  constructor(args: {
    readonly entityId: string;
    readonly rule: string;
    readonly details?: unknown;
  }) {
    super(args as any);
  }
}

export class LockAcquisitionError extends Data.TaggedError(
  "LockAcquisitionError"
)<{
  readonly resource: string;
  readonly currentOwner: string;
}> {
  constructor(args: {
    readonly resource: string;
    readonly currentOwner: string;
  }) {
    super(args as any);
  }
}

export class StaleFencingTokenError extends Data.TaggedError(
  "StaleFencingTokenError"
)<{
  readonly resource: string;
  readonly presentedToken: number;
  readonly expectedToken: number;
}> {
  constructor(args: {
    readonly resource: string;
    readonly presentedToken: number;
    readonly expectedToken: number;
  }) {
    super(args as any);
  }
}

export class SandboxExecutionError extends Data.TaggedError(
  "SandboxExecutionError"
)<{
  readonly modelId: string;
  readonly reason: string;
  readonly details?: unknown;
}> {
  constructor(args: {
    readonly modelId: string;
    readonly reason: string;
    readonly details?: unknown;
  }) {
    super(args as any);
  }
}
