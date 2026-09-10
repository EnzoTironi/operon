import { createHash } from "node:crypto";

import { Effect } from "effect";

export type McpKeyRole = "consumer" | "builder";

export interface McpKey {
  readonly keyId: string;
  readonly role: McpKeyRole;
  readonly agentId: string;
  readonly name: string;
  readonly agentTier: 1 | 2 | 3 | 4;
  readonly expiresAt?: number;
}

export interface RegisteredApiKey {
  readonly keyId: string;
  readonly keyHash: string;
  readonly role: McpKeyRole;
  readonly agentId: string;
  readonly name: string;
  readonly agentTier: 1 | 2 | 3 | 4;
  readonly active: boolean;
  readonly expiresAt?: number;
}

export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

/**
 * Registry for validating and managing MCP API keys with cryptographic SHA-256 storage,
 * expiration checks, and role scoping.
 */
export class ApiKeyRegistry {
  private readonly keys = new Map<string, RegisteredApiKey>();

  public registerKey(
    rawKey: string,
    metadata: Omit<RegisteredApiKey, "keyHash">
  ): void {
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    this.keys.set(keyHash, {
      ...metadata,
      keyHash,
    });
  }

  public validateKey(rawKey: string): Effect.Effect<McpKey, McpSecurityError> {
    return Effect.suspend(() => {
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const record = this.keys.get(keyHash);
      if (!record || !record.active) {
        return Effect.fail(
          new McpSecurityError(
            "Invalid or revoked API key: credential not found in registry"
          )
        );
      }
      if (record.expiresAt && Date.now() > record.expiresAt) {
        return Effect.fail(
          new McpSecurityError(
            `API key '${record.keyId}' has expired at ${record.expiresAt}`
          )
        );
      }
      return Effect.succeed({
        agentId: record.agentId,
        agentTier: record.agentTier,
        expiresAt: record.expiresAt,
        keyId: record.keyId,
        name: record.name,
        role: record.role,
      });
    });
  }
}

export const defaultApiKeyRegistry = new ApiKeyRegistry();

// Pre-register standard bootstrap keys
defaultApiKeyRegistry.registerKey("bk_builder_secret", {
  active: true,
  agentId: "dev-agent",
  agentTier: 4,
  keyId: "bk-default",
  name: "Default Builder",
  role: "builder",
});

defaultApiKeyRegistry.registerKey("bk_builder_secret_789", {
  active: true,
  agentId: "ai-fde",
  agentTier: 4,
  keyId: "bk-fde",
  name: "FDE Builder",
  role: "builder",
});

defaultApiKeyRegistry.registerKey("ck_consumer_secret", {
  active: true,
  agentId: "agent-1",
  agentTier: 2,
  keyId: "ck-default",
  name: "Default Consumer",
  role: "consumer",
});

defaultApiKeyRegistry.registerKey("ck_consumer_123", {
  active: true,
  agentId: "agent-2",
  agentTier: 2,
  keyId: "ck-fde",
  name: "FDE Consumer",
  role: "consumer",
});

/**
 * Validates that an MCP caller possesses the appropriate key for the requested operation.
 */
export function assertMcpKeyPermission(
  key: McpKey,
  operation:
    | "query_runtime"
    | "execute_action"
    | "modify_schema"
    | "modify_pipeline"
): void {
  if (
    key.role === "consumer" &&
    (operation === "modify_schema" || operation === "modify_pipeline")
  ) {
    throw new McpSecurityError(
      `Consumer key '${key.keyId}' cannot perform schema/pipeline modification '${operation}'. Builder key required.`
    );
  }

  if (key.role === "builder" && operation === "execute_action") {
    throw new McpSecurityError(
      `Builder key '${key.keyId}' cannot execute production actions. Consumer key required.`
    );
  }
}

export function assertBuilderKey(
  key: McpKey | string,
  registry: ApiKeyRegistry = defaultApiKeyRegistry
): Effect.Effect<McpKey, McpSecurityError> {
  if (typeof key === "string") {
    if (key.startsWith("ck_")) {
      return Effect.fail(
        new McpSecurityError(
          `Consumer key '${key}' cannot perform schema work. Builder key required.`
        )
      );
    }
    return registry.validateKey(key).pipe(
      Effect.flatMap((mcpKey) => {
        if (mcpKey.role !== "builder") {
          return Effect.fail(
            new McpSecurityError(
              `Key '${mcpKey.keyId}' has role '${mcpKey.role}'. Builder key required.`
            )
          );
        }
        return Effect.succeed(mcpKey);
      })
    );
  }

  if (key.role !== "builder") {
    return Effect.fail(
      new McpSecurityError(
        `Key '${key.keyId}' has role '${key.role}'. Builder key required.`
      )
    );
  }
  return Effect.succeed(key);
}
