# @operon/mcp

Model Context Protocol (MCP) server for **Operon**, allowing AI agents (Claude Desktop, Cursor, Custom Agents) to safely perceive operational state, query bitemporal ontologies, and execute governed actions under strict cryptographic security boundaries.

---

## Key Features

- **Dual Key Isolation**:
  - **Consumer Key**: Restricts agents to read queries and bounded action executions under assigned risk tiers.
  - **Builder Key**: Required for AI Forward Deployed Engineers (AI-FDE) modifying ontology definitions or creating OMS branches.
- **Dynamic Action Tool Projection**:
  - Automatically transforms `@operon/schema` Action cards into MCP tool definitions with JSON Schema parameter validation, risk disclosures, and agent tier requirements.
- **4-Tier Agent Autonomy Ladder**:
  1. `Tier 1: Observe` — Read-only state inspection.
  2. `Tier 2: Propose` — Actions automatically routed to Action Inbox as pending proposals.
  3. `Tier 3: Execute with Approval` — Requires explicit human confirmation.
  4. `Tier 4: Bounded Autonomy` — Automated execution within pre-verified safety envelopes.
- **AI Forward Deployed Engineer (AI-FDE)**:
  - Agent capable of inspecting schema gaps, proposing schema evolutions, and drafting branch changesets through the Ontology Metadata Service (OMS).

---

## Launching the MCP Server

### Stdio Transport (Claude Desktop / Cursor)

```bash
# Start server with default Tier 4 bounded autonomy
operon mcp start --agent-tier 4

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
        "4"
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
    agentId: "agent_fde",
    agentTier: 4,
    keyId: "builder_key_1",
    name: "AIFdeAgent",
    role: "builder",
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
```
