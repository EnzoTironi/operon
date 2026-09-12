import { AuthenticationError, HumanPrincipal } from "@operon/runtime";
import type { SessionToken } from "@operon/runtime";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import * as Pg from "pg";

/** Value of `HumanPrincipal.issuer` for sessions this cell vouched for. */
export const CELL_AUTH_ISSUER = "operon-cell";

/** Role every verified human session carries; the kernel's approval gate requires it. */
export const APPROVER_ROLE = "approver";

/**
 * Companion (or a hidden operator issuer) presents Better Auth `session.token`
 * as a Bearer credential. The kernel never sees a JWT.
 */
export function bearerAuthorization(token: SessionToken): string {
  const raw = Redacted.value(token).trim();
  const credential = raw.replace(/^Bearer\s+/iu, "");
  return `Bearer ${credential}`;
}

/**
 * Where Better Auth keeps users and sessions. The cell uses its own Postgres
 * (`OPERON_DATABASE_URL`); `memory` exists for local experiments and tests
 * and forgets everything when the process exits.
 */
export type CellAuthStore =
  | { readonly kind: "postgres"; readonly url: Redacted.Redacted<string> }
  | { readonly kind: "memory" };

export interface CellAuthConfig {
  readonly store: CellAuthStore;
  /** Better Auth signing secret (`OPERON_AUTH_SECRET`). */
  readonly secret: Redacted.Redacted<string>;
}

