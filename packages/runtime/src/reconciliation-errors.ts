import { Data } from "effect";

export class AmbiguousIdentityError extends Data.TaggedError(
  "AmbiguousIdentityError"
)<{
  readonly proposalId: string;
  readonly confidence: number;
  readonly threshold: number;
  readonly reason: string;
}> {}

export class StaleDependencyError extends Data.TaggedError(
  "StaleDependencyError"
)<{
  readonly queryId: string;
  readonly dependencyId: string;
  readonly ageMs: number;
  readonly maxStalenessMs: number;
}> {}

export class IdentityResolutionNotFoundError extends Data.TaggedError(
  "IdentityResolutionNotFoundError"
)<{
  readonly proposalId: string;
}> {}
