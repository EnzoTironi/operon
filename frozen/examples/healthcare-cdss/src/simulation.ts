import type { ActionExecutionResult, ActionSubmission } from "@operon/runtime";
import {
  ActionInbox,
  evaluateDecisionReadiness,
  executeWritePipeline,
  InMemoryAuditStore,
  InMemoryObjectStore,
} from "@operon/runtime";
import type { ActionParameters } from "@operon/schema";
import { Effect } from "effect";

import {
  AdjustInsulinDoseAction,
  MealObservationType,
  PatientType,
} from "./ontology.js";

async function simulateUngroundedAttempt<Params extends ActionParameters>(
  agentSubmission: ActionSubmission<Params>,
  objectStore: InMemoryObjectStore,
  auditStore: InMemoryAuditStore
): Promise<void> {
  const intercepted = await Effect.runPromise(
    executeWritePipeline(agentSubmission, objectStore, auditStore).pipe(
      Effect.as(null),
      Effect.catchTag("SubmissionCriteriaFailedError", (err) =>
        Effect.succeed(err)
      )
    )
  );

  if (intercepted) {
    console.log("   --> [INTERCEPTED BY OPERON GUARD]:", intercepted.reason);
    console.log(
      "   --> Operational Ontology stopped ungrounded decision BEFORE trust collapse!"
    );
  }
}

async function checkPatientReadiness(
  objectStore: InMemoryObjectStore,
  now: number
): Promise<void> {
  const patientObj = await Effect.runPromise(
    objectStore.getObject(PatientType.id, "P101")
  );
  if (patientObj) {
    const readiness = evaluateDecisionReadiness(patientObj, PatientType, now);
    console.log(
      "   --> Patient 4C Decision Readiness:",
      readiness.isReady ? "READY" : "NOT READY"
    );
  }
}

async function simulatePhysicianReview<Params extends ActionParameters>(
  secondSubmissionResult: ActionExecutionResult,
  inbox: ActionInbox,
  agentSubmission: ActionSubmission<Params>
): Promise<void> {
  if (secondSubmissionResult.status !== "proposed") {
    return;
  }

  console.log(
    "   --> Proposal routed to Human Action Inbox (Proposal ID:",
    secondSubmissionResult.proposalId,
    ")"
  );
  console.log(
    "   --> Guard Reason:",
    secondSubmissionResult.decisionRecord.reason
  );

  const item = inbox.addProposal(
    agentSubmission,
    secondSubmissionResult.decisionRecord
  );

  console.log(
    "\n5. Attending Physician (Dr. Li) reviews proposal in Action Inbox..."
  );
  console.log("   --> AI Proposed: 12U");
  console.log("   --> Attending Physician sets: 10U (VETO / OVERRIDE)");

  const override = await Effect.runPromise(
    inbox.rejectProposal(
      item.id,
      {
        id: "physician-dr-li",
        name: "Dr. Li (Attending Physician)",
        roles: ["attending_endocrinologist"],
        type: "user",
      },
      "clinical_discretion",
      "Reduced intake (50%) combined with impaired renal clearance (eGFR 52) warrants 10U dose to prevent nocturnal hypoglycemia"
    )
  );

  console.log("   --> [OVERRIDE RECORD CREATED]:");
  console.log("       Category:", override.reasonCategory);
  console.log("       Reason:", override.structuredReason);
  console.log("       Physician:", override.humanSubject.name);
}

export async function runClinicalSimulation() {
  const objectStore = new InMemoryObjectStore();
  const auditStore = new InMemoryAuditStore();
  const inbox = new ActionInbox(auditStore, objectStore);

  console.log(
    "=== OPERON CLINICAL CDSS SIMULATION (CHAPTER 1 CASE STUDY) ===\n"
  );

  // Step 1: Initialize Patient State
  const now = Date.now();
  await Effect.runPromise(
    objectStore.putObject({
      id: "P101",
      lastModifiedAt: now,
      properties: {
        currentBasalDose: 14,
        eGFR: 52, // Impaired renal function
        name: "Zhang Minghua",
        patientId: "P101",
      },
      typeId: PatientType.id,
      version: 1,
    })
  );

  console.log(
    "1. Patient 'Zhang Minghua' initialized (Current Dose: 14U, eGFR: 52 mL/min)."
  );

  // Step 2: Attempt AI Recommendation WITHOUT Food Intake Observation
  // In the book: AI model only saw glucose curve and eGFR, missing the nurse's handover note!
  console.log(
    "\n2. AI Recommendation Engine attempts to propose dose reduction to 12U..."
  );
  const agentSubmission = {
    actionType: AdjustInsulinDoseAction,
    rawParameters: {
      clinicalRationale:
        "Blood-glucose trend downward over 72h, impaired renal function (eGFR=52 mL/min)",
      patientId: "P101",
      proposedDoseUnits: 12,
    },
    security: {
      correlationId: "corr-sim-001",
      subject: {
        agentTier: 2 as const, // Tier 2 (Propose)
        id: "ai-cdss-agent",
        name: "InsulinDoseAgent",
        roles: ["cdss_recommender"],
        type: "agent" as const,
      },
      timestamp: now,
    },
  };

  await simulateUngroundedAttempt(agentSubmission, objectStore, auditStore);

  // Step 3: Event Path - Nurse records handover note as structured MealObservation
  console.log(
    "\n3. Event Path: Nurse enters structured meal observation ('breakfast intake: 50%', nausea: true)..."
  );
  await Effect.runPromise(
    objectStore.putObject({
      id: "meal-P101",
      lastModifiedAt: now,
      properties: {
        intakePercent: 50, // Half the usual breakfast
        nauseaReported: true,
        observationId: "meal-P101",
        patientId: "P101",
      },
      provenance: {
        ingestedAt: now,
        recordedAt: now,
        sourceSystem: "NursingEHR",
      },
      typeId: MealObservationType.id,
      version: 1,
    })
  );

  // Check 4C Decision Readiness
  await checkPatientReadiness(objectStore, now);

  // Step 4: AI Model Re-evaluates with Complete State
  console.log(
    "\n4. AI Model proposes 12U with complete state; Guard checks hypoglycemia risk..."
  );
  const secondSubmissionResult = await Effect.runPromise(
    executeWritePipeline(agentSubmission, objectStore, auditStore)
  );

  console.log("   --> Pipeline Status:", secondSubmissionResult.status);
  await simulatePhysicianReview(secondSubmissionResult, inbox, agentSubmission);

  // Step 6: Verify Immutable Audit Dossier
  const auditLogs = await Effect.runPromise(auditStore.listDecisions());
  const overrides = await Effect.runPromise(auditStore.listOverrides());

  console.log("\n6. Governance Audit Trail Summary:");
  console.log("   - Total DecisionRecords logged:", auditLogs.length);
  console.log("   - Total Overrides logged:", overrides.length);
  console.log("   - Latest Decision Hash:", auditLogs.at(-1)?.recordHash);
  console.log("\n=== SIMULATION COMPLETED SUCCESSFULLY ===");

  return { auditLogs, overrides };
}