export class CellAuthError extends Data.TaggedError("CellAuthError")<{
  readonly operation: "migrate" | "issue_session" | "revoke_session";
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface IssueApproverSessionInput {
  readonly email: string;
  readonly name: string;
}

/** The only place a session token exists in the clear is this return value. */
export interface IssuedSession {
  readonly token: SessionToken;
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

function makeAuth(config: CellAuthConfig, pool: Pg.Pool | undefined) {
  return betterAuth({
    // `migrate` owns the schema; the startup diff would only log noise before it runs.
    advanced: { database: { validateSchema: false }, disableCSRFCheck: true },
    appName: "Operon Cell",
    baseURL: "http://operon-cell.invalid",
    database:
      pool ??
      memoryAdapter({ account: [], session: [], user: [], verification: [] }),
    emailAndPassword: { enabled: false },
    plugins: [bearer()],
    secret: Redacted.value(config.secret),
    telemetry: { enabled: false },
    user: {
      additionalFields: {
        roles: { defaultValue: [], required: false, type: "string[]" },
      },
    },
  });
}

type CellBetterAuth = ReturnType<typeof makeAuth>;

const authFailure = (reason: string) => new AuthenticationError({ reason });

const decodePrincipal = Schema.decodeUnknownEffect(HumanPrincipal);

/**
 * Boundary parse: Better Auth `getSession` becomes a `HumanPrincipal` or
 * nothing. Companion users have no Operon `roles` column; a verified human
 * session is the approver. The kernel never reads names from tool arguments.
 */
function toPrincipal(
  result: NonNullable<Awaited<ReturnType<CellBetterAuth["api"]["getSession"]>>>
): Effect.Effect<HumanPrincipal, AuthenticationError> {
  return decodePrincipal({
    email: result.user.email,
    issuer: CELL_AUTH_ISSUER,
    name: result.user.name,
    roles: [APPROVER_ROLE],
    sessionExpiresAt: result.session.expiresAt.getTime(),
    sessionId: result.session.id,
    userId: result.user.id,
  }).pipe(
    Effect.mapError(() =>
      authFailure("Session user record is missing required identity fields")
    )
  );
}

const verifySessionWith = (auth: CellBetterAuth) =>
  Effect.fn("CellAuth.verifySession")(function* (token: SessionToken) {
    const result = yield* Effect.tryPromise({
      catch: (cause) => authFailure(`Session lookup failed: ${String(cause)}`),
      try: () =>
        auth.api.getSession({
          headers: new Headers({
            authorization: bearerAuthorization(token),
          }),
        }),
    });
    if (result === null) {
      return yield* authFailure("Session token is unknown, expired or revoked");
    }
    return yield* toPrincipal(result);
  });

const issueApproverSessionWith = (auth: CellBetterAuth) =>
  Effect.fn("CellAuth.issueApproverSession")(function* (
    input: IssueApproverSessionInput
  ) {
    const issued = yield* Effect.tryPromise({
      catch: (cause) =>
        new CellAuthError({
          cause,
          message: `Could not issue an approver session for ${input.email}`,
          operation: "issue_session",
        }),
      try: async () => {
        const context = await auth.$context;
        const existing = await context.internalAdapter.findUserByEmail(
          input.email
        );
        const user =
          existing?.user ??
          (await context.internalAdapter.createUser(
            {
              email: input.email,
              emailVerified: true,
              name: input.name,
            },
            { method: "operon-cell-operator" }
          ));
        const session = await context.internalAdapter.createSession(user.id);
        return { session, user };
      },
    });
    return {
      expiresAt: issued.session.expiresAt.getTime(),
      sessionId: issued.session.id,
      token: Redacted.make(issued.session.token),
      userId: issued.user.id,
    } satisfies IssuedSession;
  });

const revokeSessionWith = (auth: CellBetterAuth) =>
  Effect.fn("CellAuth.revokeSession")(function* (token: SessionToken) {
    yield* Effect.tryPromise({
      catch: (cause) =>
        new CellAuthError({
          cause,
          message: "Could not revoke the session",
          operation: "revoke_session",
        }),
      try: async () => {
        const context = await auth.$context;
        await context.internalAdapter.deleteSession(Redacted.value(token));
      },
    });
  });

const migrateWith = (auth: CellBetterAuth) =>
  Effect.fn("CellAuth.migrate")(function* () {
    yield* Effect.tryPromise({
      catch: (cause) =>
        new CellAuthError({
          cause,
          message: "Better Auth schema migration failed",
          operation: "migrate",
        }),
      try: async () => {
        const migrations = await getMigrations(auth.options);
        await migrations.runMigrations();
      },
    });
  });

/**
 * Better Auth bound to the cell database. `migrate` creates or extends the
 * `user`, `session`, `account` and `verification` tables idempotently.
 * Companion is the session host: it issues `session.token` against this
 * same secret and store. `verifySession` turns a Bearer credential into a
 * `HumanPrincipal` on every call, so expiry and revocation take effect
 * immediately. `issueApproverSession` is a hidden operator seam, not the
 * documented path.
 */
export class CellAuth extends Context.Service<
  CellAuth,
  {
    readonly migrate: () => Effect.Effect<void, CellAuthError>;
    readonly issueApproverSession: (
      input: IssueApproverSessionInput
    ) => Effect.Effect<IssuedSession, CellAuthError>;
    readonly revokeSession: (
      token: SessionToken
    ) => Effect.Effect<void, CellAuthError>;
    readonly verifySession: (
      token: SessionToken
    ) => Effect.Effect<HumanPrincipal, AuthenticationError>;
  }
>()("operon/cell-auth/CellAuth") {
  /** Scoped: the Postgres pool (when used) closes with the scope. */
  static readonly layer = (config: CellAuthConfig) =>
    Layer.effect(
      CellAuth,
      Effect.gen(function* () {
        const store = config.store;
        const pool =
          store.kind === "postgres"
            ? yield* Effect.acquireRelease(
                Effect.sync(
                  () =>
                    new Pg.Pool({
                      connectionString: Redacted.value(store.url),
                    })
                ),
                (opened) => Effect.promise(() => opened.end())
              )
            : undefined;
        const auth = makeAuth(config, pool);
        return CellAuth.of({
          issueApproverSession: issueApproverSessionWith(auth),
          migrate: migrateWith(auth),
          revokeSession: revokeSessionWith(auth),
          verifySession: verifySessionWith(auth),
        });
      })
    );
}
