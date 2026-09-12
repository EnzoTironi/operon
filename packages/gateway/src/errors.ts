import { Data } from "effect";

export class WriteInvokeForbiddenError extends Data.TaggedError(
  "WriteInvokeForbiddenError"
)<{
  readonly connectorId: string;
  readonly operation: string;
  readonly method: string;
  readonly reason: string;
}> {}

export class ReadOperationUnsupportedError extends Data.TaggedError(
  "ReadOperationUnsupportedError"
)<{
  readonly connectorId: string;
  readonly operation: string;
}> {}
