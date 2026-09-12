import { Data } from "effect";

export class CorruptInputError extends Data.TaggedError("CorruptInputError")<{
  readonly reason: string;
  readonly locator?: string;
}> {}

export class ContradictoryInputError extends Data.TaggedError(
  "ContradictoryInputError"
)<{
  readonly reason: string;
  readonly recordId: string;
  readonly conflictingProperties: readonly string[];
}> {}

export class UnknownSourceError extends Data.TaggedError("UnknownSourceError")<{
  readonly sourceId: string;
}> {}

export class MappingProposalNotFoundError extends Data.TaggedError(
  "MappingProposalNotFoundError"
)<{
  readonly proposalId: string;
}> {}

/**
 * Only an authenticated human can approve or reject a batch admission.
 * Agents prepare; they never grant.
 */
export class HumanReviewRequiredError extends Data.TaggedError(
  "HumanReviewRequiredError"
)<{
  readonly proposalId: string;
  readonly reviewerId: string;
  readonly reviewerType: string;
}> {}

export class UnadmittedEvidenceError extends Data.TaggedError(
  "UnadmittedEvidenceError"
)<{
  readonly message: string;
}> {}
