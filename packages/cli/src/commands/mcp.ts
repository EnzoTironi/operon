import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOperonMcpServer } from "@operon/mcp";

import { createRuntimeContext } from "../state.js";

export async function runMcp(args: string[]): Promise<number> {
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

  const ctx = await createRuntimeContext(dbPath);

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
    securityEngine: ctx.securityEngine,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stdio server stays alive until process terminates
  // oxlint-disable-next-line promise/avoid-new
  return new Promise<number>((resolve) => {
    process.on("SIGINT", () => resolve(0));
    process.on("SIGTERM", () => resolve(0));
  });
}
