import type { ActionTypeId, Subject } from "@operon/schema";
import {
  defineActionType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryAuditStore } from "./audit.js";
import {
  AuthorizationError,
  ProposalExecutionStateError,
  ProposalNotFoundError,
} from "./errors.js";
import { ActionInbox } from "./inbox.js";
import { InMemoryObjectStore } from "./object-store.js";
import type { ActionSubmission } from "./write-pipeline.js";
import { executeWritePipeline } from "./write-pipeline.js";

describe("ActionInbox Domain & Security Invariants (inbox.ts)", () => {
  let objectStore: InMemoryObjectStore;
  let auditStore: InMemoryAuditStore;
  let inbox: ActionInbox;

  const agentProposer: Subject = {
    agentTier: 2,
    id: "clinical-agent-01",
    name: "Clinical AI Agent",
    roles: ["analyst"],
    type: "agent",
  };

  const humanDoctor: Subject = {
    id: "dr-house",
    name: "Dr. Gregory House",
    roles: ["physician"],
    type: "user",
  };

  const unauthorizedHuman: Subject = {
    id: "visitor-bob",
    name: "Bob the Visitor",
    roles: ["guest"],
    type: "user",
  };

  const agentApprover: Subject = {
    agentTier: 3,
    id: "autonomous-supervisor",
    name: "Autonomous Supervisor",
    roles: ["admin"],
    type: "agent",
  };

  const PatientType = defineObjectType({
    description: "Patient",
    id: "Patient",
    name: "Patient",
    primaryKey: "id",
    properties: {
      dose: defineProperty({ description: "Dose mg", schema: Schema.Number }),
      id: defineProperty({ description: "ID", schema: Schema.String }),
    },
    typology: "master",
  });

  const UpdateDoseAction = defineActionType({
    defaultExecutionMode: "proposal",
    description: "Update patient dose",
    id: "update_dose" as ActionTypeId,
    minimumAgentTier: 2,
    mutation: (params, ctx) =>
      ctx.getObject(PatientType.id, params.patientId).pipe(
        Effect.map((patient) => [
          {
            ...patient!,
            properties: {
              ...patient!.properties,
              dose: params.newDose,
            },
            version: patient!.version + 1,
          },
        ])
      ),
    name: "Update Dose",
    parametersSchema: Schema.Struct({
      newDose: Schema.Number,
      patientId: Schema.String,
    }),
    riskTier: "high",
    targetObjectTypeId: PatientType.id,
  });

  beforeEach(async () => {
    objectStore = new InMemoryObjectStore();
    auditStore = new InMemoryAuditStore();
    inbox = new ActionInbox(auditStore, objectStore);

    await Effect.runPromise(
      objectStore.putObject({
        id: "P-100",
        lastModifiedAt: 1000,
        properties: { dose: 10, id: "P-100" },
        typeId: PatientType.id,
        version: 1,
      })
    );
  });

  async function createProposal(
    params = { newDose: 20, patientId: "P-100" },
    ttlMs?: number
  ) {
    const submission: ActionSubmission = {
      actionType: UpdateDoseAction,
      rawParameters: params,
      security: {
        correlationId: "corr-inbox-test",
        subject: agentProposer,
        timestamp: Date.now(),
      },
    };

    const res = await Effect.runPromise(
      executeWritePipeline(submission, objectStore, auditStore)
    );
    expect(res.status).toBe("proposed");
    const item = inbox.addProposal(submission, res.decisionRecord, ttlMs);
    return { item, res, submission };
  }

  it("adds proposal, generates tamper-evident evidence hash, and lists pending proposals", async () => {
    const { item } = await createProposal();

    expect(item.status).toBe("pending");
    expect(item.evidenceHash).toBeDefined();
    expect(item.evidenceHash).toHaveLength(64); // SHA-256 hex
    expect(item.proposerId).toBe(agentProposer.id);
    expect(inbox.getPendingProposals()).toHaveLength(1);
    expect(inbox.getProposal(item.id)).toBeDefined();
  });

  it("approves proposal successfully with an authorized independent human operator", async () => {
    const { item } = await createProposal();

    const decisionRecord = await Effect.runPromise(
      inbox.approveProposal(item.id, humanDoctor, item.evidenceHash)
    );

    expect(decisionRecord).toBeDefined();
    expect(decisionRecord.outcome).toBe("executed");

    const updatedProposal = inbox.getProposal(item.id);
    expect(updatedProposal?.status).toBe("approved");
    expect(inbox.getPendingProposals()).toHaveLength(0);

    // Verify object store updated
    const patient = await Effect.runPromise(
      objectStore.getObject(PatientType.id, "P-100")
    );
    expect(patient).toBeDefined();
    expect((patient!.properties as any).dose).toBe(20);
    expect(patient!.version).toBe(2);
  });

  it("denies approval when an AI agent attempts to approve (Human-in-the-Loop invariant)", async () => {
    const { item } = await createProposal();

    const err = await Effect.runPromise(
      Effect.flip(inbox.approveProposal(item.id, agentApprover))
    );

    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).reason).toContain(
      "requires an authenticated human operator"
    );
    expect(inbox.getProposal(item.id)?.status).toBe("pending");
  });

  it("denies self-approval when proposer attempts to approve own proposal", async () => {
    await createProposal();

    // Human proposer attempting to approve own proposal
    const humanProposer: Subject = {
      id: "dr-house",
      name: "Dr. Gregory House",
      roles: ["physician"],
      type: "user",
    };

    const selfSubmission: ActionSubmission = {
      actionType: UpdateDoseAction,
      rawParameters: { newDose: 25, patientId: "P-100" },
      security: {
        correlationId: "corr-self",
        subject: humanProposer,
        timestamp: Date.now(),
      },
    };

    const res = await Effect.runPromise(
      executeWritePipeline(selfSubmission, objectStore, auditStore)
    );
    const selfProposal = inbox.addProposal(selfSubmission, res.decisionRecord);

    const err = await Effect.runPromise(
      Effect.flip(inbox.approveProposal(selfProposal.id, humanProposer))
    );

    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).reason).toContain("cannot self-approve");
    expect(inbox.getProposal(selfProposal.id)?.status).toBe("pending");
  });

  it("denies approval when human lacks required approver role", async () => {
    const { item } = await createProposal();

    const err = await Effect.runPromise(
      Effect.flip(inbox.approveProposal(item.id, unauthorizedHuman))
    );

    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).reason).toContain(
      "lacks required approval capability"
    );
    expect(inbox.getProposal(item.id)?.status).toBe("pending");
  });

  it("rejects expired proposals when approval is attempted after ttl", async () => {
    // 1 ms TTL that expires immediately
    const { item } = await createProposal(
      { newDose: 30, patientId: "P-100" },
      -1000
    );

    const err = await Effect.runPromise(
      Effect.flip(inbox.approveProposal(item.id, humanDoctor))
    );

    expect(err).toBeInstanceOf(ProposalExecutionStateError);
    expect((err as ProposalExecutionStateError).message).toContain(
      "has expired"
    );
    expect(inbox.getProposal(item.id)?.status).toBe("rejected");
    expect(inbox.getPendingProposals()).toHaveLength(0);
  });

  it("detects evidence hash drift when parameters or expected hash do not match", async () => {
    const { item, submission } = await createProposal();

    // 1. Wrong expected hash
    const errExpected = await Effect.runPromise(
      Effect.flip(
        inbox.approveProposal(
          item.id,
          humanDoctor,
          "0000000000000000000000000000000000000000000000000000000000000000"
        )
      )
    );
    expect(errExpected).toBeInstanceOf(ProposalExecutionStateError);
    expect((errExpected as ProposalExecutionStateError).message).toContain(
      "Evidence hash mismatch"
    );

    // 2. Tampered parameters in submission
    (submission.rawParameters as any).newDose = 999;
    const errTampered = await Effect.runPromise(
      Effect.flip(inbox.approveProposal(item.id, humanDoctor))
    );
    expect(errTampered).toBeInstanceOf(ProposalExecutionStateError);
    expect((errTampered as ProposalExecutionStateError).message).toContain(
      "Evidence hash mismatch"
    );
  });

  it("fails approval on non-existent or non-pending proposals", async () => {
    const errNonExistent = await Effect.runPromise(
      Effect.flip(inbox.approveProposal("unknown-proposal-id", humanDoctor))
    );
    expect(errNonExistent).toBeInstanceOf(ProposalNotFoundError);

    // After approval, cannot approve again
    const { item } = await createProposal();
    await Effect.runPromise(inbox.approveProposal(item.id, humanDoctor));

    const errAlreadyApproved = await Effect.runPromise(
      Effect.flip(inbox.approveProposal(item.id, humanDoctor))
    );
    expect(errAlreadyApproved).toBeInstanceOf(ProposalNotFoundError);
  });

  it("rejects proposal via human veto and records tamper-evident override record", async () => {
    const { item } = await createProposal({ newDose: 40, patientId: "P-100" });

    const override = await Effect.runPromise(
      inbox.rejectProposal(
        item.id,
        humanDoctor,
        "clinical_discretion",
        "Patient exhibits acute renal insufficiency; dose increase contraindicated"
      )
    );

    expect(override).toBeDefined();
    expect(override.decisionRecordId).toBe(item.decisionRecord.id);
    expect(override.reasonCategory).toBe("clinical_discretion");
    expect(override.structuredReason).toContain("contraindicated");
    expect(override.finalDecision).toEqual({
      action: "veto",
      status: "rejected",
    });
    expect(override.humanSubject.id).toBe(humanDoctor.id);

    // Proposal is rejected in inbox
    expect(inbox.getProposal(item.id)?.status).toBe("rejected");
    expect(inbox.getPendingProposals()).toHaveLength(0);

    // Verify stored in audit store
    const storedOverrides = (auditStore as any).overrides;
    expect(storedOverrides).toHaveLength(1);
    expect(storedOverrides[0].id).toBe(override.id);

    // Re-rejecting fails
    const errReReject = await Effect.runPromise(
      Effect.flip(
        inbox.rejectProposal(
          item.id,
          humanDoctor,
          "regulatory_compliance",
          "duplicate"
        )
      )
    );
    expect(errReReject).toBeInstanceOf(ProposalNotFoundError);
  });

  it("prevents AI agent from exercising veto/override", async () => {
    const { item } = await createProposal();

    const err = await Effect.runPromise(
      Effect.flip(
        inbox.rejectProposal(
          item.id,
          agentApprover,
          "safety_risk",
          "Agent veto"
        )
      )
    );

    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).reason).toContain(
      "requires a human operator"
    );
    expect(inbox.getProposal(item.id)?.status).toBe("pending");
  });
});
