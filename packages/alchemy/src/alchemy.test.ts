import { createHmac } from "node:crypto";

import {
  ActionInbox,
  HttpAuthMiddleware,
  InMemoryAuditStore,
  InMemoryObjectStore,
  OidcTokenVerifier,
} from "@operon/runtime";
import {
  defineActionType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  createWorkerFetchHandler,
  synthesizeAlchemyManifest,
} from "./index.js";

describe("@operon/alchemy", () => {
  it("synthesizes the Cloudflare Alchemy infrastructure manifest", () => {
    const manifest = synthesizeAlchemyManifest();
    expect(manifest.name).toBe("operon-stack");
    expect(manifest.provider).toBe("cloudflare");
    expect(manifest.resources.d1.type).toBe("cloudflare:d1_database");
    expect(manifest.resources.r2.type).toBe("cloudflare:r2_bucket");
    expect(manifest.resources.queue.type).toBe("cloudflare:queue");
    expect(manifest.resources.worker.type).toBe("cloudflare:worker");
  });

  it("handles HTTP requests through the worker gateway", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const inbox = new ActionInbox(auditStore, objectStore);

    const TankType = defineObjectType({
      description: "Biological treatment tank",
      id: "AerationTank",
      name: "AerationTank",
      primaryKey: "tankId",
      properties: {
        dissolvedOxygen: defineProperty({
          schema: Schema.Number,
          description: "DO mg/L",
          freshnessBudget: { maxStalenessMs: 300000, onStale: "warn" },
        }),
        tankId: defineProperty({
          schema: Schema.String,
          description: "ID",
          required: true,
        }),
      },
      typology: "master",
    });

    await Effect.runPromise(
      objectStore.putObject({
        id: "tank-1",
        lastModifiedAt: Date.now(),
        properties: { dissolvedOxygen: 2.1, tankId: "tank-1" },
        typeId: TankType.id,
        version: 1,
      })
    );

    const ChangeSetpointAction = defineActionType({
      defaultExecutionMode: "proposal",
      description: "Change dissolved oxygen setpoint",
      id: "change_setpoint",
      minimumAgentTier: 2,
      name: "Change DO Setpoint",
      parametersSchema: Schema.Struct({
        tankId: Schema.String,
        newSetpoint: Schema.Number,
      }),
      riskTier: "medium",
    });

    const secret = "test-secret-key-that-is-at-least-32-chars!";
    const verifier = new OidcTokenVerifier({
      allowedAlgorithms: ["HS256"],
      secretOrPublicKey: secret,
    });
    const authMiddleware = new HttpAuthMiddleware(verifier);

    const signToken = (claims: Record<string, unknown>) => {
      const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" })
      ).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = createHmac("sha256", secret)
        .update(`${header}.${payload}`)
        .digest("base64url");
      return `Bearer ${header}.${payload}.${sig}`;
    };

    const handler = createWorkerFetchHandler({
      actionTypes: [ChangeSetpointAction],
      auditStore,
      authMiddleware,
      inbox,
      objectStore,
      objectTypes: [TankType],
    });

    // 1. Health check
    const healthRes = await handler(
      new Request("https://operon.internal/health")
    );
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as any;
    expect(healthBody.status).toBe("ok");

    // 2. 4C Readiness Check
    const readinessRes = await handler(
      new Request("https://operon.internal/api/readiness/AerationTank/tank-1")
    );
    expect(readinessRes.status).toBe(200);
    const readinessBody = (await readinessRes.json()) as any;
    expect(readinessBody.isReady).toBe(true);

    const agentToken = signToken({
      agentTier: 2,
      name: "OptimizationAgent",
      roles: [],
      sub: "agent-opt",
      type: "agent",
    });

    const operatorToken = signToken({
      name: "Lead Operator",
      roles: ["operator"],
      sub: "lead-operator",
      type: "user",
    });

    const engineerToken = signToken({
      name: "Engineer Wang",
      roles: ["chief_engineer"],
      sub: "engineer-wang",
      type: "user",
    });

    // 3. Unauthenticated request to submit action fails with 401
    const unauthRes = await handler(
      new Request("https://operon.internal/api/actions/submit", {
        body: JSON.stringify({
          actionTypeId: "change_setpoint",
          parameters: { newSetpoint: 2.5, tankId: "tank-1" },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    expect(unauthRes.status).toBe(401);

    // 4. Submit Action Proposal with verified Bearer token (Tier 2 Agent)
    // Attempting to spoof admin in body is IGNORED by server
    const submitRes = await handler(
      new Request("https://operon.internal/api/actions/submit", {
        body: JSON.stringify({
          actionTypeId: "change_setpoint",
          parameters: { newSetpoint: 2.5, tankId: "tank-1" },
          subject: {
            id: "fake-admin",
            roles: ["admin"],
            type: "user",
          },
        }),
        headers: {
          Authorization: agentToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );

    expect(submitRes.status).toBe(200);
    const submitBody = (await submitRes.json()) as any;
    expect(submitBody.status).toBe("proposed");
    expect(submitBody.decisionRecord.subject.id).toBe("agent-opt");
    const { proposalId } = submitBody;

    // 5. Verify in Action Inbox
    const inboxRes = await handler(
      new Request("https://operon.internal/api/inbox/pending", {
        headers: { Authorization: operatorToken },
      })
    );
    const inboxBody = (await inboxRes.json()) as any;
    expect(inboxBody.count).toBe(1);

    // 6. Human Veto / Override
    const vetoRes = await handler(
      new Request(`https://operon.internal/api/inbox/${proposalId}/reject`, {
        body: JSON.stringify({
          category: "operational_override",
          reason: "Storm inflow approaching, maintain higher baseline DO",
        }),
        headers: {
          Authorization: engineerToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );

    expect(vetoRes.status).toBe(200);
    const vetoBody = (await vetoRes.json()) as any;
    expect(vetoBody.status).toBe("VETOED");
    expect(vetoBody.overrideRecord.reasonCategory).toBe("operational_override");

    // 7. Root path healthcheck
    const rootRes = await handler(new Request("https://operon.internal/"));
    expect(rootRes.status).toBe(200);

    // 8. Unknown ObjectType in Readiness
    const unkTypeRes = await handler(
      new Request("https://operon.internal/api/readiness/UnknownType/tank-1")
    );
    expect(unkTypeRes.status).toBe(404);
    const unkTypeBody = (await unkTypeRes.json()) as any;
    expect(unkTypeBody.error).toContain(
      "ObjectType 'UnknownType' not registered"
    );

    // 9. Missing Object in Readiness
    const missingObjRes = await handler(
      new Request(
        "https://operon.internal/api/readiness/AerationTank/missing-tank-999"
      )
    );
    expect(missingObjRes.status).toBe(404);
    const missingObjBody = (await missingObjRes.json()) as any;
    expect(missingObjBody.error).toContain(
      "Object 'missing-tank-999' not found"
    );

    // 10. Unknown ActionType in Submit
    const unkActRes = await handler(
      new Request("https://operon.internal/api/actions/submit", {
        body: JSON.stringify({
          actionTypeId: "non_existent_action",
          parameters: {},
        }),
        headers: {
          Authorization: agentToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );
    expect(unkActRes.status).toBe(404);

    // 11. Invalid Action Parameters (Validation Error 400)
    const badParamsRes = await handler(
      new Request("https://operon.internal/api/actions/submit", {
        body: JSON.stringify({
          actionTypeId: "change_setpoint",
          parameters: { newSetpoint: "not-a-number", tankId: "tank-1" },
        }),
        headers: {
          Authorization: agentToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );
    expect(badParamsRes.status).toBe(400);
    const badParamsBody = (await badParamsRes.json()) as any;
    expect(badParamsBody.error).toContain("ParameterValidationError");

    // 12. Approve Proposal Workflow: Create new proposal, then approve it
    const prop2Res = await handler(
      new Request("https://operon.internal/api/actions/submit", {
        body: JSON.stringify({
          actionTypeId: "change_setpoint",
          parameters: { newSetpoint: 3, tankId: "tank-1" },
        }),
        headers: {
          Authorization: agentToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );
    expect(prop2Res.status).toBe(200);
    const prop2Body = (await prop2Res.json()) as any;
    const prop2Id = prop2Body.proposalId;

    const approveRes = await handler(
      new Request(`https://operon.internal/api/inbox/${prop2Id}/approve`, {
        body: JSON.stringify({}),
        headers: {
          Authorization: operatorToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as any;
    expect(approveBody.status).toBe("APPROVED");

    // 13. Approve non-existent proposal fails with 400
    const badApproveRes = await handler(
      new Request("https://operon.internal/api/inbox/non-existent-p/approve", {
        body: JSON.stringify({}),
        headers: {
          Authorization: operatorToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );
    expect(badApproveRes.status).toBe(400);

    // 14. Reject non-existent proposal fails with 400
    const badRejectRes = await handler(
      new Request("https://operon.internal/api/inbox/non-existent-p/reject", {
        body: JSON.stringify({}),
        headers: {
          Authorization: operatorToken,
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    );
    expect(badRejectRes.status).toBe(400);

    // 14. Unknown Route returns 404
    const notFoundRes = await handler(
      new Request("https://operon.internal/api/unmapped/resource")
    );
    expect(notFoundRes.status).toBe(404);
  });
});
