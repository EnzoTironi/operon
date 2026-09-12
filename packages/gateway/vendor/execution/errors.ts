import * as Data from "effect/Data";

export class ExecutionToolError extends Data.TaggedError("ExecutionToolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// `CodeExecutionError` lives in `@operon/gateway/sandbox-core` — the `CodeExecutor`
// interface uses it as the default error channel, so the runtime packages
// can import the same class directly.
export { CodeExecutionError } from "@operon/gateway/sandbox-core";
