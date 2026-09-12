import type { Schema } from "effect";
import { Clock, Effect, Option, Schema as S } from "effect";

import type { QuarantineEnvelope } from "../envelope.js";
import {
  MailboxMessageNotFoundError,
  ReadOperationUnsupportedError,
} from "../errors.js";
import type { HostSecretStore } from "../host-secrets.js";
import type { ReadExecutor } from "../membrane.js";
import { gmailReadonlyConnector } from "./email.js";

export const GmailParticipant = S.Struct({
  displayName: S.String,
  email: S.String,
});
export type GmailParticipant = typeof GmailParticipant.Type;

export const GmailMessageFixture = S.Struct({
  id: S.String,
  threadId: S.String,
  from: GmailParticipant,
  to: S.NonEmptyArray(GmailParticipant),
  subject: S.String,
  sentAt: S.String,
  snippet: S.String,
});
export type GmailMessageFixture = typeof GmailMessageFixture.Type;

export const GmailMailboxFixture = S.Struct({
  _tag: S.Literal("GmailMailboxFixture"),
  userId: S.String,
  labels: S.Array(S.String),
  messages: S.Array(GmailMessageFixture),
});
export type GmailMailboxFixture = typeof GmailMailboxFixture.Type;

const GmailGetArgs = S.Struct({
  id: S.String,
  userId: S.String,
});

const GMAIL_READ_OPERATIONS = new Set(
  gmailReadonlyConnector.operations.map((operation) => operation.name)
);

const asJson = (value: unknown): Schema.Json =>
  // SAFETY: Gmail fixture structs are JSON records (strings and nested structs).
  value as Schema.Json;

const envelopeOf = (
  mailbox: GmailMailboxFixture,
  operation: string,
  payload: Schema.Json,
  receivedAt: number,
  tenantId: string
): QuarantineEnvelope => ({
  locator: `gmail://${mailbox.userId}/${operation}`,
  mediaType: "application/json",
  operation,
  rawPayload: payload,
  receivedAt,
  sensitivity: "confidential",
  sourceSystem: "gmail",
  tenantId,
});

export const recordedGmailMailbox: GmailMailboxFixture = {
  _tag: "GmailMailboxFixture",
  labels: ["INBOX", "SENT"],
  messages: [
    {
      from: { displayName: "Ana Silva", email: "Ana.Silva@Unimed.com.br" },
      id: "msg-ana-1",
      sentAt: "2026-09-01T10:00:00-03:00",
      snippet: "Preciso cancelar a consulta de terça.",
      subject: "Cancelar consulta",
      threadId: "thread-1",
      to: [{ displayName: "Dona", email: "owner@clinica.example" }],
    },
    {
      from: { displayName: "Bruno Lima", email: "bruno@gmail.com" },
      id: "msg-bruno-1",
      sentAt: "2026-09-02T09:15:00-03:00",
      snippet: "Segue o orçamento.",
      subject: "Orçamento",
      threadId: "thread-2",
      to: [{ displayName: "Dona", email: "owner@clinica.example" }],
    },
    {
      from: { displayName: "Carla Souza", email: "carla@unimed.com.br" },
      id: "msg-carla-1",
      sentAt: "2026-09-03T16:40:00-03:00",
      snippet: "Confirmado para quinta.",
      subject: "Re: agenda",
      threadId: "thread-3",
      to: [{ displayName: "Dona", email: "owner@clinica.example" }],
    },
  ],
  userId: "me",
};

export interface GmailReadonlyExecutorOptions {
  readonly mailbox: GmailMailboxFixture;
  readonly secrets: HostSecretStore;
  readonly tenantId: string;
}

/**
 * Host-side Gmail read executor. Secrets stay in the store. The mailbox is a
 * recorded fixture or a Host-hydrated snapshot. No OAuth UI. No send/modify.
 */
export const createGmailReadonlyExecutor = (
  options: GmailReadonlyExecutorOptions
): ReadExecutor =>
  Effect.fn("createGmailReadonlyExecutor")(function* (request) {
    if (
      request.connectorKind !== "gmail" ||
      request.connectorId !== gmailReadonlyConnector.connectorId ||
      !GMAIL_READ_OPERATIONS.has(request.operation)
    ) {
      return yield* new ReadOperationUnsupportedError({
        connectorId: request.connectorId,
        operation: request.operation,
      });
    }

    yield* options.secrets.require(gmailReadonlyConnector.oauth.clientSecret);
    yield* options.secrets.require(gmailReadonlyConnector.oauth.refreshToken);

    const receivedAt = yield* Clock.currentTimeMillis;
    const { mailbox, tenantId } = options;

    switch (request.operation) {
      case "users.messages.list":
      case "users.history.list": {
        return envelopeOf(
          mailbox,
          request.operation,
          asJson(mailbox.messages),
          receivedAt,
          tenantId
        );
      }
      case "users.messages.get": {
        const args = S.decodeUnknownOption(GmailGetArgs)(request.arguments);
        if (Option.isNone(args)) {
          return yield* new ReadOperationUnsupportedError({
            connectorId: request.connectorId,
            operation: request.operation,
          });
        }
        const message = mailbox.messages.find(
          (candidate) => candidate.id === args.value.id
        );
        if (message === undefined) {
          return yield* new MailboxMessageNotFoundError({
            connectorId: request.connectorId,
            messageId: args.value.id,
          });
        }
        return envelopeOf(
          mailbox,
          request.operation,
          asJson([message]),
          receivedAt,
          tenantId
        );
      }
      case "users.labels.list": {
        return envelopeOf(
          mailbox,
          request.operation,
          asJson(mailbox.labels.map((name) => ({ name }))),
          receivedAt,
          tenantId
        );
      }
      default: {
        return yield* new ReadOperationUnsupportedError({
          connectorId: request.connectorId,
          operation: request.operation,
        });
      }
    }
  });
