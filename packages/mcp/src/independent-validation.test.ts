/** Authored regression test using the REAL MCP InMemoryTransport; NOT executed here.
 * No model or external API is called. The only effect increments a local counter.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryAuditStore,
  InMemoryObjectStore,
  OntologyMetadataService,
} from "@operon/runtime";
import { defineActionType, parseJson } from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { unboundApprover } from "./approver.js";
import { createOperonMcpServer } from "./server.js";

describe("Independent MCP approval trust-boundary validation", () => {
  it("P04 a consumer cannot approve its own proposal by naming a human", () =>
    Effect.gen(function* () {
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
        approver: unboundApprover,
        actionTypes: [action],
        auditStore: new InMemoryAuditStore(),
        objectStore: new InMemoryObjectStore(),
        objectTypes: [],
        oms: new OntologyMetadataService(),
      });
      const client = new Client(
        { name: "independent-validator", version: "1.0.0" },
        { capabilities: {} }
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      yield* Effect.promise(() => server.connect(serverTransport));
      yield* Effect.promise(() => client.connect(clientTransport));

      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            Effect.promise(() => client.close()),
            Effect.promise(() => server.close()),
          ],
          { concurrency: 2 }
        )
      );

      const proposed: any = yield* Effect.promise(() =>
        client.callTool({
          name: "operon_local_test",
          arguments: {},
        })
      );
      expect(proposed.isError).toBeFalsy();
      const body = parseJson(proposed.content[0].text) as {
        readonly proposalId: string;
        readonly status: string;
      };
      expect(body.status).toBe("PROPOSAL_CREATED");
      yield* Effect.promise(() =>
        client.callTool({
          name: "operon_approve_proposal",
          arguments: {
            proposalId: body.proposalId,
            approverId: "synthetic-human",
            approverRoles: ["reviewer"],
          },
        })
      ).pipe(Effect.ignore);
      expect(effects).toBe(0);
    }).pipe(Effect.scoped, Effect.runPromise));
});
