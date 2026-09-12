# @operon/mcp

Model Context Protocol (MCP) server for **Operon**, allowing AI agents (Claude Desktop, Cursor, Custom Agents) to safely perceive operational state, query bitemporal ontologies, and execute governed actions under strict cryptographic security boundaries.

---

## Key Features

- **Dual Key Isolation**:
  - **Consumer Key**: Restricts agents to read queries and bounded action executions under assigned risk tiers.
  - **Builder Key**: Required to modify ontology definitions or create OMS branches. Builder is not a human approver.
- **Dynamic Action Tool Projection**:
  - Automatically transforms `@operon/schema` Action cards into MCP tool definitions with JSON Schema parameter validation, risk disclosures, and agent tier requirements.
- **4-Tier Agent Autonomy Ladder**:
  1. `Tier 1: Observe` — Read-only state inspection.
  2. `Tier 2: Propose` — Actions automatically routed to Action Inbox as pending proposals.
  3. `Tier 3: Execute with Approval` — Requires explicit human confirmation.
  4. `Tier 4: Bounded Autonomy` — Automated execution within pre-verified safety envelopes. Opt-in; `operon mcp start` defaults to tier 2.

---

## Launching the MCP Server

### Stdio Transport (Claude Desktop / Cursor)

```bash
# Start server with default Consumer / Propose (tier 2)
operon mcp start

# Start server connected to persistent SQLite bitemporal store
operon mcp start --agent-tier 2 --db ./operon.db
```

### Claude Desktop Configuration (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "operon": {
      "command": "node",
      "args": [
        "/path/to/operon/packages/cli/dist/bin.js",
        "mcp",
        "start",
        "--agent-tier",
        "2"
      ]
    }
  }
}
```

---

## Programmatic API

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOperonMcpServer } from "@operon/mcp";

const server = createOperonMcpServer({
  objectTypes,
  actionTypes,
  objectStore,
  auditStore,
  inbox,
  securityEngine,
  defaultCallerKey: {
    agentId: "agent_consumer",
    agentTier: 2,
    keyId: "consumer_key_1",
    name: "ConsumerAgent",
    role: "consumer",
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
```
