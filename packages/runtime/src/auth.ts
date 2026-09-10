import { createHmac, createVerify } from "node:crypto";

import type { SecurityContext, Subject, SubjectType } from "@operon/schema";
import { Effect } from "effect";

import { AuthenticationError, AuthorizationError } from "./errors.js";

export interface OidcTokenHeader {
  readonly alg: "HS256" | "RS256";
  readonly typ?: string;
  readonly kid?: string;
}

export interface OidcTokenClaims {
  readonly sub: string;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly name?: string;
  readonly roles?: readonly string[];
  readonly groups?: readonly string[];
  readonly tenantId?: string;
  readonly clearance?:
    | "UNCLASSIFIED"
    | "CONFIDENTIAL"
    | "SECRET"
    | "TOP_SECRET";
  readonly attributes?: Record<string, unknown>;
  readonly agentTier?: 1 | 2 | 3 | 4;
  readonly type?: SubjectType;
}

const revokedJtis = new Set<string>();

export const TokenRevocationRegistry = {
  clear: (): void => {
    revokedJtis.clear();
  },
  isRevoked: (jti: string): boolean => revokedJtis.has(jti),
  revoke: (jti: string): void => {
    revokedJtis.add(jti);
  },
};

export type OperonProfile = "local" | "production" | "external-agent";

export interface AgentContext {
  readonly actorId: string;
  readonly sponsorId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly grants: readonly string[];
  readonly profile: OperonProfile;
}

export interface ResolveAgentContextOptions {
  readonly expectedTenantId?: string;
  readonly expectedEnvironmentId?: string;
}

export interface OidcVerifierConfig {
  readonly expectedIssuer?: string;
  readonly expectedAudience?: string;
  readonly secretOrPublicKey: string; // HMAC secret or RSA PEM public key
  readonly clockToleranceSeconds?: number;
  readonly allowedAlgorithms?: readonly ("HS256" | "RS256")[];
}

/**
 * Enterprise OIDC / JWT Token Verifier supporting HMAC and RSA signatures
 */
export class OidcTokenVerifier {
  public constructor(private readonly config: OidcVerifierConfig) {}

