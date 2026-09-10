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

export class UnadmittedEvidenceError extends Data.TaggedError(
  "UnadmittedEvidenceError"
)<{
  readonly message: string;
}> {}
