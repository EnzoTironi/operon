import type { ActionTypeId, Subject } from "@operon/schema";
import {
  computeEffectDigest,
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

  const defaultProposalParams = { newDose: 20, patientId: "P-100" };
  async function createProposal(
    params = defaultProposalParams,
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

  it("does add proposal, generate tamper-evident evidence hash, and list pending proposals", async () => {
    const { item } = await createProposal();

    expect(item.status).toBe("pending");
    expect(item.evidenceHash).toBeDefined();
    expect(item.evidenceHash).toHaveLength(64); // SHA-256 hex
    expect(item.effectDigest).toBeDefined();
    expect(item.effectDigest).toHaveLength(64);
    expect(item.proposalDigest).toBeDefined();
    expect(item.proposalDigest).toHaveLength(64);
    expect(item.proposerId).toBe(agentProposer.id);
    expect(inbox.getPendingProposals()).toHaveLength(1);
    expect(inbox.getProposal(item.id)).toBeDefined();
  });

  it("does approve proposal successfully with an authorized independent human operator", async () => {
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

  it("does deny approval when an AI agent attempts to approve (Human-in-the-Loop invariant)", async () => {
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

  it("does deny self-approval when proposer attempts to approve own proposal", async () => {
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

  it("does deny approval when human lacks required approver role", async () => {
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

  it("does reject expired proposals when approval is attempted after ttl", async () => {
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
    expect(inbox.getProposal(item.id)?.status).toBe("expired");
    expect(inbox.getPendingProposals()).toHaveLength(0);
  });

  it("does detect evidence hash drift when parameters or expected hash do not match", async () => {
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

  it("does fail approval on non-existent or non-pending proposals", async () => {
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

  it("does reject proposal via human veto and record tamper-evident override record", async () => {
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

  it("does prevent AI agent from exercising veto/override", async () => {
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

  // =========================================================================
  // Gate G1 / Ticket V1-04 Normative Binary Acceptance Test Suite (S07)
  // =========================================================================

  it("does bind exact normalized effect digest in approval receipt and durable record (S07 / V1-04)", async () => {
    // 1. Prepare proposal using prepare() intent
    const proposal = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 35, patientId: "P-100" },
        proposer: agentProposer,
        ttlMs: 3600 * 1000,
      })
    );

    expect(proposal).toBeDefined();
    expect(proposal.status).toBe("pending");
    expect(proposal.effectDigest).toBeDefined();
    expect(proposal.effectDigest).toHaveLength(64);
    expect(proposal.actionRelease).toBe("1.0.0");
    expect(proposal.policyRelease).toBe("1.0.0");

    // Verify expected effectDigest matches computeEffectDigest directly
    const expectedEffectDigest = computeEffectDigest({
      actionId: UpdateDoseAction.id,
      normalizedParameters: { newDose: 35, patientId: "P-100" },
      requestedEffects: [],
    });
    expect(proposal.effectDigest).toBe(expectedEffectDigest);

    // 2. Exact approval with expected effect digest
    const receipt = await Effect.runPromise(
      inbox.approve(proposal.id, proposal.effectDigest, humanDoctor)
    );

    expect(receipt).toBeDefined();
    expect(receipt.decision).toBe("approved");
    expect(receipt.proposalId).toBe(proposal.id);
    expect(receipt.expectedDigest).toBe(proposal.effectDigest);
    expect(receipt.effectDigest).toBe(proposal.effectDigest);
    expect(receipt.proposalDigest).toBe(proposal.proposalDigest);
    expect(receipt.evidenceHash).toBe(proposal.evidenceHash);
    expect(receipt.actionRelease).toBe("1.0.0");
    expect(receipt.policyRelease).toBe("1.0.0");
    expect(receipt.approver.id).toBe(humanDoctor.id);
    expect(receipt.receiptHash).toBeDefined();
    expect(receipt.receiptHash).toHaveLength(64);

    // Verify receipt is queryable
    const queriedReceipt = inbox.getApprovalReceipt(receipt.id);
    expect(queriedReceipt).toBeDefined();
    expect(queriedReceipt?.receiptHash).toBe(receipt.receiptHash);

    const queriedByProposal = inbox.getApprovalReceiptForProposal(proposal.id);
    expect(queriedByProposal).toBeDefined();
    expect(queriedByProposal?.id).toBe(receipt.id);

    // Verify business state changed only after approval
    const patient = await Effect.runPromise(
      objectStore.getObject(PatientType.id, "P-100")
    );
    expect((patient!.properties as any).dose).toBe(35);
  });

  it("does deny approval when expectedDigest does not strictly match proposal effect digest (S07 / V1-04)", async () => {
    const proposal = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 45, patientId: "P-100" },
        proposer: agentProposer,
      })
    );

    const forgedDigest =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const err = await Effect.runPromise(
      Effect.flip(inbox.approve(proposal.id, forgedDigest, humanDoctor))
    );

    expect(err).toBeInstanceOf(ProposalExecutionStateError);
    expect((err as ProposalExecutionStateError).message).toContain(
      "Evidence hash mismatch"
    );
    expect(inbox.getProposal(proposal.id)?.status).toBe("pending");

    // Business state must remain untouched
    const patient = await Effect.runPromise(
      objectStore.getObject(PatientType.id, "P-100")
    );
    expect((patient!.properties as any).dose).toBe(10);
  });

  it("does prevent execution of changed, stale, or expired proposals (S07 / V1-04)", async () => {
    // 1. Expired proposal cannot execute
    const expiredProposal = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 50, patientId: "P-100" },
        proposer: agentProposer,
        ttlMs: -100, // Expired immediately
      })
    );

    const expiredErr = await Effect.runPromise(
      Effect.flip(
        inbox.approve(
          expiredProposal.id,
          expiredProposal.effectDigest,
          humanDoctor
        )
      )
    );
    expect(expiredErr).toBeInstanceOf(ProposalExecutionStateError);
    expect((expiredErr as ProposalExecutionStateError).message).toContain(
      "has expired"
    );

    // 2. Tampered / changed proposal parameters cannot execute
    const validProposal = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 60, patientId: "P-100" },
        proposer: agentProposer,
      })
    );

    // Tamper with parameters directly
    (validProposal.submission.rawParameters as any).newDose = 9999;

    const tamperedErr = await Effect.runPromise(
      Effect.flip(
        inbox.approve(validProposal.id, validProposal.effectDigest, humanDoctor)
      )
    );
    expect(tamperedErr).toBeInstanceOf(ProposalExecutionStateError);
    expect((tamperedErr as ProposalExecutionStateError).message).toContain(
      "Evidence hash mismatch"
    );

    // 3. Rejected proposal cannot be approved or execute
    const rejectedProposal = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 70, patientId: "P-100" },
        proposer: agentProposer,
      })
    );

    await Effect.runPromise(
      inbox.rejectProposal(
        rejectedProposal.id,
        humanDoctor,
        "safety_risk",
        "Vetoed due to severe allergy"
      )
    );

    const rejectApproveErr = await Effect.runPromise(
      Effect.flip(
        inbox.approve(
          rejectedProposal.id,
          rejectedProposal.effectDigest,
          humanDoctor
        )
      )
    );
    expect(rejectApproveErr).toBeInstanceOf(ProposalNotFoundError);

    // 4. Replay attack: approved proposal cannot execute twice
    const replayProposal = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 80, patientId: "P-100" },
        proposer: agentProposer,
      })
    );
    await Effect.runPromise(
      inbox.approve(replayProposal.id, replayProposal.effectDigest, humanDoctor)
    );

    const secondApproveErr = await Effect.runPromise(
      Effect.flip(
        inbox.approve(
          replayProposal.id,
          replayProposal.effectDigest,
          humanDoctor
        )
      )
    );
    expect(secondApproveErr).toBeInstanceOf(ProposalNotFoundError);
  });

  it("does order proposals deterministically and apply filters with deterministic tie-breaking (S07 / V1-04)", () => {
    const baseNow = Date.now();

    // Create 3 proposals with distinct properties
    const p1 = inbox.addProposal(
      {
        actionType: UpdateDoseAction,
        rawParameters: { newDose: 11, patientId: "P-100" },
        security: {
          correlationId: "c1",
          subject: { ...agentProposer, id: "agent-alpha" },
          timestamp: baseNow - 100,
        },
      },
      {
        id: "prop-001",
        outcome: "proposed",
        parameters: { newDose: 11 },
        recordHash: "hash1",
        rulesEvaluated: [],
        security: {
          correlationId: "c1",
          subject: agentProposer,
          timestamp: baseNow - 100,
        },
        timestamp: baseNow - 100,
      } as any,
      100000
    );

    const p2 = inbox.addProposal(
      {
        actionType: UpdateDoseAction,
        rawParameters: { newDose: 12, patientId: "P-100" },
        security: {
          correlationId: "c2",
          subject: { ...agentProposer, id: "agent-beta" },
          timestamp: baseNow - 50,
        },
      },
      {
        id: "prop-002",
        outcome: "proposed",
        parameters: { newDose: 12 },
        recordHash: "hash2",
        rulesEvaluated: [],
        security: {
          correlationId: "c2",
          subject: agentProposer,
          timestamp: baseNow - 50,
        },
        timestamp: baseNow - 50,
      } as any,
      100000
    );

    const p3Expired = inbox.addProposal(
      {
        actionType: UpdateDoseAction,
        rawParameters: { newDose: 13, patientId: "P-100" },
        security: {
          correlationId: "c3",
          subject: { ...agentProposer, id: "agent-alpha" },
          timestamp: baseNow - 200,
        },
      },
      {
        id: "prop-003",
        outcome: "proposed",
        parameters: { newDose: 13 },
        recordHash: "hash3",
        rulesEvaluated: [],
        security: {
          correlationId: "c3",
          subject: agentProposer,
          timestamp: baseNow - 200,
        },
        timestamp: baseNow - 200,
      } as any,
      -50 // already expired
    );

    expect(p1.id).toBe("prop-001");
    expect(p2.id).toBe("prop-002");
    expect(p3Expired.id).toBe("prop-003");

    // 1. Pending listing: strictly excludes expired proposal
    const pending = inbox.getPendingProposals();
    const pendingIds = pending.map((p) => p.id);
    expect(pendingIds).toContain("prop-001");
    expect(pendingIds).toContain("prop-002");
    expect(pendingIds).not.toContain("prop-003");

    // 2. Deterministic sorting by createdAt asc
    const sortedAsc = inbox.listProposals({
      sortBy: "createdAt",
      sortDirection: "asc",
      status: "pending",
    });
    for (let i = 1; i < sortedAsc.length; i++) {
      expect(sortedAsc[i].createdAt).toBeGreaterThanOrEqual(
        sortedAsc[i - 1].createdAt
      );
    }

    // 3. Deterministic tie-breaking: identical timestamps sort by ID ascending
    const pTie1 = inbox.addProposal(
      {
        actionType: UpdateDoseAction,
        rawParameters: { newDose: 14, patientId: "P-100" },
        security: {
          correlationId: "ct1",
          subject: agentProposer,
          timestamp: baseNow,
        },
      },
      {
        id: "prop-zebra",
        outcome: "proposed",
        parameters: {},
        recordHash: "hz",
        rulesEvaluated: [],
        security: {
          correlationId: "ct1",
          subject: agentProposer,
          timestamp: baseNow,
        },
        timestamp: baseNow,
      } as any,
      50000
    );
    const pTie2 = inbox.addProposal(
      {
        actionType: UpdateDoseAction,
        rawParameters: { newDose: 15, patientId: "P-100" },
        security: {
          correlationId: "ct2",
          subject: agentProposer,
          timestamp: baseNow,
        },
      },
      {
        id: "prop-apple",
        outcome: "proposed",
        parameters: {},
        recordHash: "ha",
        rulesEvaluated: [],
        security: {
          correlationId: "ct2",
          subject: agentProposer,
          timestamp: baseNow,
        },
        timestamp: baseNow,
      } as any,
      50000
    );

    // Overwrite createdAt to be strictly equal to test tie-breaking
    (pTie1 as any).createdAt = 5000;
    (pTie2 as any).createdAt = 5000;

    const tiedResults = inbox
      .listProposals({
        sortBy: "createdAt",
        sortDirection: "asc",
        status: "pending",
      })
      .filter((p) => p.id === "prop-zebra" || p.id === "prop-apple");

    expect(tiedResults[0].id).toBe("prop-apple");
    expect(tiedResults[1].id).toBe("prop-zebra");

    // 4. Filtering by proposerId
    const alphaProposals = inbox.listProposals({
      proposerId: "agent-alpha",
      status: "all",
    });
    expect(alphaProposals.every((p) => p.proposerId === "agent-alpha")).toBe(
      true
    );
    expect(alphaProposals.map((p) => p.id)).toContain("prop-001");

    // 5. Pagination with limit and offset
    const page1 = inbox.listProposals({
      limit: 2,
      offset: 0,
      status: "pending",
    });
    const page2 = inbox.listProposals({
      limit: 2,
      offset: 2,
      status: "pending",
    });
    expect(page1).toHaveLength(2);
    expect(page2.length).toBeGreaterThan(0);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it("does preserve proposals and approval receipts across export and import snapshot (S07 / V1-04)", async () => {
    // 1. Prepare and approve one proposal
    const prop1 = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 88, patientId: "P-100" },
        proposer: agentProposer,
      })
    );
    const receipt = await Effect.runPromise(
      inbox.approve(prop1.id, prop1.effectDigest, humanDoctor)
    );

    // 2. Prepare another proposal left pending
    const prop2 = await Effect.runPromise(
      inbox.prepare({
        actionType: UpdateDoseAction,
        parameters: { newDose: 99, patientId: "P-100" },
        proposer: agentProposer,
      })
    );

    // 3. Export snapshot
    const snapshot = inbox.exportSnapshot();
    expect(snapshot.proposals.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.receipts.length).toBeGreaterThanOrEqual(1);

    // 4. Create a completely fresh ActionInbox and import snapshot
    const freshInbox = new ActionInbox(auditStore, objectStore);
    freshInbox.importSnapshot(snapshot);

    // 5. Verify restored state
    const restoredProp1 = freshInbox.getProposal(prop1.id);
    expect(restoredProp1?.status).toBe("approved");

    const restoredReceipt = freshInbox.getApprovalReceipt(receipt.id);
    expect(restoredReceipt).toBeDefined();
    expect(restoredReceipt?.receiptHash).toBe(receipt.receiptHash);

    const restoredProp2 = freshInbox.getProposal(prop2.id);
    expect(restoredProp2?.status).toBe("pending");

    // 6. Complete approval on the restored pending proposal
    const receipt2 = await Effect.runPromise(
      freshInbox.approve(prop2.id, prop2.effectDigest, humanDoctor)
    );
    expect(receipt2.decision).toBe("approved");
    expect(freshInbox.getProposal(prop2.id)?.status).toBe("approved");

    const patient = await Effect.runPromise(
      objectStore.getObject(PatientType.id, "P-100")
    );
    expect((patient!.properties as any).dose).toBe(99);
  });
});
