import type {
  AccessKey,
  EvidenceAcquisitionAction,
  GovernedAgentMemoryRecord,
  MissionTaskMandate,
  ReconstructableExecutionTrace,
} from "@operon/schema";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  GovernedMemoryService,
  GovernedMemoryServiceLive,
} from "./agent-memory.js";
import {
  EvidenceAcquisitionService,
  EvidenceAcquisitionServiceLive,
} from "./evidence-acquisition.js";

function createSampleMandate(
  overrides?: Partial<MissionTaskMandate>
): MissionTaskMandate {
  return {
    deadline: 15_000,
    envelope: {
      allowedActionClasses: ["ACQUIRE_EVIDENCE", "INSPECT_RECORD"],
      budgetLimit: 300,
      expiresAt: 15_000,
      mandateId: "mandate-evidence-v2-04",
      maxRiskBand: "MEDIUM",
      objectSet: ["patient:P*", "lab_result:LR*"],
      principalId: "agent-researcher-01",
      spentBudget: 50,
      tier: "TIER_4_BOUNDED_AUTONOMY",
    },
    issuerId: "human-doctor-lead",
    mandateId: "mandate-evidence-v2-04",
    objective: "Acquire missing lab results and verify dosage safety",
    ownerId: "agent-researcher-01",
    stopConditions: [],
    successPredicates: [],
    ...overrides,
  };
}

const sampleAccessKeyA: AccessKey = {
  createdAt: 1000,
  environmentId: "production",
  expiresAt: 20_000,
  keyId: "key-tenant-alpha-001",
  principalId: "agent-researcher-01",
  scope: "CONSUMER",
  tenantId: "tenant_alpha",
};

const sampleAccessKeyB: AccessKey = {
  createdAt: 1000,
  environmentId: "production",
  expiresAt: 20_000,
  keyId: "key-tenant-beta-001",
  principalId: "agent-researcher-02",
  scope: "CONSUMER",
  tenantId: "tenant_beta",
};

