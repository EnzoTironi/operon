import type {
  GatewayRequest,
  GmailMailboxFixture,
  HostSecretStore,
  MailboxMessageNotFoundError,
  ReadExecutor,
  ReadOperationUnsupportedError,
  SecretUnresolvedError,
  WriteCandidate,
} from "@operon/gateway/cell";
import {
  createGmailReadonlyExecutor,
  dispatchGatewayRequest,
  gmailReadonlyConnector,
  toIngestRawSourceOptions,
} from "@operon/gateway/cell";
import type { IngestionReceipt } from "@operon/schema";
import { Effect } from "effect";

import type { IdempotencyConflictError } from "./errors.js";
import type { AccountableIngestionService } from "./funnel.js";
import type { CorruptInputError } from "./ingestion-errors.js";

export type {
  GmailMailboxFixture,
  HostSecretStore,
  WriteCandidate,
} from "@operon/gateway/cell";
export {
  GmailMailboxFixture as GmailMailboxFixtureSchema,
  memoryHostSecretStore,
  recordedGmailMailbox,
} from "@operon/gateway/cell";

export type GatewayIngestionResult =
  | { readonly _tag: "ingested"; readonly receipt: IngestionReceipt }
  | { readonly _tag: "writeCandidate"; readonly candidate: WriteCandidate };

export interface IngestFromGatewayOptions {
  readonly idempotencyKey: string;
  readonly ingestion: AccountableIngestionService;
  readonly readExecutor: ReadExecutor;
  readonly request: GatewayRequest;
}

type GatewayIngestionError =
  | CorruptInputError
  | IdempotencyConflictError
  | MailboxMessageNotFoundError
  | ReadOperationUnsupportedError
  | SecretUnresolvedError;

/**
 * The only live path from a gateway GET/poll/download into quarantine.
 * Writes stay WriteCandidate. This file must not name the batch funnel,
 * the object-store write, or the seven-step pipeline.
 */
export const ingestFromGateway = Effect.fn("ingestFromGateway")(function* (
  options: IngestFromGatewayOptions
): Effect.fn.Return<GatewayIngestionResult, GatewayIngestionError> {
  const dispatched = yield* dispatchGatewayRequest(
    options.request,
    options.readExecutor
  );
  switch (dispatched._tag) {
    case "writeCandidate": {
      return {
        _tag: "writeCandidate",
        candidate: dispatched.candidate,
      };
    }
    case "quarantine": {
      const receipt = yield* options.ingestion.ingestRawSource({
        ...toIngestRawSourceOptions(dispatched.envelope),
        idempotencyKey: options.idempotencyKey,
      });
      return { _tag: "ingested", receipt };
    }
    default: {
      const _exhaustive: never = dispatched;
      return _exhaustive;
    }
  }
});

export interface PollGmailMailboxOptions {
  readonly idempotencyKey: string;
  readonly ingestion: AccountableIngestionService;
  readonly mailbox: GmailMailboxFixture;
  readonly secrets: HostSecretStore;
  readonly tenantId: string;
}

export const pollGmailMailbox = Effect.fn("pollGmailMailbox")(function* (
  options: PollGmailMailboxOptions
): Effect.fn.Return<GatewayIngestionResult, GatewayIngestionError> {
  return yield* ingestFromGateway({
    idempotencyKey: options.idempotencyKey,
    ingestion: options.ingestion,
    readExecutor: createGmailReadonlyExecutor({
      mailbox: options.mailbox,
      secrets: options.secrets,
      tenantId: options.tenantId,
    }),
    request: {
      arguments: { userId: options.mailbox.userId },
      connectorId: gmailReadonlyConnector.connectorId,
      connectorKind: "gmail",
      method: "GET",
      operation: "users.messages.list",
    },
  });
});
