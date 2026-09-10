import { createHmac } from "node:crypto";

import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import {
  OidcTokenVerifier,
  TokenRevocationRegistry,
  resolveAgentContext,
} from "./auth.js";
import { AuthenticationError } from "./errors.js";

function createTestJwt(
  claims: Record<string, unknown>,
  secret = "super-secret-test-key-32-chars-long!",
  alg = "HS256"
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("V0-CH-01: External-agent identity, discovery and durable profile", () => {
  const secretKey = "super-secret-test-key-32-chars-long!";
  const verifier = new OidcTokenVerifier({
    expectedAudience: "operon-kernel",
    expectedIssuer: "https://auth.operon.ai",
    secretOrPublicKey: secretKey,
  });

  beforeEach(() => {
    TokenRevocationRegistry.clear();
  });

  it("resolves valid external-agent token into complete AgentContext", () =>
    Effect.gen(function* () {
      const token = createTestJwt({
        attributes: {
          environmentId: "staging-eu",
          grants: ["intent:read", "intent:propose"],
          profile: "external-agent",
          sponsorId: "clinician-head",
        },
        aud: "operon-kernel",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.ai",
        sub: "agent-alpha-42",
        tenantId: "tenant-acme",
      });

      const context = yield* resolveAgentContext(token, verifier, {
        expectedTenantId: "tenant-acme",
      });

      expect(context.actorId).toBe("agent-alpha-42");
      expect(context.sponsorId).toBe("clinician-head");
      expect(context.tenantId).toBe("tenant-acme");
      expect(context.environmentId).toBe("staging-eu");
      expect(context.profile).toBe("external-agent");
      expect(context.grants).toEqual(["intent:read", "intent:propose"]);
    }).pipe(Effect.runPromise));

  it("denies token with wrong audience or issuer", () =>
    Effect.gen(function* () {
      const wrongAudToken = createTestJwt({
        aud: "wrong-audience",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.ai",
        sub: "agent-007",
      });

      const audError = yield* Effect.flip(
        resolveAgentContext(wrongAudToken, verifier)
      );
      expect(audError).toBeInstanceOf(AuthenticationError);

      const wrongIssToken = createTestJwt({
        aud: "operon-kernel",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://rogue-issuer.com",
        sub: "agent-007",
      });

      const issError = yield* Effect.flip(
        resolveAgentContext(wrongIssToken, verifier)
      );
      expect(issError).toBeInstanceOf(AuthenticationError);
    }).pipe(Effect.runPromise));

  it("denies revoked token via TokenRevocationRegistry", () =>
    Effect.gen(function* () {
      const jti = "revoked-token-uuid-12345";
      const token = createTestJwt({
        aud: "operon-kernel",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.ai",
        jti,
        sub: "agent-compromised",
      });

      // Verify valid before revocation
      const contextBefore = yield* resolveAgentContext(token, verifier);
      expect(contextBefore.actorId).toBe("agent-compromised");

      // Revoke token
      TokenRevocationRegistry.revoke(jti);

      // Verify failure post-revocation using Effect.flip
      const revocationError = yield* Effect.flip(
        resolveAgentContext(token, verifier)
      );
      expect(revocationError).toBeInstanceOf(AuthenticationError);
    }).pipe(Effect.runPromise));

  it("does not disclose tenant existence on wrong tenant reference", () =>
    Effect.gen(function* () {
      const token = createTestJwt({
        aud: "operon-kernel",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.ai",
        sub: "agent-tenant-spy",
        tenantId: "tenant-beta",
      });

      // Requesting tenant-alpha with tenant-beta credentials must fail generically without disclosure
      const deniedError = yield* Effect.flip(
        resolveAgentContext(token, verifier, {
          expectedTenantId: "tenant-alpha",
        })
      );

      expect(deniedError._tag).toBe("AuthorizationError");
      expect((deniedError as any).reason).toBe("Access denied");
    }).pipe(Effect.runPromise));

  it("denies tokens missing required subject identifier", () =>
    Effect.gen(function* () {
      const invalidToken = createTestJwt({
        aud: "operon-kernel",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.ai",
        // missing sub
      });

      const missingSubError = yield* Effect.flip(
        resolveAgentContext(invalidToken, verifier)
      );
      expect(missingSubError).toBeInstanceOf(AuthenticationError);
    }).pipe(Effect.runPromise));
});
