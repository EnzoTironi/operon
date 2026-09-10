import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOperonMcpServer } from "@operon/mcp";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runMcp(args: string[]): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0] ?? "start";

    if (sub !== "start") {
      console.error(`Error: Unknown mcp subcommand '${sub}'`);
      console.error(
        "  Usage: operon mcp start [--agent-tier <1|2|3|4>] [--db <path>]"
      );
      return 1;
    }

    const tierIndex = args.indexOf("--agent-tier");
    const agentTier =
      tierIndex === -1
        ? (4 as const)
        : (Math.trunc(Number(args[tierIndex + 1])) as 1 | 2 | 3 | 4);

    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));

    const server = createOperonMcpServer({
      actionTypes: ctx.actionTypes,
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

    yield* Effect.logInfo("Operon MCP Server connected via stdio transport");

    // Stdio server stays alive until process terminates
    return yield* Effect.callback<number>((resume) => {
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
  }).pipe(
    Effect.annotateLogs({ command: "mcp", subcommand: args[0] ?? "start" })
  );
}
