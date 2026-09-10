/** Authored regression test using the REAL MCP InMemoryTransport; NOT executed here.
 * No model or external API is called. The only effect increments a local counter.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryAuditStore, InMemoryObjectStore } from "@operon/runtime";
import { defineActionType } from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createOperonMcpServer } from "./server.js";

describe("Independent MCP approval trust-boundary validation", () => {
  it("P04 a consumer cannot approve its own proposal by naming a human", async () => {
    let effects = 0;
    const action = defineActionType({
      id: "local_test",
      name: "Local test",
      description: "Local only",
      parametersSchema: Schema.Struct({}),
      riskTier: "high",
      minimumAgentTier: 2,
      defaultExecutionMode: "proposal",
      sideEffects: [
        {
          id: "counter",
          description: "local",
          execute: () =>
            Effect.sync(() => {
              effects++;
            }),
        },
      ],
    });
    const server = createOperonMcpServer({
      objectStore: new InMemoryObjectStore(),
      auditStore: new InMemoryAuditStore(),
      objectTypes: [],
      actionTypes: [action],
    });
    const client = new Client(
      { name: "independent-validator", version: "1.0.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const proposed: any = await client.callTool({
        name: "operon_local_test",
        arguments: {},
      });
      expect(proposed.isError).toBeFalsy();
      const body = JSON.parse(proposed.content[0].text);
      expect(body.status).toBe("PROPOSAL_CREATED");
      await client
        .callTool({
          name: "operon_approve_proposal",
          arguments: {
            proposalId: body.proposalId,
            approverId: "synthetic-human",
            approverRoles: ["reviewer"],
          },
        })
        .catch(() => undefined);
      expect(effects).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
