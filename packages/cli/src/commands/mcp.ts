import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CellAuth, CellSessionVerifier } from "@operon/cell-auth";
import {
  createOperonMcpServer,
  McpKeyRole,
  unboundApprover,
} from "@operon/mcp";
import type { ApproverBinding } from "@operon/mcp";
import { SessionVerifier } from "@operon/runtime";
import type { SessionToken } from "@operon/runtime";
import { AgentAuthorizationTier } from "@operon/schema";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";
import type { Scope } from "effect";

import {
  readApproverSessionToken,
  resolveCellAuthConfig,
} from "../cell-auth-config.js";
import { printCliError } from "../io.js";
import { createRuntimeContext } from "../state.js";
import type { DatabaseTarget } from "../state.js";

/**
 * Binds the approver for this server from Companion's Better Auth
 * `session.token` (`OPERON_SESSION`). The verifier lives for the whole
 * process (the given scope), so each tool call re-checks the token
 * against the cell database.
 */
const bindApprover = Effect.fn("bindApprover")(function* (
  token: SessionToken,
  target: DatabaseTarget,
  scope: Scope.Scope
) {
  const config = yield* resolveCellAuthConfig(target);
  const context = yield* Layer.buildWithScope(
    Layer.provideMerge(CellSessionVerifier, CellAuth.layer(config)),
    scope
  );
  const verifier = Context.get(context, SessionVerifier);
  return { _tag: "Session", token, verifier } satisfies ApproverBinding;
});

class McpOptionsError extends Data.TaggedError("McpOptionsError")<{
  readonly reason: string;
}> {}

const McpOptions = Schema.Struct({
  agentTier: AgentAuthorizationTier,
  role: McpKeyRole,
  dbPath: Schema.optional(Schema.NonEmptyString),
  workspaceId: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9:_-]{1,160}$/u))
  ),
  hostApprover: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (options) =>
      !options.hostApprover ||
      (options.role === "builder" && Boolean(options.workspaceId))
  )
);

/** Consumer Propose. Tier 4 bounded autonomy is opt-in. */
export const DEFAULT_MCP_AGENT_TIER =
  2 as const satisfies AgentAuthorizationTier;

export const parseMcpOptions = Effect.fn("parseMcpOptions")(function* (
  args: readonly string[]
) {
  const values = new Map<string, string | boolean>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || values.has(flag))
      return yield* new McpOptionsError({ reason: "duplicate option" });
    if (flag === "--host-approver") {
      values.set(flag, true);
      continue;
    }
    if (!["--agent-tier", "--role", "--db", "--workspace"].includes(flag))
      return yield* new McpOptionsError({ reason: "unknown option" });
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      return yield* new McpOptionsError({ reason: "missing option value" });
    values.set(flag, value);
    index += 1;
  }
  return yield* Schema.decodeUnknownEffect(McpOptions)({
    agentTier: Number(values.get("--agent-tier") ?? DEFAULT_MCP_AGENT_TIER),
    role: values.get("--role") ?? "consumer",
    dbPath: values.get("--db"),
    workspaceId: values.get("--workspace"),
    hostApprover: values.has("--host-approver"),
  });
});

export function runMcp(args: string[]): Effect.Effect<number> {
  return Effect.gen(function* () {
    const sub = args[0] ?? "start";

    if (sub !== "start") {
      printCliError(`Error: Unknown mcp subcommand '${sub}'`);
      printCliError(
        "  Usage: operon mcp start [--agent-tier <1|2|3|4>] [--role <consumer|builder>] [--db <path>] [--workspace <id>] [--host-approver]"
      );
      printCliError(
        "  Default --agent-tier is 2 (Consumer, Propose). Tier 4 must be set explicitly."
      );
      return 1;
    }

    const parsed = yield* Effect.exit(parseMcpOptions(args));
    if (Exit.isFailure(parsed)) {
      printCliError(
        "Error: --agent-tier must be 1, 2, 3 or 4; --role must be consumer or builder. Use --db <path|url>, --workspace <id>, --host-approver; values must be present and options unique."
      );
      return 1;
    }
    const { agentTier, role, dbPath, workspaceId, hostApprover } = parsed.value;
    const sessionToken = yield* Effect.exit(readApproverSessionToken());
    if (Exit.isFailure(sessionToken)) {
      printCliError(`Error: ${Cause.pretty(sessionToken.cause)}`);
      return 1;
    }
    if (hostApprover && Option.isSome(sessionToken.value)) {
      printCliError(
        "Error: use either --host-approver or a cell session token."
      );
      return 1;
    }
    const ctx = yield* Effect.acquireRelease(
      Effect.promise(() => createRuntimeContext(dbPath, workspaceId)),
      (runtime) => Effect.promise(() => runtime.close())
    );
    const authScope = yield* Effect.scope;

    const approverExit = yield* Effect.exit(
      Option.match(sessionToken.value, {
        onNone: () => Effect.succeed(unboundApprover),
        onSome: (token) => bindApprover(token, ctx.database, authScope),
      })
    );
    if (Exit.isFailure(approverExit)) {
      printCliError(
        `Error: cannot bind the approver session: ${Cause.pretty(approverExit.cause)}`
      );
      return 1;
    }

    const server = createOperonMcpServer({
      actionTypes: ctx.actionTypes,
      atomicCommitService: ctx.atomicCommit,
      authorityService: ctx.authority,
      governedActionService: ctx.governedActions,
      ingestionService: ctx.ingestion,
      operonService: ctx.operonService,
      reconciliationService: ctx.reconciliation,
      approver: approverExit.value,
      hostApprover,
      checkpoint: ctx.checkpoint,
      auditStore: ctx.auditStore,
      defaultCallerKey: {
        agentId: `mcp_agent_tier${agentTier}`,
        agentTier,
        keyId: `key_tier${agentTier}`,
        name: `McpAgentTier${agentTier}`,
        role,
      },
      inbox: ctx.inbox,
      objectStore: ctx.objectStore,
      objectTypes: ctx.objectTypes,
      oms: ctx.oms,
      securityEngine: ctx.securityEngine,
    });

    yield* Effect.acquireRelease(Effect.succeed(server), (mcp) =>
      Effect.promise(() => mcp.close())
    );
    const transport = new StdioServerTransport();
    yield* Effect.promise(() => server.connect(transport));

    printCliError(
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
    return code;
  }).pipe(
    Effect.scoped,
    Effect.annotateLogs({ command: "mcp", subcommand: args[0] ?? "start" })
  );
}
