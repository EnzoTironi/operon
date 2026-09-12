import type { CellAuthConfig } from "@operon/cell-auth";
import type { SessionToken } from "@operon/runtime";
import { Data, Effect, Option, Redacted } from "effect";

import type { DatabaseTarget } from "./state.js";

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

/** The approver session the host handed to this process, if any. */
export function readApproverSessionToken(): Option.Option<SessionToken> {
  const token = process.env[APPROVER_SESSION_TOKEN_ENV];
  return token ? Option.some(Redacted.make(token)) : Option.none();
}
