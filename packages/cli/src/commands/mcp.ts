import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CellAuth, CellSessionVerifier } from "@operon/cell-auth";
import { createOperonMcpServer, unboundApprover } from "@operon/mcp";
import type { ApproverBinding } from "@operon/mcp";
import { SessionVerifier } from "@operon/runtime";
import type { SessionToken } from "@operon/runtime";
import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect";

import {
  readApproverSessionToken,
  resolveCellAuthConfig,
} from "../cell-auth-config.js";
import { printCliError } from "../io.js";
import { createRuntimeContext } from "../state.js";
import type { DatabaseTarget } from "../state.js";

/**
 * Binds the approver for this server from `OPERON_APPROVER_SESSION_TOKEN`.
 * The verifier lives for the whole process (the given scope), so each tool
 * call re-checks the token against the cell database.
 */
const bindApprover = Effect.fn("bindApprover")(function* (
  token: SessionToken,
  target: DatabaseTarget,
  scope: Scope.Closeable
) {
  const config = yield* resolveCellAuthConfig(target);
  const context = yield* Layer.buildWithScope(
    Layer.provideMerge(CellSessionVerifier, CellAuth.layer(config)),
    scope
  );
  const verifier = Context.get(context, SessionVerifier);
  return { _tag: "Session", token, verifier } satisfies ApproverBinding;
});

export function runMcp(args: string[]): Effect.Effect<number> {
  return Effect.gen(function* () {
    const sub = args[0] ?? "start";

    if (sub !== "start") {
      printCliError(`Error: Unknown mcp subcommand '${sub}'`);
      printCliError(
        "  Usage: operon mcp start [--agent-tier <1|2|3|4>] [--db <path>]"
      );
      return 1;
    }

    const tierIndex = args.indexOf("--agent-tier");
    // SAFETY: default agent tier 4 conforms to AgentTier union
    const defaultTier: 1 | 2 | 3 | 4 = 4;
    // SAFETY: tier argument parsed as numeric agent tier union
    const agentTier =
      tierIndex === -1
        ? defaultTier
        : (Math.trunc(Number(args[tierIndex + 1])) as 1 | 2 | 3 | 4);

    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));
    const authScope = yield* Scope.make();

    const approverExit = yield* Effect.exit(
      Option.match(readApproverSessionToken(), {
        onNone: () => Effect.succeed(unboundApprover),
        onSome: (token) => bindApprover(token, ctx.database, authScope),
      })
    );
    if (Exit.isFailure(approverExit)) {
      printCliError(
        `Error: cannot bind the approver session: ${Cause.pretty(approverExit.cause)}`
      );
      yield* Effect.promise(() => ctx.close());
      return 1;
    }

    const server = createOperonMcpServer({
      actionTypes: ctx.actionTypes,
      approver: approverExit.value,
      auditStore: ctx.auditStore,
      defaultCallerKey: {
        agentId: `mcp_agent_tier${agentTier}`,
        agentTier,
        keyId: `key_tier${agentTier}`,
        name: `McpAgentTier${agentTier}`,
        role: "consumer",
      },
      inbox: ctx.inbox,
      objectStore: ctx.objectStore,
      objectTypes: ctx.objectTypes,
      oms: ctx.oms,
      securityEngine: ctx.securityEngine,
    });

    const transport = new StdioServerTransport();
    yield* Effect.promise(() => server.connect(transport));

    yield* Effect.logInfo(
      `Operon MCP Server connected via stdio transport (approver ${approverExit.value._tag === "Session" ? "bound to a cell session" : "unbound"})`
    );

    // Stdio server stays alive until process terminates
    const code = yield* Effect.callback<number>((resume) => {
      const onSigint = () => {
        resume(Effect.succeed(0));
      };
      const onSigterm = () => {
        resume(Effect.succeed(0));
      };
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      return Effect.sync(() => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      });
    });
    yield* Scope.close(authScope, Exit.void);
    yield* Effect.promise(() => ctx.close());
    return code;
  }).pipe(
    Effect.annotateLogs({ command: "mcp", subcommand: args[0] ?? "start" })
  );
}