describe("Evidence Acquisition & Governed Memory (S12 / OPR-FULL-022 & OPR-AGT-005)", () => {
  describe("FULL-ACC-022: Active Evidence Acquisition without Fact Fabrication", () => {
    it("does acquire evidence via authorized connector within envelope and budget", async () => {
      const mandate = createSampleMandate();

      const action: EvidenceAcquisitionAction = {
        actionClass: "ACQUIRE_EVIDENCE",
        actionId: "act-acquire-lab-01",
        budgetCost: 30,
        mandateId: mandate.mandateId,
        queryParameters: { panel: "METABOLIC", testId: "egfr" },
        sourceConnectorId: "connector-lab-gateway",
        targetObjectId: "lab_result:LR1001",
      };

      const program = Effect.gen(function* () {
        const service = yield* EvidenceAcquisitionService;

        // Register authorized connector
        yield* service.registerConnector({
          connectorId: "connector-lab-gateway",
          fetchEvidence: (targetId) =>
            Effect.succeed({
              egfr: 55,
              patientId: "patient:P001",
              resultId: targetId,
              status: "FINAL",
            }),
        });

        return yield* service.acquireEvidence(action, mandate, 2000);
      }).pipe(Effect.provide(EvidenceAcquisitionServiceLive));

      const receipt = await Effect.runPromise(program);

      expect(receipt.status).toBe("ACQUIRED");
      expect(receipt.cost).toBe(30);
      expect(receipt.evidencePayload.egfr).toBe(55);
      expect(receipt.candidateHash).toBeDefined();
      expect(receipt.candidateHash.length).toBe(64); // SHA-256
    });

    it("does report source unavailable without fabricating missing facts when source has no data", async () => {
      const mandate = createSampleMandate();

      const action: EvidenceAcquisitionAction = {
        actionClass: "ACQUIRE_EVIDENCE",
        actionId: "act-acquire-missing-lab",
        budgetCost: 20,
        mandateId: mandate.mandateId,
        queryParameters: { testId: "rare_biomarker" },
        sourceConnectorId: "connector-lab-gateway",
        targetObjectId: "lab_result:LR9999",
      };

      const program = Effect.gen(function* () {
        const service = yield* EvidenceAcquisitionService;

        // Connector returns null for missing biomarker
        yield* service.registerConnector({
          connectorId: "connector-lab-gateway",
          fetchEvidence: () => Effect.succeed(null),
        });

        return yield* service.acquireEvidence(action, mandate, 2000);
      }).pipe(Effect.provide(EvidenceAcquisitionServiceLive));

      const receipt = await Effect.runPromise(program);

      // Must strictly be SOURCE_UNAVAILABLE, payload empty, never fabricated
      expect(receipt.status).toBe("SOURCE_UNAVAILABLE");
      expect(receipt.evidencePayload).toEqual({});
      expect(receipt.cost).toBe(20);
    });

    it("does deny evidence acquisition when cost exceeds remaining budget", async () => {
      const mandate = createSampleMandate(); // budgetLimit: 300, spentBudget: 50 -> remaining 250

      const overBudgetAction: EvidenceAcquisitionAction = {
        actionClass: "ACQUIRE_EVIDENCE",
        actionId: "act-expensive-scan",
        budgetCost: 260, // 260 + 50 = 310 > 300
        mandateId: mandate.mandateId,
        queryParameters: {},
        sourceConnectorId: "connector-lab-gateway",
        targetObjectId: "lab_result:LR1001",
      };

      const program = Effect.gen(function* () {
        const service = yield* EvidenceAcquisitionService;
        return yield* Effect.exit(
          service.acquireEvidence(overBudgetAction, mandate)
        );
      }).pipe(Effect.provide(EvidenceAcquisitionServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("EvidenceAcquisitionDeniedError");
        expect(causeStr).toContain("BUDGET_EXCEEDED");
      }
    });

    it("does deny evidence acquisition when target object is outside allowed set", async () => {
      const mandate = createSampleMandate();

      const outOfSetAction: EvidenceAcquisitionAction = {
        actionClass: "ACQUIRE_EVIDENCE",
        actionId: "act-unauthorized-target",
        budgetCost: 10,
        mandateId: mandate.mandateId,
        queryParameters: {},
        sourceConnectorId: "connector-lab-gateway",
        targetObjectId: "financial_record:FR001", // Not in objectSet!
      };

      const program = Effect.gen(function* () {
        const service = yield* EvidenceAcquisitionService;
        return yield* Effect.exit(
          service.acquireEvidence(outOfSetAction, mandate)
        );
      }).pipe(Effect.provide(EvidenceAcquisitionServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("EvidenceAcquisitionDeniedError");
        expect(causeStr).toContain("OBJECT_NOT_ALLOWED");
      }
    });
  });

  describe("AGT-005.T01: Memory Tenant Isolation and Policy Boundaries", () => {
    it("does isolate agent memory strictly between tenants", async () => {
      const memoryRecordA: GovernedAgentMemoryRecord = {
        agentId: "agent-researcher-01",
        content: { note: "Sensitive patient clinical insight in Tenant Alpha" },
        environmentId: "production",
        mandateId: "mandate-evidence-v2-04",
        memoryId: "mem-alpha-001",
        recordedAt: 1000,
        sensitivity: "CONFIDENTIAL",
        tenantId: "tenant_alpha",
      };

      const program = Effect.gen(function* () {
        const memory = yield* GovernedMemoryService;

        // Record in Tenant Alpha
        yield* memory.recordMemory(memoryRecordA, sampleAccessKeyA);

        // Attempt retrieval with Tenant Beta access key
        const crossTenantExit = yield* Effect.exit(
          memory.retrieveMemory("mem-alpha-001", sampleAccessKeyB)
        );

        // Retrieve with correct Tenant Alpha access key
        const validRetrieval = yield* memory.retrieveMemory(
          "mem-alpha-001",
          sampleAccessKeyA
        );

        return { crossTenantExit, validRetrieval };
      }).pipe(Effect.provide(GovernedMemoryServiceLive));

      const { crossTenantExit, validRetrieval } =
        await Effect.runPromise(program);

      // Valid retrieval succeeds in same tenant
      expect(validRetrieval.memoryId).toBe("mem-alpha-001");
      expect(validRetrieval.content.note).toBe(
        "Sensitive patient clinical insight in Tenant Alpha"
      );

      // Cross-tenant access is denied
      expect(Exit.isFailure(crossTenantExit)).toBe(true);
      if (Exit.isFailure(crossTenantExit)) {
        const causeStr = JSON.stringify(crossTenantExit.cause);
        expect(causeStr).toContain("MemoryAccessDeniedError");
        expect(causeStr).toContain("TENANT_MISMATCH");
      }
    });

    it("does prevent cross-tenant queries for memory records", async () => {
      const program = Effect.gen(function* () {
        const memory = yield* GovernedMemoryService;

        // Caller from Tenant Beta attempts to query Tenant Alpha
        return yield* Effect.exit(
          memory.queryTenantMemories("tenant_alpha", sampleAccessKeyB)
        );
      }).pipe(Effect.provide(GovernedMemoryServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("MemoryAccessDeniedError");
        expect(causeStr).toContain("TENANT_MISMATCH");
      }
    });

    it("does reject memory storage containing forged authority keys", async () => {
      const forgedAuthorityMemory: GovernedAgentMemoryRecord = {
        agentId: "agent-researcher-01",
        content: {
          approved: true, // Forged authority flag!
          clinicalObservation: "Patient stable",
        },
        environmentId: "production",
        mandateId: "mandate-evidence-v2-04",
        memoryId: "mem-forged-001",
        recordedAt: 1000,
        sensitivity: "INTERNAL",
        tenantId: "tenant_alpha",
      };

      const program = Effect.gen(function* () {
        const memory = yield* GovernedMemoryService;
        return yield* Effect.exit(
          memory.recordMemory(forgedAuthorityMemory, sampleAccessKeyA)
        );
      }).pipe(Effect.provide(GovernedMemoryServiceLive));

      const exit = await Effect.runPromise(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain("MemoryAccessDeniedError");
        expect(causeStr).toContain("FORBIDDEN_AUTHORITY_INJECTION");
      }
    });

    it("does enforce TTL expiration on sensitive memory records", async () => {
      const expiringMemory: GovernedAgentMemoryRecord = {
        agentId: "agent-researcher-01",
        content: { ephemeralToken: "temp-session-token" },
        environmentId: "production",
        expiresAt: 5000, // Expires at t = 5000
        mandateId: "mandate-evidence-v2-04",
        memoryId: "mem-ephemeral-001",
        recordedAt: 1000,
        sensitivity: "RESTRICTED",
        tenantId: "tenant_alpha",
      };

      const program = Effect.gen(function* () {
        const memory = yield* GovernedMemoryService;

        yield* memory.recordMemory(expiringMemory, sampleAccessKeyA);

        // Retrieve before expiration (t = 4000)
        const active = yield* memory.retrieveMemory(
          "mem-ephemeral-001",
          sampleAccessKeyA,
          4000
        );

        // Retrieve after expiration (t = 6000)
        const expiredExit = yield* Effect.exit(
          memory.retrieveMemory("mem-ephemeral-001", sampleAccessKeyA, 6000)
        );

        return { active, expiredExit };
      }).pipe(Effect.provide(GovernedMemoryServiceLive));

      const { active, expiredExit } = await Effect.runPromise(program);

      expect(active.memoryId).toBe("mem-ephemeral-001");
      expect(Exit.isFailure(expiredExit)).toBe(true);
      if (Exit.isFailure(expiredExit)) {
        const causeStr = JSON.stringify(expiredExit.cause);
        expect(causeStr).toContain("MemoryAccessDeniedError");
        expect(causeStr).toContain("EXPIRED");
      }
    });
  });

  describe("AGT-005.T02: Reconstructable Observable Task Traces", () => {
    it("does record and reconstruct observable operation trace with complete tool calls and dispositions", async () => {
      const trace: ReconstructableExecutionTrace = {
        actionReceipts: ["rcpt-adjust-001", "rcpt-acquire-002"],
        candidateDigest: "sha256_cand_v2_04_trace_summary",
        executedAt: 10_000,
        mandateId: "mandate-evidence-v2-04",
        modelVersion: "gpt-4o-2024-11-20",
        rationale:
          "Target eGFR indicates moderate renal impairment; reduced dosage by 20% according to guideline.",
        stepDispositions: [
          { disposition: "EXECUTED_CONFIRMED", stepId: "step-1-fetch-egfr" },
          { disposition: "EXECUTED_CONFIRMED", stepId: "step-2-recalculate" },
        ],
        toolCalls: [
          {
            parameters: { patientId: "P001" },
            resultDigest: "digest_result_tool_1",
            toolName: "lab_query",
          },
          {
            parameters: { currentDose: 20, egfr: 52 },
            resultDigest: "digest_result_tool_2",
            toolName: "dose_calculator",
          },
        ],
        traceId: "trace-task-multistep-001",
      };

      const program = Effect.gen(function* () {
        const memory = yield* GovernedMemoryService;

        yield* memory.recordExecutionTrace(trace);
        const reconstructed = yield* memory.reconstructExecutionTrace(
          "trace-task-multistep-001"
        );

        return reconstructed;
      }).pipe(Effect.provide(GovernedMemoryServiceLive));

      const reconstructed = await Effect.runPromise(program);

      expect(reconstructed).not.toBeNull();
      if (reconstructed) {
        expect(reconstructed.traceId).toBe("trace-task-multistep-001");
        expect(reconstructed.modelVersion).toBe("gpt-4o-2024-11-20");
        expect(reconstructed.toolCalls).toHaveLength(2);
        expect(reconstructed.toolCalls[0].toolName).toBe("lab_query");
        expect(reconstructed.stepDispositions).toHaveLength(2);
        expect(reconstructed.actionReceipts).toEqual([
          "rcpt-adjust-001",
          "rcpt-acquire-002",
        ]);
        expect(reconstructed.rationale).toContain("reduced dosage by 20%");
      }
    });
  });
});
