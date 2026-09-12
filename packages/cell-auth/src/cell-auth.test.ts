import { HumanPrincipal, SessionVerifier } from "@operon/runtime";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { Effect, Exit, Layer, Redacted } from "effect";
import * as Pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { APPROVER_ROLE, CELL_AUTH_ISSUER, CellAuth } from "./cell-auth.js";
import type { CellAuthConfig } from "./cell-auth.js";
import { CellSessionVerifier } from "./session-verifier.js";
import { createPostgresTestDatabase } from "./testing/postgres-test-database.js";

const secret = Redacted.make("test-secret-at-least-32-characters-long!!");

const memoryConfig: CellAuthConfig = { secret, store: { kind: "memory" } };

const ana = { email: "ana@clinica.example", name: "Ana" };

function failureTag(exit: Exit.Exit<unknown, { readonly _tag: string }>) {
  if (Exit.isFailure(exit)) {
    const reason = exit.cause.reasons[0];
    return reason?._tag === "Fail" ? reason.error._tag : reason?._tag;
  }
  return "Success";
}

describe("CellAuth on the memory store", () => {
  const run = <A, E>(
    program: Effect.Effect<A, E, CellAuth | SessionVerifier>
  ) =>
    Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              CellSessionVerifier,
              CellAuth.layer(memoryConfig)
            )
          )
        )
      )
    );

  it("issues an approver session and verifies it into a HumanPrincipal", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        const verifier = yield* SessionVerifier;
        const issued = yield* auth.issueApproverSession(ana);
        expect(String(issued.token)).not.toContain(
          Redacted.value(issued.token)
        );

        const principal = yield* verifier.verifySession(issued.token);
        expect(principal).toBeInstanceOf(HumanPrincipal);
        expect(principal.userId).toBe(issued.userId);
        expect(principal.sessionId).toBe(issued.sessionId);
        expect(principal.sessionExpiresAt).toBe(issued.expiresAt);
        expect(principal.email).toBe(ana.email);
        expect(principal.name).toBe("Ana");
        expect(principal.roles).toEqual([APPROVER_ROLE]);
        expect(principal.issuer).toBe(CELL_AUTH_ISSUER);
      })
    ));

  it("binds every session for the same email to one user", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        const first = yield* auth.issueApproverSession(ana);
        const second = yield* auth.issueApproverSession({
          ...ana,
          name: "Ana B.",
        });
        expect(second.userId).toBe(first.userId);
        expect(second.sessionId).not.toBe(first.sessionId);
        const principal = yield* auth.verifySession(second.token);
        expect(principal.name).toBe("Ana");
      })
    ));

  it("accepts the same token presented as an Authorization Bearer credential", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        const issued = yield* auth.issueApproverSession(ana);
        const principal = yield* auth.verifySession(
          Redacted.make(`Bearer ${Redacted.value(issued.token)}`)
        );
        expect(principal.userId).toBe(issued.userId);
        expect(principal.roles).toEqual([APPROVER_ROLE]);
      })
    ));

  it("rejects tokens it never issued", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        yield* auth.issueApproverSession(ana);
        const exit = yield* Effect.exit(
          auth.verifySession(Redacted.make("not-a-session"))
        );
        expect(failureTag(exit)).toBe("AuthenticationError");
      })
    ));

  it("rejects a JWT-shaped token instead of verifying HS256", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        yield* auth.issueApproverSession(ana);
        const exit = yield* Effect.exit(
          auth.verifySession(
            Redacted.make(
              "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbmEifQ.not-a-signature"
            )
          )
        );
        expect(failureTag(exit)).toBe("AuthenticationError");
      })
    ));

  it("rejects a revoked session on the next verification", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        const issued = yield* auth.issueApproverSession(ana);
        yield* auth.verifySession(issued.token);
        yield* auth.revokeSession(issued.token);
        const exit = yield* Effect.exit(auth.verifySession(issued.token));
        expect(failureTag(exit)).toBe("AuthenticationError");
      })
    ));
});

const database = await createPostgresTestDatabase();

describe.skipIf(database === undefined)("CellAuth on the cell Postgres", () => {
  if (database === undefined) {
    return;
  }
  const target = database;
  const config: CellAuthConfig = {
    secret,
    store: { kind: "postgres", url: target.url },
  };
  const run = <A, E>(program: Effect.Effect<A, E, CellAuth>) =>
    Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(CellAuth.layer(config))))
    );

  afterAll(() => target.drop());

  it("migrates the schema idempotently and persists sessions across instances", async () => {
    const issued = await run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        yield* auth.migrate();
        yield* auth.migrate();
        return yield* auth.issueApproverSession(ana);
      })
    );

    const principal = await run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        return yield* auth.verifySession(issued.token);
      })
    );
    expect(principal.userId).toBe(issued.userId);
    expect(principal.roles).toEqual([APPROVER_ROLE]);

    const client = new Pg.Client({
      connectionString: Redacted.value(target.url),
    });
    await client.connect();
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    await client.end();
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
  });

  it("rejects a session once its expiry has passed", async () => {
    const issued = await run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        return yield* auth.issueApproverSession({
          email: "bia@clinica.example",
          name: "Bia",
        });
      })
    );

    const client = new Pg.Client({
      connectionString: Redacted.value(target.url),
    });
    await client.connect();
    await client.query(
      `UPDATE "session" SET "expiresAt" = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [issued.sessionId]
    );
    await client.end();

    const exit = await run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        return yield* Effect.exit(auth.verifySession(issued.token));
      })
    );
    expect(failureTag(exit)).toBe("AuthenticationError");
  });

  it("parses a Companion Better Auth session.token that has no Operon roles", async () => {
    await run(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        yield* auth.migrate();
      })
    );

    const pool = new Pg.Pool({
      connectionString: Redacted.value(target.url),
    });
    try {
      const hostAuth = betterAuth({
        advanced: {
          database: { validateSchema: false },
          disableCSRFCheck: true,
        },
        appName: "Companion",
        baseURL: "http://companion.example",
        database: pool,
        emailAndPassword: { enabled: false },
        plugins: [bearer()],
        secret: Redacted.value(secret),
        telemetry: { enabled: false },
      });
      const context = await hostAuth.$context;
      const user = await context.internalAdapter.createUser({
        email: "ana@companion.example",
        emailVerified: true,
        name: "Ana",
      });
      const session = await context.internalAdapter.createSession(user.id);

      const principal = await run(
        Effect.gen(function* () {
          const auth = yield* CellAuth;
          return yield* auth.verifySession(Redacted.make(session.token));
        })
      );
      expect(principal.userId).toBe(user.id);
      expect(principal.email).toBe("ana@companion.example");
      expect(principal.name).toBe("Ana");
      expect(principal.roles).toEqual([APPROVER_ROLE]);
      expect(principal.issuer).toBe(CELL_AUTH_ISSUER);
    } finally {
      await pool.end();
    }
  });
});
