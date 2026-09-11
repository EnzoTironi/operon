import {
  ActionInbox,
  BitemporalObjectStore,
  DynamicSecurityEngine,
  InMemoryAuditStore,
  executeWritePipeline,
} from "@operon/runtime";
import { Effect } from "effect";

import {
  ApproveClaimPayoutAction,
  CareRecordType,
  CareResidentType,
  ClaimantMdoMapping,
  ClaimantType,
  DispatchEmergencyCareAction,
  InsuranceClaimType,
  NursingFacilityType,
  RegionRestrictedView,
  TriageClaimAction,
} from "./ontology.js";

export async function runSompoRdpSimulation() {
  console.log("=== OPERON SOMPO REAL DATA PLATFORM (RDP) SIMULATION ===");
  console.log(
    "Reference Architecture: Sompo Care & Sompo Japan Claims Triage\n"
  );

  const store = new BitemporalObjectStore();
  const audit = new InMemoryAuditStore();
  const inbox = new ActionInbox(audit, store);
  const securityEngine = new DynamicSecurityEngine();
  securityEngine.registerRestrictedView(RegionRestrictedView);
  securityEngine.registerMdoMapping(ClaimantMdoMapping);

  // ---------------------------------------------------------
  // PART 1: SOMPO Care (Elderly Care Frontline Emergency Action)
  // ---------------------------------------------------------
  console.log(
    "--- PART 1: SOMPO CARE (ELDERLY MONITORING & EMERGENCY TRIAGE) ---"
  );

  // 1. Initialize Nursing Facility & Resident
  await Effect.runPromise(
    store.putObject({
      id: "facility_sompo_shinjuku",
      lastModifiedAt: Date.now(),
      properties: {
        activeStaffCount: 14,
        facilityId: "facility_sompo_shinjuku",
        facilityName: "Sompo Care SompoVille Shinjuku",
        region: "Tokyo",
      },
      typeId: NursingFacilityType.id,
      version: 0,
    })
  );

  const residentId = "res_tanaka_84";
  await Effect.runPromise(
    store.putObject({
      id: residentId,
      lastModifiedAt: Date.now(),
      properties: {
        alertStatus: "stable",
        mobilityScore: 3,
        name: "Tanaka Kenji",
        residentId,
        roomNumber: "302-B",
      },
      typeId: CareResidentType.id,
      version: 0,
    })
  );
  console.log(
    `1. Care Resident 'Tanaka Kenji' (Room 302-B) initialized in stable state.`
  );

  // 2. Ingest IoT Bedside Fall Sensor Observation
  const now = Date.now();
  await Effect.runPromise(
    store.putObject({
      id: `record_${now}`,
      lastModifiedAt: now,
      properties: {
        diastolicBP: 98,
        fallDetected: true,
        heartRateBpm: 110,
        recordId: `record_${now}`,
        recordedAt: new Date(now).toISOString(),
        residentId,
        systolicBP: 155,
      },
      typeId: CareRecordType.id,
      version: 0,
    })
  );
  console.log(
    "2. Streaming IoT Bedside Sensor: Fall Detected! Heart rate: 110 bpm."
  );

  // 3. Frontline Care System dispatches Emergency Nurse Action
  console.log("3. Frontline Care System dispatches Emergency Nurse Action...");
  const dispatchSubmission = {
    actionType: DispatchEmergencyCareAction,
    rawParameters: {
      assignedNurseId: "nurse_yamamoto_rn",
      emergencyReason: "Bedside mat sensor confirmed fall with tachycardia",
      residentId,
    },
    security: {
      correlationId: "corr-sompo-care-01",
      subject: {
        id: "nurse_yamamoto_rn",
        name: "Nurse Yamamoto (RN)",
        roles: ["nurse", "certified_caregiver", "admin"],
        type: "user" as const,
      },
      timestamp: Date.now(),
    },
    stagedLogic: (
      params: typeof DispatchEmergencyCareAction.parametersSchema.Type
    ) =>
      Effect.succeed([
        {
          id: params.residentId,
          lastModifiedAt: Date.now(),
          properties: {
            alertStatus: "emergency",
            mobilityScore: 3,
            name: "Tanaka Kenji",
            residentId: params.residentId,
            roomNumber: "302-B",
          },
          typeId: CareResidentType.id,
          version: 1,
        },
      ]),
  };

  const dispatchResult = await Effect.runPromise(
    executeWritePipeline(dispatchSubmission, store, audit)
  );
  console.log(`   --> Action Status: ${dispatchResult.status}`);

  const updatedResident = await Effect.runPromise(
    store.getObject(CareResidentType.id, residentId)
  );
  console.log(
    `   --> Resident Status updated in OSv2: '${updatedResident?.properties.alertStatus}'`
  );

  // ---------------------------------------------------------
  // PART 2: SOMPO Japan (Insurance Fraud Triage & Governed Payout)
  // ---------------------------------------------------------
  console.log(
    "\n--- PART 2: SOMPO JAPAN (CLAIMS TRIAGE & GOVERNED PAYOUT) ---"
  );

  const claimantId = "clm_yamada_42";
  const claimantObj = {
    id: claimantId,
    lastModifiedAt: Date.now(),
    properties: {
      claimantId,
      fraudRiskScore: 0.88,
      name: "Yamada Taro",
      phone: "+81-90-1234-5678",
      priorClaimCount: 4,
    },
    typeId: ClaimantType.id,
    version: 0,
  };
  await Effect.runPromise(store.putObject(claimantObj));

  const claimId = "claim_auto_2026_099";
  await Effect.runPromise(
    store.putObject({
      id: claimId,
      lastModifiedAt: Date.now(),
      properties: {
        branchRegion: "Tokyo",
        claimId,
        claimStatus: "submitted",
        claimantId,
        lossAmountJpy: 7_500_000,
        triageCategory: "standard",
      },
      typeId: InsuranceClaimType.id,
      version: 0,
    })
  );
  console.log(
    `1. Automobile claim '${claimId}' received for ¥7,500,000 loss amount.`
  );

  // 2. AI Fraud Triage Action
  console.log("2. AI Claims Triage Engine evaluates fraud score (0.88)...");
  const triageSubmission = {
    actionType: TriageClaimAction,
    rawParameters: {
      claimId,
      fraudRiskScore: 0.88,
      lossAmountJpy: 7_500_000,
    },
    security: {
      correlationId: "corr-sompo-triage-01",
      subject: {
        agentTier: 4 as const,
        id: "sompo_ai_triage_bot",
        name: "Sompo AI Claims Agent",
        roles: ["ai_agent", "triage_analyst"],
        type: "agent" as const,
      },
      timestamp: Date.now(),
    },
    stagedLogic: (params: typeof TriageClaimAction.parametersSchema.Type) =>
      Effect.succeed([
        {
          id: params.claimId,
          lastModifiedAt: Date.now(),
          properties: {
            branchRegion: "Tokyo",
            claimId: params.claimId,
            claimStatus: "under_investigation",
            claimantId,
            lossAmountJpy: 7_500_000,
            triageCategory: "fraud_alert",
          },
          typeId: InsuranceClaimType.id,
          version: 1,
        },
      ]),
  };

  await Effect.runPromise(executeWritePipeline(triageSubmission, store, audit));
  const triagedClaim = await Effect.runPromise(
    store.getObject(InsuranceClaimType.id, claimId)
  );
  console.log(
    `   --> Claim Triage Category: '${triagedClaim?.properties.triageCategory}'`
  );
  console.log(`   --> Status: '${triagedClaim?.properties.claimStatus}'`);

  // 3. Senior Adjuster attempts Payout Approval -> Intercepted by Safety Guard
  console.log(
    "3. Adjuster attempts Payout Approval for ¥7,500,000 (> ¥5,000,000 safety ceiling)..."
  );
  const payoutSubmission = {
    actionType: ApproveClaimPayoutAction,
    rawParameters: {
      adjusterId: "adj_suzuki",
      approvedAmountJpy: 7_500_000,
      claimId,
    },
    security: {
      correlationId: "corr-sompo-payout-01",
      subject: {
        agentTier: 3 as const,
        id: "adj_suzuki",
        name: "Adjuster Suzuki",
        roles: ["claims_adjuster"],
        type: "user" as const,
      },
      timestamp: Date.now(),
    },
    stagedLogic: (
      params: typeof ApproveClaimPayoutAction.parametersSchema.Type
    ) =>
      Effect.succeed([
        {
          id: params.claimId,
          lastModifiedAt: Date.now(),
          properties: {
            branchRegion: "Tokyo",
            claimId: params.claimId,
            claimStatus: "approved",
            claimantId,
            lossAmountJpy: 7_500_000,
            triageCategory: "fraud_alert",
          },
          typeId: InsuranceClaimType.id,
          version: 2,
        },
      ]),
  };

  const payoutResult = await Effect.runPromise(
    executeWritePipeline(payoutSubmission, store, audit)
  );
  console.log(`   --> Pipeline Status: ${payoutResult.status}`);
  if (payoutResult.status === "proposed") {
    console.log(
      `   --> Intercepted by Safety Guard: Proposal routed to Action Inbox (ID: ${payoutResult.proposalId})`
    );
    inbox.addProposal(payoutSubmission, payoutResult.decisionRecord);

    // 4. Senior Claims Director reviews and approves from Action Inbox
    console.log(
      "4. Senior Claims Director reviews and approves from Action Inbox..."
    );
    const approvedResult = await Effect.runPromise(
      inbox.approveProposal(payoutResult.proposalId, {
        agentTier: 4 as const,
        id: "dir_takahashi",
        name: "Director Takahashi",
        roles: ["claims_director", "admin"],
        type: "user" as const,
      })
    );
    console.log(
      `   --> Action Confirmed. Approved by: ${approvedResult.subject.name}`
    );
  }

  const approvedClaim = await Effect.runPromise(
    store.getObject(InsuranceClaimType.id, claimId)
  );
  console.log(
    `   --> Final Claim Status in OSv2: '${approvedClaim?.properties.claimStatus}'`
  );

  // 5. Restricted View & MDO Privacy Verification
  console.log("\n5. Governance & Privacy Verification:");
  const analyticsUser = {
    agentTier: 1 as const,
    id: "analyst_guest",
    name: "Data Analyst",
    roles: ["analytics"],
    type: "user" as const,
  };
  const maskedClaimant = securityEngine.projectInstance(
    claimantObj,
    analyticsUser
  );
  console.log(
    `   - Analytics Persona PII Masked: name = '${maskedClaimant.properties.name ?? "[MASKED]"}', phone = '${maskedClaimant.properties.phone ?? "[MASKED]"}'`
  );

  const totalDecisionRecords = await Effect.runPromise(
    audit.listDecisions({ limit: 100 })
  );
  console.log(
    `   - Cryptographic Audit Ledger Size: ${totalDecisionRecords.length} immutable records`
  );
  console.log("=== SOMPO SIMULATION COMPLETED SUCCESSFULLY ===\n");

  return {
    approvedClaim,
    maskedClaimant,
    totalDecisionRecords,
    updatedResident,
  };
}
