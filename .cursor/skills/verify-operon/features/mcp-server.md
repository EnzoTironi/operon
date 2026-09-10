# Stdio MCP Server Specification

Operon provides a Model Context Protocol (MCP) server that dynamically projects ontology types, objects, 4C readiness checks, and governed actions into standard tool definitions for LLM agents.

---

## Sub-features

1. **Model Context Protocol Compliance**:
   - Implements the official MCP specification using stdio transport and JSON-RPC 2.0.
   - Handles protocol handshakes, capability negotiation, and tool listing.
2. **Projected Tooling Suite**:
   - `get_object`: Retrieves point-in-time ontology instances.
   - `query_objects`: Executes structured property filters.
   - `check_decision_readiness`: Evaluates 4C readiness gates before acting.
   - `preview_action`: Dry-run simulation of governed action submissions.
   - `execute_action`: Governed write pipeline execution enforcing agent autonomy tiers.
3. **Agent Security Propagation**:
   - Maps agent credentials to the caller's `Subject` context with bounded autonomy tiers (T1–T4).
   - Prevents unauthorized mutations at the protocol boundary.

---

## How to get to it (user POV)

- **CLI**: `operon mcp start [--db <path>]`
- **Cursor / Claude Desktop Integration**: Add to your MCP configuration file:
  ```json
  {
    "mcpServers": {
      "operon": {
        "command": "node",
        "args": [
          "/Users/enzotironi/operationalonto/packages/cli/dist/bin.js",
          "mcp",
          "start"
        ]
      }
    }
  }
  ```

---

## Driving it with operon CLI

### 1. Test MCP Protocol Initialization over Stdin

Send an MCP `initialize` handshake packet:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-harness","version":"1.0.0"}}}' | \
  node packages/cli/dist/bin.js mcp start
```

### 2. Verify Available Tools Discovery

Send `tools/list` request to verify projected ontology tools:

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | \
  node packages/cli/dist/bin.js mcp start
```

---

## Gotchas

1. **Stdio Purity**: MCP protocol frames are exchanged over `stdin` and `stdout`. Standard debug logging must write to `stderr` to avoid protocol framing errors.
2. **Interactive Lifetime**: When started directly in a terminal without pipes, `operon mcp start` will wait for stdin. Use `Ctrl+C` to terminate.
3. **Persistence**: When started without `--db <path>`, the MCP server initializes an in-memory ontology store.
