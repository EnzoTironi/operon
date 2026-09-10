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

  it("denies malformed JWT token not adhering to 3-part format", () =>
    Effect.gen(function* () {
      const err1 = yield* Effect.flip(
        verifier.verifyToken("single-string-token")
      );
      expect(err1).toBeInstanceOf(AuthenticationError);
      expect(err1.reason).toContain("expected header.payload.signature");

      const err2 = yield* Effect.flip(verifier.verifyToken("part1.part2"));
      expect(err2).toBeInstanceOf(AuthenticationError);

      const err3 = yield* Effect.flip(verifier.verifyToken("p1.p2.p3.p4"));
      expect(err3).toBeInstanceOf(AuthenticationError);
    }).pipe(Effect.runPromise));

  it("enforces allowedAlgorithms whitelist and rejects disallowed algorithms", () =>
    Effect.gen(function* () {
      const rsaOnlyVerifier = new OidcTokenVerifier({
        allowedAlgorithms: ["RS256"],
        secretOrPublicKey: secretKey,
      });

      const hs256Token = createTestJwt({
        aud: "operon-kernel",
        sub: "agent-hs",
      });

      const err = yield* Effect.flip(rsaOnlyVerifier.verifyToken(hs256Token));
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.reason).toContain("not allowed for this key type");
    }).pipe(Effect.runPromise));

  it("enforces nbf (not before) claim when token is not yet active", () =>
    Effect.gen(function* () {
      const futureNbfToken = createTestJwt({
        aud: "operon-kernel",
        iss: "https://auth.operon.ai",
        nbf: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
        sub: "agent-future",
      });

      const err = yield* Effect.flip(verifier.verifyToken(futureNbfToken));
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.reason).toContain("Token not valid before");
    }).pipe(Effect.runPromise));

  it("accepts audience when claims.aud is an array of audiences containing expected audience", () =>
    Effect.gen(function* () {
      const multiAudToken = createTestJwt({
        aud: ["telemetry-service", "operon-kernel", "audit-ledger"],
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.ai",
        sub: "agent-multi-aud",
      });

      const claims = yield* verifier.verifyToken(multiAudToken);
      expect(claims.sub).toBe("agent-multi-aud");
      expect(claims.aud).toEqual([
        "telemetry-service",
        "operon-kernel",
        "audit-ledger",
      ]);
    }).pipe(Effect.runPromise));
});
