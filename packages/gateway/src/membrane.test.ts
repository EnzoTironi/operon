import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_RUNTIME_SYMBOLS,
  classifyGatewayRequest,
  dispatchGatewayRequest,
  gmailReadonlyConnector,
  imapReadonlyConnector,
  makeReadOnlySandboxInvoker,
  secretRef,
  toIngestRawSourceOptions,
} from "./index.js";
import type { GatewayRequest } from "./membrane.js";
import { classifySandboxPath } from "./sandbox.js";

const readRequest = (
  overrides: Partial<GatewayRequest> &
    Pick<GatewayRequest, "operation" | "method">
): GatewayRequest => ({
  connectorId: "gmail-readonly",
  connectorKind: "gmail",
  arguments: { userId: "me" },
  ...overrides,
});

describe("gateway membrane", () => {
  it("classifies Gmail list as a read", () => {
    const classified = classifyGatewayRequest(
      readRequest({ operation: "users.messages.list", method: "GET" })
    );
    expect(classified._tag).toBe("ReadOperation");
  });

  it("classifies Gmail send as a write candidate and does not invoke", async () => {
    const result = await Effect.runPromise(
      dispatchGatewayRequest(
        readRequest({ operation: "users.messages.send", method: "POST" }),
        () => Effect.die(new Error("read executor must not run for writes"))
      )
    );
    expect(result._tag).toBe("writeCandidate");
    if (result._tag === "writeCandidate") {
      expect(result.candidate.reason).toBe("email_send_or_modify");
    }
  });

  it("classifies OpenAPI POST as a write candidate", () => {
    const classified = classifyGatewayRequest({
      connectorId: "stripe",
      connectorKind: "openapi",
      operation: "createCharge",
      method: "POST",
      arguments: {},
    });
    expect(classified._tag).toBe("WriteCandidate");
  });

  it("classifies GraphQL mutation as a write candidate", () => {
    const classified = classifyGatewayRequest({
      connectorId: "crm",
      connectorKind: "graphql",
      operation: "mutation.setGreeting",
      method: "POST",
      graphqlKind: "mutation",
      arguments: {},
    });
    expect(classified._tag).toBe("WriteCandidate");
    if (classified._tag === "WriteCandidate") {
      expect(classified.candidate.reason).toBe("graphql_mutation");
    }
  });

  it("classifies MCP destructiveHint as a write candidate", () => {
    const classified = classifyGatewayRequest({
      connectorId: "files",
      connectorKind: "mcp",
      operation: "delete",
      method: "CALL",
      destructiveHint: true,
      arguments: {},
    });
    expect(classified._tag).toBe("WriteCandidate");
    if (classified._tag === "WriteCandidate") {
      expect(classified.candidate.reason).toBe("mcp_destructive");
    }
  });

  it("runs a GET through readExecutor into a quarantine envelope", async () => {
    const result = await Effect.runPromise(
      dispatchGatewayRequest(
        readRequest({ operation: "users.messages.list", method: "GET" }),
        (request) =>
          Effect.succeed({
            locator: `gmail://me/${request.operation}`,
            mediaType: "application/json",
            rawPayload: { messages: [] },
            sourceSystem: "gmail",
            operation: request.operation,
            receivedAt: 0,
          })
      )
    );
    expect(result._tag).toBe("quarantine");
    if (result._tag === "quarantine") {
      const options = toIngestRawSourceOptions(result.envelope);
      expect(options.locator).toBe("gmail://me/users.messages.list");
      expect(options.mediaType).toBe("application/json");
    }
  });
});

describe("sandbox write block", () => {
  it("does not call the inner invoker for POST", async () => {
    let innerCalls = 0;
    const invoker = makeReadOnlySandboxInvoker({
      invoke: () => {
        innerCalls += 1;
        return Effect.succeed({ ok: true });
      },
    });
    const exit = await Effect.runPromiseExit(
      invoker.invoke({ path: "stripe.org.main.post_charges", args: {} })
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(innerCalls).toBe(0);
  });

  it("forwards GET to the inner invoker", async () => {
    const invoker = makeReadOnlySandboxInvoker({
      invoke: () => Effect.succeed({ messages: [] }),
    });
    const value = await Effect.runPromise(
      invoker.invoke({
        path: "gmail.org.main.get_users.messages.list",
        args: {},
      })
    );
    expect(value).toEqual({ messages: [] });
  });

  it("classifies sandbox delete paths as writes", () => {
    const request = classifySandboxPath("files.org.main.delete_object");
    expect(classifyGatewayRequest(request)._tag).toBe("WriteCandidate");
  });
});

describe("email connectors", () => {
  it("exposes Gmail as read-only with SecretRef oauth stubs", () => {
    expect(gmailReadonlyConnector.transport).toBe("POLLING");
    expect(gmailReadonlyConnector.oauth.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.readonly"
    );
    expect(gmailReadonlyConnector.oauth.scopes).toContain(
      "https://www.googleapis.com/auth/calendar.readonly"
    );
    expect(gmailReadonlyConnector.oauth.refreshToken).toEqual(
      secretRef("gmail.oauth.refresh_token")
    );
    expect(
      gmailReadonlyConnector.operations.every((op) => op.method === "GET")
    ).toBe(true);
    expect(gmailReadonlyConnector.forbiddenOperations).toContain(
      "users.messages.send"
    );
  });

  it("exposes IMAP as examine-only with SecretRef credentials", () => {
    const imap = imapReadonlyConnector("imap.example.com");
    expect(imap.examineOnly).toBe(true);
    expect(imap.port).toBe(993);
    expect(imap.credentials.password._tag).toBe("SecretRef");
    expect(imap.forbiddenOperations).toContain("APPEND");
  });
});

describe("write-path invariant", () => {
  it("does not name Funnel ingestBatch, putObject, or executeWritePipeline in src", async () => {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
      for (const entry of entries) {
        if (
          !entry.isDirectory() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          files.push(path.join(dir, entry.name));
        }
      }
      await Promise.all(nested.map((nestedDir) => walk(nestedDir)));
    };
    await walk(import.meta.dirname);
    const sources = files.filter((file) => !file.endsWith("invariants.ts"));
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(file, "utf-8"),
      }))
    );
    const hits: string[] = [];
    for (const { file, text } of texts) {
      for (const symbol of FORBIDDEN_RUNTIME_SYMBOLS) {
        if (text.includes(symbol) && !text.includes(`"${symbol}"`)) {
          hits.push(`${file}: ${symbol}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
