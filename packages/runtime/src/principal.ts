import type { Subject } from "@operon/schema";
import type { Effect, Redacted } from "effect";
import { Context, Schema } from "effect";

import type { AuthenticationError } from "./errors.js";

/** Identifier of a human user in the cell's auth store. Never an agent id. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/**
 * A human identity the edge has already verified against an authenticated
 * session. Constructed only by a `SessionVerifier`; everything behind the
 * edge trusts it and never re-reads names or roles from request payloads.
 */
export class HumanPrincipal extends Schema.Class<HumanPrincipal>(
  "HumanPrincipal"
)({
  userId: UserId,
  name: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
  roles: Schema.Array(Schema.NonEmptyString),
  sessionId: Schema.NonEmptyString,
  sessionExpiresAt: Schema.Number,
  /** Which auth store vouched for the session, for example `operon-cell`. */
  issuer: Schema.NonEmptyString,
}) {}

/** Opaque session credential presented at the edge. */
export type SessionToken = Redacted.Redacted<string>;

/**
 * The seam between a session store (Better Auth in the cell) and the kernel.
 * Implementations resolve a token to the human it belongs to or fail with
 * `AuthenticationError`; they never return partially trusted identities.
 */
export class SessionVerifier extends Context.Service<
  SessionVerifier,
  {
    readonly verifySession: (
      token: SessionToken
    ) => Effect.Effect<HumanPrincipal, AuthenticationError>;
  }
>()("operon/runtime/SessionVerifier") {}

/** Projects a verified principal onto the kernel's `Subject` shape. */
export function principalSubject(principal: HumanPrincipal): Subject {
  return {
    id: principal.userId,
    metadata: {
      email: principal.email,
      issuer: principal.issuer,
      sessionId: principal.sessionId,
    },
    name: principal.name,
    roles: principal.roles,
    type: "user",
  };
}
