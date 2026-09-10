/** Authored regression tests, NOT executed here with repository dependencies. */
import {
  ActionInbox,
  InMemoryAuditStore,
  InMemoryObjectStore,
} from "@operon/runtime";
import { defineActionType } from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createWorkerFetchHandler } from "./worker-handler.js";

describe("Independent HTTP trust-boundary validation", () => {
  it("P01 refuses caller-supplied JSON roles, even when middleware is omitted", async () => {
    const auditStore = new InMemoryAuditStore();
    const objectStore = new InMemoryObjectStore();
    let effects = 0;
    const action = defineActionType({
      id: "local_test",
      name: "Local test",
      description: "No remote side effects",
      parametersSchema: Schema.Struct({}),
      riskTier: "high",
      minimumAgentTier: 4,
      defaultExecutionMode: "automated",
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
    const handler = createWorkerFetchHandler({
      objectStore,
      auditStore,
      inbox: new ActionInbox(auditStore, objectStore),
      objectTypes: [],
      actionTypes: [action],
    });
    const response = await handler(
      new Request("https://local.invalid/api/actions/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JSON.stringify({ sub: "untrusted", roles: ["admin"], type: "user" })}`,
        },
        body: JSON.stringify({ actionTypeId: "local_test", parameters: {} }),
      })
    );
    expect([401, 403]).toContain(response.status);
    expect(effects).toBe(0);
  });
});
