import type { CellAuthConfig } from "@operon/cell-auth";
import type { SessionToken } from "@operon/runtime";
import { Data, Effect, Option, Redacted } from "effect";

import type { DatabaseTarget } from "./state.js";

/** Companion (and the CLI) present Better Auth `session.token` here. */
export const SESSION_TOKEN_ENV = "OPERON_SESSION";
/** Alias kept so existing cell env files keep working. */
export const APPROVER_SESSION_TOKEN_ENV = "OPERON_APPROVER_SESSION_TOKEN";
export const AUTH_SECRET_ENV = "OPERON_AUTH_SECRET";

export class CellAuthConfigError extends Data.TaggedError(
  "CellAuthConfigError"
)<{
  readonly message: string;
}> {}

/**
 * Cell auth needs the cell database (sessions must outlive one process) and
 * the signing secret. Fails with the exact variable the operator has to set.
 */
export function resolveCellAuthConfig(
  target: DatabaseTarget
): Effect.Effect<CellAuthConfig, CellAuthConfigError> {
  if (target.kind !== "postgres") {
    return new CellAuthConfigError({
      message:
        "Cell auth needs the cell Postgres: set OPERON_DATABASE_URL to a postgresql:// URL (pnpm cell:up writes it to .env).",
    });
  }
  const secret = process.env[AUTH_SECRET_ENV];
  if (!secret) {
    return new CellAuthConfigError({
      message: `Cell auth needs ${AUTH_SECRET_ENV} (pnpm cell:up writes it to .env).`,
    });
  }
  return Effect.succeed({
    secret: Redacted.make(secret),
    store: { kind: "postgres", url: target.url },
  });
}

function bearerCredential(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.replace(/^Bearer\s+/iu, "");
}

/**
 * Better Auth `session.token` the host handed to this process, if any.
 * `OPERON_SESSION` is the documented variable; the legacy alias is accepted
 * when it names the same credential.
 */
export function readApproverSessionToken(): Effect.Effect<
  Option.Option<SessionToken>,
  CellAuthConfigError
> {
  const session = bearerCredential(process.env[SESSION_TOKEN_ENV]);
  const legacy = bearerCredential(process.env[APPROVER_SESSION_TOKEN_ENV]);
  if (session && legacy && session !== legacy) {
    return new CellAuthConfigError({
      message: `${SESSION_TOKEN_ENV} and ${APPROVER_SESSION_TOKEN_ENV} both set and differ. Supply one Better Auth session.token.`,
    });
  }
  const token = session ?? legacy;
  return Effect.succeed(
    token ? Option.some(Redacted.make(token)) : Option.none()
  );
}
