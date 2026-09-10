import { Data } from "effect";

export class SkillNotFoundError extends Data.TaggedError("SkillNotFoundError")<{
  readonly skillId: string;
}> {}

export class MissingToolError extends Data.TaggedError("MissingToolError")<{
  readonly skillId: string;
  readonly missingTools: readonly string[];
}> {}

export class InsufficientAuthorityError extends Data.TaggedError(
  "InsufficientAuthorityError"
)<{
  readonly skillId: string;
  readonly requiredAuthorities: readonly string[];
  readonly actualRoles: readonly string[];
}> {}

export class IncompatibleContractError extends Data.TaggedError(
  "IncompatibleContractError"
)<{
  readonly skillId: string;
  readonly minContract: string;
  readonly kernelContract: string;
}> {}