  public verifyToken(
    token: string
  ): Effect.Effect<OidcTokenClaims, AuthenticationError> {
    return Effect.gen({ self: this }, function* () {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: "Invalid JWT format: expected header.payload.signature",
          })
        );
      }

      const [rawHeader, rawPayload, rawSig] = parts;
      let header: OidcTokenHeader;
      let claims: OidcTokenClaims;

      try {
        header = JSON.parse(
          Buffer.from(rawHeader, "base64url").toString("utf-8")
        ) as OidcTokenHeader;
        claims = JSON.parse(
          Buffer.from(rawPayload, "base64url").toString("utf-8")
        ) as OidcTokenClaims;
      } catch (error) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Failed to decode JWT base64url: ${String(error)}`,
          })
        );
      }

      // 1. Signature Verification
      if (!["HS256", "RS256"].includes(header.alg)) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Unsupported JWT algorithm: ${String(header.alg)}`,
          })
        );
      }

      const isAsymmetric = this.config.secretOrPublicKey.includes("BEGIN ");
      const allowed =
        this.config.allowedAlgorithms ?? (isAsymmetric ? ["RS256"] : ["HS256"]);
      if (!allowed.includes(header.alg)) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Algorithm ${header.alg} is not allowed for this key type (allowed: ${allowed.join(", ")})`,
          })
        );
      }

      if (header.alg === "HS256" && isAsymmetric) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason:
              "HS256 is not permitted with an asymmetric PEM key (algorithm confusion prevention)",
          })
        );
      }

      const signedData = `${rawHeader}.${rawPayload}`;
      const sigBuffer = Buffer.from(rawSig, "base64url");

      if (header.alg === "HS256") {
        const expectedHmac = createHmac("sha256", this.config.secretOrPublicKey)
          .update(signedData)
          .digest();
        if (
          sigBuffer.length !== expectedHmac.length ||
          !sigBuffer.equals(expectedHmac)
        ) {
          return yield* Effect.fail(
            new AuthenticationError({
              reason: "Invalid HS256 JWT signature",
            })
          );
        }
      } else if (header.alg === "RS256") {
        const verifier = createVerify("RSA-SHA256");
        verifier.update(signedData);
        const isValid = verifier.verify(
          this.config.secretOrPublicKey,
          sigBuffer
        );
        if (!isValid) {
          return yield* Effect.fail(
            new AuthenticationError({
              reason: "Invalid RS256 JWT signature",
            })
          );
        }
      } else {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Unsupported JWT algorithm: ${String(header.alg)}`,
          })
        );
      }

      // 2. Standard Claims Verification
      const nowSec = Math.floor(Date.now() / 1000);
      const tolerance = this.config.clockToleranceSeconds ?? 60;

      if (claims.exp !== undefined && nowSec > claims.exp + tolerance) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Token expired at ${claims.exp}, current time is ${nowSec}`,
          })
        );
      }

      if (claims.nbf !== undefined && nowSec < claims.nbf - tolerance) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Token not valid before ${claims.nbf}, current time is ${nowSec}`,
          })
        );
      }

      if (
        this.config.expectedIssuer &&
        claims.iss !== this.config.expectedIssuer
      ) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Token issuer '${String(claims.iss)}' does not match expected '${this.config.expectedIssuer}'`,
          })
        );
      }

      if (this.config.expectedAudience) {
        const aud = claims.aud;
        const audMatches = Array.isArray(aud)
          ? aud.includes(this.config.expectedAudience)
          : aud === this.config.expectedAudience;
        if (!audMatches) {
          return yield* Effect.fail(
            new AuthenticationError({
              reason: `Token audience '${String(claims.aud)}' does not match expected '${this.config.expectedAudience}'`,
            })
          );
        }
      }

      // 3. Revocation check
      if (claims.jti && TokenRevocationRegistry.isRevoked(claims.jti)) {
        return yield* Effect.fail(
          new AuthenticationError({
            reason: `Token has been revoked: ${claims.jti}`,
          })
        );
      }

      return claims;
    });
  }
}

/**
 * Resolves external-agent token into canonical AgentContext
 * Guarantees tenant non-disclosure on unauthorized or mismatched tenant reference.
 */
export function resolveAgentContext(
  token: string,
  verifier: OidcTokenVerifier,
  options?: ResolveAgentContextOptions
): Effect.Effect<AgentContext, AuthenticationError | AuthorizationError> {
  return Effect.gen(function* () {
    const claims = yield* verifier.verifyToken(token);

    if (!claims.sub) {
      return yield* Effect.fail(
        new AuthenticationError({
          reason: "Token claims missing required subject (sub)",
        })
      );
    }

    const tenantId =
      claims.tenantId ??
      (claims.attributes?.tenantId as string | undefined) ??
      process.env.OPERON_TENANT_ID ??
      "tenant-default";

    // Non-disclosure security boundary:
    // When tenant is not matched, return generic Access denied without revealing tenant or entity existence
    if (options?.expectedTenantId && tenantId !== options.expectedTenantId) {
      return yield* Effect.fail(
        new AuthorizationError({
          reason: "Access denied",
        })
      );
    }

    const environmentId =
      (claims.attributes?.environmentId as string | undefined) ??
      process.env.OPERON_ENVIRONMENT_ID ??
      "default";

    if (
      options?.expectedEnvironmentId &&
      environmentId !== options.expectedEnvironmentId
    ) {
      return yield* Effect.fail(
        new AuthorizationError({
          reason: "Access denied",
        })
      );
    }

    const sponsorId =
      (claims.attributes?.sponsorId as string | undefined) ??
      claims.name ??
      claims.sub;

    const rawGrants = claims.attributes?.grants;
    const grants: readonly string[] = Array.isArray(rawGrants)
      ? rawGrants.map(String)
      : (claims.roles ?? []);

    const rawProfile =
      (claims.attributes?.profile as string | undefined) ??
      process.env.OPERON_PROFILE ??
      "external-agent";

    const profile: OperonProfile =
      rawProfile === "production" || rawProfile === "local"
        ? rawProfile
        : "external-agent";

    return {
      actorId: claims.sub,
      environmentId,
      grants,
      profile,
      sponsorId,
      tenantId,
    };
  });
}

/**
 * Maps enterprise IdP Claims (Okta, Azure AD, Keycloak) to Operon SecurityContext
 */
export const ClaimsSecurityMapper = {
  mapToSecurityContext(
    claims: OidcTokenClaims,
    subjectType: SubjectType = "user",
    clientIp?: string
  ): SecurityContext {
    const roles = claims.roles ?? ["authenticated"];
    const resolvedType =
      claims.type ??
      (claims.attributes?.type as SubjectType | undefined) ??
      subjectType;
    const resolvedTier =
      claims.agentTier ??
      (claims.attributes?.agentTier as 1 | 2 | 3 | 4 | undefined);
    const subject: Subject = {
      agentTier: resolvedTier,
      id: claims.sub,
      metadata: {
        clearance: claims.clearance ?? "UNCLASSIFIED",
        groups: claims.groups ?? [],
        tenantId: claims.tenantId,
        ...claims.attributes,
      },
      name: claims.name ?? claims.sub,
      roles,
      type: resolvedType,
    };

    return {
      subject,
      correlationId: `auth-${claims.sub}-${Date.now()}`,
      clientIp,
      timestamp: Date.now(),
    };
  },
};

/**
 * HTTP / MCP Bearer Token Authentication Middleware
 */
export class HttpAuthMiddleware {
  public constructor(private readonly verifier: OidcTokenVerifier) {}

  public authenticateHeader(
    authorizationHeader?: string,
    clientIp?: string
  ): Effect.Effect<SecurityContext, AuthenticationError | AuthorizationError> {
    if (!authorizationHeader) {
      return Effect.fail(
        new AuthenticationError({
          reason: "Missing Authorization header",
        })
      );
    }

    const [scheme, token] = authorizationHeader.trim().split(/\s+/u);
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return Effect.fail(
        new AuthenticationError({
          reason: "Authorization header must use Bearer scheme: Bearer <token>",
        })
      );
    }

    return this.verifier
      .verifyToken(token)
      .pipe(
        Effect.map((claims) =>
          ClaimsSecurityMapper.mapToSecurityContext(claims, "user", clientIp)
        )
      );
  }
}
