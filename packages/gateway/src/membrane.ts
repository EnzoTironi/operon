import type { Schema } from "effect";
import { Effect } from "effect";

import type { QuarantineEnvelope } from "./envelope.js";
import type {
  MailboxMessageNotFoundError,
  ReadOperationUnsupportedError,
  SecretUnresolvedError,
} from "./errors.js";
import { WriteInvokeForbiddenError } from "./errors.js";
import type { WriteCandidate } from "./write-candidate.js";

const WRITE_HTTP_METHODS = new Set(["post", "put", "patch", "delete"]);

export type ConnectorKind = "openapi" | "graphql" | "mcp" | "gmail" | "imap";

export interface GatewayRequest {
  readonly connectorId: string;
  readonly connectorKind: ConnectorKind;
  readonly operation: string;
  readonly method: string;
  readonly arguments: Schema.Json;
  readonly destructiveHint?: boolean;
  readonly graphqlKind?: "query" | "mutation";
}

export type ClassifiedGatewayRequest =
  | { readonly _tag: "ReadOperation"; readonly request: GatewayRequest }
  | { readonly _tag: "WriteCandidate"; readonly candidate: WriteCandidate };

const isEmailWrite = (request: GatewayRequest): boolean => {
  if (request.connectorKind !== "gmail" && request.connectorKind !== "imap") {
    return false;
  }
  const op = request.operation.toLowerCase();
  return (
    op.includes("send") ||
    op.includes("modify") ||
    op.includes("delete") ||
    op.includes("insert") ||
    op.includes("compose") ||
    op.includes("draft") ||
    op.includes("append") ||
    op.includes("store") ||
    op.includes("expunge")
  );
};

/**
 * Classify a connector call before any host I/O.
 *
 * GET/HEAD/OPTIONS, GraphQL query, IMAP/Gmail fetch/list/poll become reads.
 * POST/PUT/PATCH/DELETE, GraphQL mutation, MCP destructiveHint, and email
 * send/modify become WriteCandidate. Classification never performs I/O.
 */
export const classifyGatewayRequest = (
  request: GatewayRequest
): ClassifiedGatewayRequest => {
  const method = request.method.toLowerCase();
  const httpWrite = WRITE_HTTP_METHODS.has(method);
  const graphqlWrite = request.graphqlKind === "mutation";
  const mcpWrite = request.destructiveHint === true;
  const emailWrite = isEmailWrite(request);

  if (httpWrite || graphqlWrite || mcpWrite || emailWrite) {
    const reason = emailWrite
      ? "email_send_or_modify"
      : graphqlWrite
        ? "graphql_mutation"
        : mcpWrite
          ? "mcp_destructive"
          : "http_mutation";
    return {
      _tag: "WriteCandidate",
      candidate: {
        _tag: "WriteCandidate",
        connectorId: request.connectorId,
        operation: request.operation,
        method: request.method,
        reason,
        arguments: request.arguments,
        approvalDescription: `${request.method.toUpperCase()} ${request.operation}`,
      },
    };
  }

  return { _tag: "ReadOperation", request };
};

export type GatewayDispatchResult =
  | { readonly _tag: "quarantine"; readonly envelope: QuarantineEnvelope }
  | { readonly _tag: "writeCandidate"; readonly candidate: WriteCandidate };

export type GatewayReadError =
  | MailboxMessageNotFoundError
  | ReadOperationUnsupportedError
  | SecretUnresolvedError;

export type ReadExecutor = (
  request: GatewayRequest
) => Effect.Effect<QuarantineEnvelope, GatewayReadError>;

/**
 * The only dispatch entry the Operon cell should call.
 *
 * Reads may run `readExecutor` (poll/download/GET) and return a quarantine
 * envelope. Writes never invoke. They become WriteCandidate.
 */
export const dispatchGatewayRequest = Effect.fn("dispatchGatewayRequest")(
  function* (
    request: GatewayRequest,
    readExecutor: ReadExecutor
  ): Effect.fn.Return<GatewayDispatchResult, GatewayReadError> {
    const classified = classifyGatewayRequest(request);
    switch (classified._tag) {
      case "WriteCandidate": {
        return { _tag: "writeCandidate", candidate: classified.candidate };
      }
      case "ReadOperation": {
        return {
          _tag: "quarantine",
          envelope: yield* readExecutor(classified.request),
        };
      }
      default: {
        const _exhaustive: never = classified;
        return _exhaustive;
      }
    }
  }
);

/**
 * Sandbox/tool invoker membrane: POST and other writes fail instead of I/O.
 */
export const refuseWriteInvoke = (
  request: GatewayRequest
): Effect.Effect<never, WriteInvokeForbiddenError> => {
  const classified = classifyGatewayRequest(request);
  if (classified._tag !== "WriteCandidate") {
    return Effect.die(
      new Error(`refuseWriteInvoke called on a read: ${request.operation}`)
    );
  }
  return Effect.fail(
    new WriteInvokeForbiddenError({
      connectorId: classified.candidate.connectorId,
      operation: classified.candidate.operation,
      method: classified.candidate.method,
      reason: classified.candidate.reason,
    })
  );
};
