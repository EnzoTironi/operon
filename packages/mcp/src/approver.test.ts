import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CellAuth, CellSessionVerifier } from "@operon/cell-auth";
import {
  InMemoryAuditStore,
  InMemoryObjectStore,
  OntologyMetadataService,
  SessionVerifier,
} from "@operon/runtime";
import type { ObjectTypeId } from "@operon/schema";
import { defineActionType, parseJson } from "@operon/schema";
import { Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { ApproverBinding } from "./approver.js";
import { unboundApprover } from "./approver.js";
import { createOperonMcpServer } from "./server.js";

const Patient = "Patient" as ObjectTypeId;

const updateVitals = defineActionType({
  defaultExecutionMode: "proposal",
  description: "Update vitals",
  id: "update_vitals",
  minimumAgentTier: 2,
  mutation: (params, ctx) =>
    Effect.map(ctx.getObject(Patient, params.patientId), (patient) =>
      patient
        ? [
            {
              ...patient,
              lastModifiedAt: ctx.now,
              properties: { ...patient.properties, heartRate: params.heartRate },
              version: patient.version + 1,
            },
          ]
        : []
    ),
  name: "Update Vitals",
  parametersSchema: Schema.Struct({
    heartRate: Schema.Number,
    patientId: Schema.String,
  }),
  riskTier: "high",
  targetObjectTypeId: "Patient",
});

const cellAuthLayer = Layer.provideMerge(
  CellSessionVerifier,
  CellAuth.layer({
    secret: Redacted.make("approver-test-secret-with-32-chars!!"),
    store: { kind: "memory" },
  })
);

interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly text: string }[];
}

interface Harness {
  readonly call: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
  readonly objectStore: InMemoryObjectStore;
  readonly prepare: () => Promise<string>;
}

async function connect(approver: ApproverBinding): Promise<Harness> {
  const objectStore = new InMemoryObjectStore();
  await Effect.runPromise(
    objectStore.putObject({
      id: "PAT-1",
      lastModifiedAt: Date.now(),
      properties: { heartRate: 70 },
      typeId: Patient,
      version: 1,
    })
  );
  const server = createOperonMcpServer({
    actionTypes: [updateVitals],
    approver,
    auditStore: new InMemoryAuditStore(),
    objectStore,
    objectTypes: [],
    oms: new OntologyMetadataService(),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "approver-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) =>
    // SAFETY: MCP tool results carry text content blocks
    (await client.callTool({ arguments: args, name })) as ToolResult;

  const prepare = async () => {
    const prepared = await call("operon_prepare_action", {
      actionId: "update_vitals",
      parameters: { heartRate: 88, patientId: "PAT-1" },
      proposerId: "agent-doc",
      proposerTier: 3,
      proposerType: "agent",
    });
    expect(prepared.isError).toBeFalsy();
    const body = parseJson(prepared.content[0]?.text ?? "{}") as {
      readonly canonicalDigest: string;
    };
    return body.canonicalDigest;
  };

  return { call, objectStore, prepare };
}

function errorTag(result: ToolResult): string {
  const body = parseJson(result.content[0]?.text ?? "{}") as {
    readonly error?: string;
  };
  return body.error ?? "";
}

describe("MCP approver binding", () => {
  it("refuses to approve when no human session is bound", async () => {
    const harness = await connect(unboundApprover);
    const digest = await harness.prepare();
    const result = await harness.call("operon_approve_prepared_action", {
      decision: "approved",
      preparedDigest: digest,
      reviewerId: "human-physician",
      viewedDigest: digest,
    });
    expect(result.isError).toBe(true);
    expect(errorTag(result)).toBe("ApproverNotBoundError");
    const patient = await Effect.runPromise(
      harness.objectStore.getObject(Patient, "PAT-1")
    );
    expect(patient?.version).toBe(1);
  });

  it("records the bound human as reviewer and ignores relayed reviewer arguments", async () => {
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        const verifier = yield* SessionVerifier;
        const session = yield* auth.issueApproverSession({
          email: "ana@clinica.example",
          name: "Ana",
        });
        return { session, verifier };
      }).pipe(Effect.provide(cellAuthLayer), Effect.scoped)
    );
    const harness = await connect({
      _tag: "Session",
      token: issued.session.token,
      verifier: issued.verifier,
    });
    const digest = await harness.prepare();
    const result = await harness.call("operon_approve_prepared_action", {
      decision: "approved",
      preparedDigest: digest,
      reviewerId: "someone-else",
      reviewerRoles: ["admin"],
      viewedDigest: digest,
    });
    expect(result.isError).toBeFalsy();
    const approval = parseJson(result.content[0]?.text ?? "{}") as {
      readonly reviewerContext: {
        readonly assurance: string;
        readonly reviewer: {
          readonly id: string;
          readonly name: string;
          readonly roles: readonly string[];
          readonly type: string;
          readonly metadata: { readonly issuer: string; readonly email: string };
        };
      };
    };
    expect(approval.reviewerContext.reviewer.id).toBe(issued.session.userId);
    expect(approval.reviewerContext.reviewer.name).toBe("Ana");
    expect(approval.reviewerContext.reviewer.type).toBe("user");
    expect(approval.reviewerContext.reviewer.roles).toEqual(["approver"]);
    expect(approval.reviewerContext.reviewer.metadata.issuer).toBe(
      "operon-cell"
    );
    expect(approval.reviewerContext.reviewer.metadata.email).toBe(
      "ana@clinica.example"
    );
    expect(approval.reviewerContext.assurance).toBe("human_verified");
  });

  it("stops approving as soon as the bound session is revoked", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* CellAuth;
        const verifier = yield* SessionVerifier;
        const session = yield* auth.issueApproverSession({
          email: "bia@clinica.example",
          name: "Bia",
        });
        const harness = yield* Effect.promise(() =>
          connect({ _tag: "Session", token: session.token, verifier })
        );
        const digest = yield* Effect.promise(() => harness.prepare());
        yield* auth.revokeSession(session.token);
        return yield* Effect.promise(() =>
          harness.call("operon_approve_prepared_action", {
            decision: "approved",
            preparedDigest: digest,
            viewedDigest: digest,
          })
        );
      }).pipe(Effect.provide(cellAuthLayer), Effect.scoped)
    );
    expect(outcome.isError).toBe(true);
    expect(errorTag(outcome)).toBe("AuthenticationError");
  });
});
