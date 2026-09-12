import { CellAuth } from "@operon/cell-auth";
import { Cause, Effect, Exit, Redacted } from "effect";

import {
  SESSION_TOKEN_ENV,
  resolveCellAuthConfig,
} from "../cell-auth-config.js";
import { printCli, printCliError, printCliJson } from "../io.js";
import { resolveDatabaseTarget } from "../state.js";

const USAGE =
  "  Usage: operon approver session --email <email> --name <name> [--db <postgres-url>] [--json]";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const issueSession = Effect.fn("issueSession")(function* (
  email: string,
  name: string,
  json: boolean
) {
  const auth = yield* CellAuth;
  yield* auth.migrate();
  const issued = yield* auth.issueApproverSession({ email, name });
  const expiresAt = new Date(issued.expiresAt).toISOString();

  if (json) {
    printCliJson({
      expiresAt,
      sessionId: issued.sessionId,
      token: Redacted.value(issued.token),
      userId: issued.userId,
    });
    return;
  }

  printCli(`Approver session issued for ${email} (user ${issued.userId}).`);
  printCli(`Expires at ${expiresAt}.`);
  printCli(
    `Hidden operator issuer. Companion is the session host. For local experiments, hand the token to operon mcp start as ${SESSION_TOKEN_ENV}. It is shown once:`
  );
  printCli(Redacted.value(issued.token));
});

/**
 * Hidden operator issuer: binds a verified human to the cell by issuing a
 * Better Auth session on the cell Postgres. Companion is the session host
 * on the documented path. This command remains for local experiments.
 */
export function runApprover(args: string[]): Effect.Effect<number> {
  return Effect.gen(function* () {
    const sub = args[0];
    const email = flagValue(args, "--email");
    const name = flagValue(args, "--name");
    if (sub !== "session" || !email || !name) {
      printCliError("Error: approver session needs --email and --name");
      printCliError(USAGE);
      return 1;
    }

    const target = resolveDatabaseTarget(flagValue(args, "--db"));
    const exit = yield* Effect.exit(
      resolveCellAuthConfig(target).pipe(
        Effect.flatMap((config) =>
          issueSession(email, name, args.includes("--json")).pipe(
            Effect.provide(CellAuth.layer(config)),
            Effect.scoped
          )
        )
      )
    );
    if (Exit.isFailure(exit)) {
      printCliError(`Error: ${Cause.pretty(exit.cause)}`);
      return 1;
    }
    return 0;
  }).pipe(
    Effect.annotateLogs({ command: "approver", subcommand: args[0] ?? "none" })
  );
}
