import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ApiKeyRegistry,
  assertMcpKeyPermission,
  defaultApiKeyRegistry,
  McpSecurityError,
} from "./keys.js";

describe("ApiKeyRegistry & Scoped Key Validation", () => {
  it("authenticates and validates registered active keys", async () => {
    const registry = new ApiKeyRegistry();
    registry.registerKey("bk_special_dev", {
      active: true,
      agentId: "dev-fde-01",
      agentTier: 4,
      keyId: "key-dev-1",
      name: "Dev Builder Key",
      role: "builder",
    });

    const validated = await Effect.runPromise(
      registry.validateKey("bk_special_dev")
    );
    expect(validated.keyId).toBe("key-dev-1");
    expect(validated.agentId).toBe("dev-fde-01");
    expect(validated.role).toBe("builder");
    expect(validated.agentTier).toBe(4);
  });

  it("rejects unregistered/fabricated keys with security failure", async () => {
    const registry = new ApiKeyRegistry();
    const exit = await Effect.runPromiseExit(
      registry.validateKey("bk_forged_unregistered_key")
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("McpSecurityError");
      expect(exit.cause.error.message).toContain(
        "credential not found in registry"
      );
    }
  });

  it("rejects revoked (inactive) keys", async () => {
    const registry = new ApiKeyRegistry();
    registry.registerKey("bk_revoked", {
      active: false,
      agentId: "revoked-agent",
      agentTier: 2,
      keyId: "key-revoked",
      name: "Revoked Key",
      role: "builder",
    });

    const exit = await Effect.runPromiseExit(
      registry.validateKey("bk_revoked")
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("McpSecurityError");
      expect(exit.cause.error.message).toContain(
        "credential not found in registry"
      );
    }
  });

  it("rejects expired keys", async () => {
    const registry = new ApiKeyRegistry();
    registry.registerKey("bk_expired", {
      active: true,
      agentId: "expired-agent",
      agentTier: 3,
      expiresAt: Date.now() - 10000, // Expired in the past
      keyId: "key-expired",
      name: "Expired Key",
      role: "builder",
    });

    const exit = await Effect.runPromiseExit(
      registry.validateKey("bk_expired")
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("McpSecurityError");
      expect(exit.cause.error.message).toContain("has expired");
    }
  });

  it("enforces role boundaries between Consumer and Builder keys via assertMcpKeyPermission", () => {
    const consumer = {
      agentId: "agent-1",
      agentTier: 2 as const,
      keyId: "ck-1",
      name: "Consumer",
      role: "consumer" as const,
    };
    const builder = {
      agentId: "builder-1",
      agentTier: 4 as const,
      keyId: "bk-1",
      name: "Builder",
      role: "builder" as const,
    };

    expect(() => assertMcpKeyPermission(consumer, "modify_schema")).toThrow(
      McpSecurityError
    );
    expect(() => assertMcpKeyPermission(consumer, "modify_pipeline")).toThrow(
      McpSecurityError
    );
    expect(() =>
      assertMcpKeyPermission(consumer, "query_runtime")
    ).not.toThrow();

    expect(() => assertMcpKeyPermission(builder, "execute_action")).toThrow(
      McpSecurityError
    );
    expect(() =>
      assertMcpKeyPermission(builder, "modify_schema")
    ).not.toThrow();
  });

  it("ships an empty default registry", async () => {
    for (const secret of [
      "ck_consumer_secret",
      "bk_builder_secret",
      "bk_builder_secret_789",
      "ck_consumer_123",
    ]) {
      const exit = await Effect.runPromiseExit(
        defaultApiKeyRegistry.validateKey(secret)
      );
      expect(exit._tag).toBe("Failure");
    }
  });
});
