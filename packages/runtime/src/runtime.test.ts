import type { ObjectInstance } from "@operon/schema";
import {
  defineActionType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ActionInbox,
  evaluateDecisionReadiness,
  executeWritePipeline,
  InMemoryAuditStore,
  InMemoryObjectStore,
  ParameterValidationError,
  PermissionDeniedError,
  SubmissionCriteriaFailedError,
} from "./index.js";

describe("@operon/runtime", () => {
  const PatientType = defineObjectType({
    description: "Inpatient record",
    id: "Patient",
    name: "Patient",
    primaryKey: "patientId",
    properties: {
      eGFR: defineProperty({
        schema: Schema.Number.pipe(
          Schema.check(Schema.isBetween({ maximum: 150, minimum: 0 }))
        ),
        description: "Renal eGFR",
        required: true,
        freshnessBudget: {
          maxStalenessMs: 24 * 60 * 60 * 1000, // 24 hours
          onStale: "escalate_to_human",
        },
      }),
      mealIntakePercent: defineProperty({
        schema: Schema.Number.pipe(
          Schema.check(Schema.isBetween({ maximum: 100, minimum: 0 }))
        ),
        description: "Daily food intake percentage",
        required: true,
        freshnessBudget: {
          maxStalenessMs: 12 * 60 * 60 * 1000, // 12 hours
          onStale: "reject",
        },
      }),
      patientId: defineProperty({
        schema: Schema.String,
        description: "Patient ID",
        required: true,
      }),
    },
    typology: "master",
  });

  it("should evaluate 4C Decision Readiness accurately", () => {
    const now = Date.now();

    // 1. Ready instance
    const readyPatient: ObjectInstance = {
      id: "P001",
      lastModifiedAt: now - 1000,
      properties: {
        eGFR: 52,
        mealIntakePercent: 80,
        patientId: "P001",
      },
      typeId: PatientType.id,
      version: 1,
    };

    const readyCheck = evaluateDecisionReadiness(
      readyPatient,
      PatientType,
      now
    );
    expect(readyCheck.isReady).toBe(true);
    expect(readyCheck.correct.passed).toBe(true);
    expect(readyCheck.complete.passed).toBe(true);
    expect(readyCheck.current.passed).toBe(true);

    // 2. Completeness failure: missing mealIntakePercent (the anchoring case!)
    const missingMealPatient: ObjectInstance = {
      id: "P002",
      lastModifiedAt: now - 1000,
      properties: {
        eGFR: 52,
        patientId: "P002",
      },
      typeId: PatientType.id,
      version: 1,
    };

    const completenessCheck = evaluateDecisionReadiness(
      missingMealPatient,
      PatientType,
      now
    );
    expect(completenessCheck.isReady).toBe(false);
    expect(completenessCheck.complete.passed).toBe(false);
    expect(completenessCheck.complete.missingProperties).toContain(
      "mealIntakePercent"
    );

    // 3. Currency failure: stale reading
    const stalePatient: ObjectInstance = {
      id: "P003",
      lastModifiedAt: now - 20 * 60 * 60 * 1000,
      properties: {
        eGFR: 52,
        mealIntakePercent: 50,
        patientId: "P003",
      },
      provenance: {
        ingestedAt: now - 20 * 60 * 60 * 1000,
        recordedAt: now - 20 * 60 * 60 * 1000, // 20 hours old (max allowed is 12 hours)
        sourceSystem: "EMR",
      },
      typeId: PatientType.id,
      version: 1,
    };

    const currencyCheck = evaluateDecisionReadiness(
      stalePatient,
      PatientType,
      now
    );
    expect(currencyCheck.isReady).toBe(false);
    expect(currencyCheck.current.passed).toBe(false);
    expect(currencyCheck.current.staleProperties.length).toBeGreaterThan(0);
  });

  it("should execute the 7-step write pipeline and enforce agent tiers", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();

    const AdjustDoseAction = defineActionType({
      defaultExecutionMode: "manual",
      description: "Adjust insulin dosage",
      id: "adjust_dose",
      minimumAgentTier: 3, // Requires Tier 3 (Execute with Approval) or Tier 4
      name: "Adjust Dose",
      parametersSchema: Schema.Struct({
        patientId: Schema.String,
        doseUnits: Schema.Number.pipe(
          Schema.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
        ),
      }),
      riskTier: "high",
      submissionCriteria: [
        {
          id: "dose_safe_limit",
          description: "Dose must be <= 50U",
          evaluate: (p) =>
            Effect.succeed({
              passed: p.doseUnits <= 50,
              verdict: p.doseUnits <= 50 ? "allow" : "deny",
              failureReason:
                p.doseUnits > 50 ? "Dose exceeds safe threshold" : undefined,
            }),
        },
      ],
    });

    // 1. Parameter validation failure
    const invalidParamResult = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: AdjustDoseAction,
          rawParameters: { doseUnits: -5, patientId: "P1" }, // Invalid negative dose
          security: {
            correlationId: "corr-1",
            subject: {
              id: "user1",
              name: "Dr Smith",
              roles: ["physician"],
              type: "user",
            },
            timestamp: Date.now(),
          },
        },
        objectStore,
        auditStore
      ).pipe(Effect.flip)
    );
    expect(invalidParamResult).toBeInstanceOf(ParameterValidationError);

    // 2. Permission tier failure: Tier 1 agent attempting Tier 3 action
    const permissionDeniedResult = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: AdjustDoseAction,
          rawParameters: { doseUnits: 14, patientId: "P1" },
          security: {
            correlationId: "corr-2",
            subject: {
              agentTier: 1,
              id: "agent1",
              name: "ChatAgent",
              roles: [],
              type: "agent",
            },
            timestamp: Date.now(),
          },
        },
        objectStore,
        auditStore
      ).pipe(Effect.flip)
    );
    expect(permissionDeniedResult).toBeInstanceOf(PermissionDeniedError);

    // 3. Submission criterion failure
    const criterionFailResult = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: AdjustDoseAction,
          rawParameters: { doseUnits: 55, patientId: "P1" }, // > 50 safe limit
          security: {
            correlationId: "corr-3",
            subject: {
              id: "user1",
              name: "Dr Smith",
              roles: ["physician"],
              type: "user",
            },
            timestamp: Date.now(),
          },
        },
        objectStore,
        auditStore
      ).pipe(Effect.flip)
    );
    expect(criterionFailResult).toBeInstanceOf(SubmissionCriteriaFailedError);

    // 4. Successful execution by physician
    const successResult = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: AdjustDoseAction,
          rawParameters: { doseUnits: 12, patientId: "P1" },
          security: {
            correlationId: "corr-4",
            subject: {
              id: "user1",
              name: "Dr Smith",
              roles: ["physician"],
              type: "user",
            },
            timestamp: Date.now(),
          },
        },
        objectStore,
        auditStore
      )
    );

    expect(successResult.status).toBe("executed");
    if (successResult.status === "executed") {
      expect(successResult.decisionRecord.recordHash).toBeDefined();
      expect(successResult.decisionRecord.outcome).toBe("executed");
    }

    const auditList = await auditStore.listDecisions();
    expect(auditList.length).toBeGreaterThan(0);
  });

  it("should handle proposals and human veto / override in ActionInbox", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const inbox = new ActionInbox(auditStore, objectStore);

    const ProposeDoseAction = defineActionType({
      defaultExecutionMode: "proposal",
      description: "Propose insulin dosage",
      id: "propose_dose",
      minimumAgentTier: 2,
      name: "Propose Dose",
      parametersSchema: Schema.Struct({
        patientId: Schema.String,
        proposedDoseUnits: Schema.Number,
      }),
      riskTier: "medium",
    });

    // Tier 2 Decision Agent submits proposal
    const submissionResult = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: ProposeDoseAction,
          rawParameters: { patientId: "P123", proposedDoseUnits: 12 },
          security: {
            correlationId: "corr-inbox-1",
            subject: {
              agentTier: 2,
              id: "agent-ai",
              name: "DoseAgent",
              roles: [],
              type: "agent",
            },
            timestamp: Date.now(),
          },
        },
        objectStore,
        auditStore
      )
    );

    expect(submissionResult.status).toBe("proposed");
    if (submissionResult.status === "proposed") {
      const proposalItem = inbox.addProposal(
        {
          actionType: ProposeDoseAction,
          rawParameters: { patientId: "P123", proposedDoseUnits: 12 },
          security: {
            correlationId: "corr-inbox-1",
            subject: {
              agentTier: 2,
              id: "agent-ai",
              name: "DoseAgent",
              roles: [],
              type: "agent",
            },
            timestamp: Date.now(),
          },
        },
        submissionResult.decisionRecord
      );

      expect(inbox.getPendingProposals().length).toBe(1);

      // Attending physician exercises veto (The Anchoring Case from Chapter 1!)
      const overrideRecord = await Effect.runPromise(
        inbox.rejectProposal(
          proposalItem.id,
          {
            id: "physician-1",
            name: "Dr Zhang",
            roles: ["attending_physician"],
            type: "user",
          },
          "missing_evidence",
          "Recommendation points in reasonable direction but does not account for today's abnormal food intake"
        )
      );

      expect(overrideRecord.reasonCategory).toBe("missing_evidence");
      expect(overrideRecord.humanSubject.name).toBe("Dr Zhang");
      expect(inbox.getPendingProposals().length).toBe(0);

      const overrides = await auditStore.listOverrides();
      expect(overrides.length).toBe(1);
      expect(overrides[0].structuredReason).toContain("abnormal food intake");
    }
  });
});
