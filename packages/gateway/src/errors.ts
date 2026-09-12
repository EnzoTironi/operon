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

export class SecretUnresolvedError extends Data.TaggedError(
  "SecretUnresolvedError"
)<{
  readonly id: string;
}> {}

export class MailboxMessageNotFoundError extends Data.TaggedError(
  "MailboxMessageNotFoundError"
)<{
  readonly connectorId: string;
  readonly messageId: string;
}> {}
