import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  createGmailReadonlyExecutor,
  dispatchGatewayRequest,
  gmailReadonlyConnector,
  memoryHostSecretStore,
  recordedGmailMailbox,
} from "../index.js";
import type { GatewayRequest } from "../membrane.js";

const STUB_TOKEN = "ya29.stub-readonly-token-must-not-leak";

const secrets = memoryHostSecretStore({
  "gmail.oauth.client_secret": "client-stub",
  "gmail.oauth.refresh_token": STUB_TOKEN,
});

const pollRequest = (
  overrides: Partial<GatewayRequest> &
    Pick<GatewayRequest, "operation" | "method">
): GatewayRequest => ({
  arguments: { userId: "me" },
  connectorId: "gmail-readonly",
  connectorKind: "gmail",
  ...overrides,
});

describe("Gmail readonly executor", () => {
  it("requires host SecretRef before returning a poll envelope", async () => {
    const missing = createGmailReadonlyExecutor({
      mailbox: recordedGmailMailbox,
      secrets: memoryHostSecretStore({}),
      tenantId: "clinic",
    });
    const exit = await Effect.runPromiseExit(
      missing(pollRequest({ method: "GET", operation: "users.messages.list" }))
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("polls the recorded mailbox into a quarantine envelope without leaking the token", async () => {
    const executor = createGmailReadonlyExecutor({
      mailbox: recordedGmailMailbox,
      secrets,
      tenantId: "clinic",
    });
    const result = await Effect.runPromise(
      dispatchGatewayRequest(
        pollRequest({ method: "GET", operation: "users.messages.list" }),
        executor
      )
    );
    expect(result._tag).toBe("quarantine");
    if (result._tag !== "quarantine") {
      return;
    }
    expect(result.envelope.sourceSystem).toBe("gmail");
    expect(result.envelope.tenantId).toBe("clinic");
    expect(result.envelope.locator).toBe("gmail://me/users.messages.list");
    expect(Array.isArray(result.envelope.rawPayload)).toBe(true);
    expect(result.envelope.rawPayload).toHaveLength(3);
    const encoded = JSON.stringify(result.envelope);
    expect(encoded.includes(STUB_TOKEN)).toBe(false);
    expect(encoded.includes("gmail.oauth.refresh_token")).toBe(false);
  });

  it("downloads one message by id", async () => {
    const executor = createGmailReadonlyExecutor({
      mailbox: recordedGmailMailbox,
      secrets,
      tenantId: "clinic",
    });
    const result = await Effect.runPromise(
      dispatchGatewayRequest(
        pollRequest({
          arguments: { id: "msg-ana-1", userId: "me" },
          method: "GET",
          operation: "users.messages.get",
        }),
        executor
      )
    );
    expect(result._tag).toBe("quarantine");
    if (result._tag !== "quarantine") {
      return;
    }
    expect(result.envelope.rawPayload).toEqual([
      recordedGmailMailbox.messages[0],
    ]);
  });

  it("does not invoke send; it stays a write candidate", async () => {
    let readCalls = 0;
    const executor = createGmailReadonlyExecutor({
      mailbox: recordedGmailMailbox,
      secrets,
      tenantId: "clinic",
    });
    const counting: typeof executor = (request) => {
      readCalls += 1;
      return executor(request);
    };
    const result = await Effect.runPromise(
      dispatchGatewayRequest(
        pollRequest({ method: "POST", operation: "users.messages.send" }),
        counting
      )
    );
    expect(result._tag).toBe("writeCandidate");
    expect(readCalls).toBe(0);
  });

  it("exposes readonly scopes and forbids send/modify on the live connector", () => {
    expect(gmailReadonlyConnector.oauth.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(gmailReadonlyConnector.forbiddenOperations).toEqual(
      expect.arrayContaining(["users.messages.send", "users.messages.modify"])
    );
  });
});
