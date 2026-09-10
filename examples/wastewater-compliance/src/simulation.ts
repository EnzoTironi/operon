import {
  ActionInbox,
  BitemporalObjectStore,
  InMemoryAuditStore,
  executeWritePipeline,
} from "@operon/runtime";
import { Effect } from "effect";

import {
  AerationTankType,
  DOSensorType,
  PermitVersionType,
  ProposeSetpointChangeAction,
  TelemetryReadingType,
  TreatmentPlantType,
} from "./ontology.js";

export async function runWastewaterSimulation() {
  console.log(
    "=== OPERON WASTEWATER TREATMENT PLANT SIMULATION (CHAPTER 12) ==="
  );
  console.log(
    "Reference Architecture: BSM1 Bioreactor Aeration & EPA Compliance Twin\n"
  );

  const store = new BitemporalObjectStore();
  const audit = new InMemoryAuditStore();
  const inbox = new ActionInbox(audit, store);

  // 1. Initialize Municipal Plant & EPA Permit Version
  await Effect.runPromise(
    store.putObject({
      id: "plant_central_wwtp",
      lastModifiedAt: Date.now(),
      properties: {
        dailyCapacityM3: 150000,
        name: "Metro Central WWTP",
        plantId: "plant_central_wwtp",
      },
      typeId: TreatmentPlantType.id,
      version: 0,
    })
  );

  await Effect.runPromise(
    store.putObject({
      id: "EPA-NPDES-2026",
      lastModifiedAt: Date.now(),
      properties: {
        effectiveDate: "2026-01-01T00:00:00Z",
        maxEffluentCODmgL: 50,
        maxEffluentNH4mgL: 5,
        permitId: "EPA-NPDES-2026",
      },
      typeId: PermitVersionType.id,
      version: 0,
    })
  );
  console.log(
    "1. Municipal Plant and EPA Permit 'EPA-NPDES-2026' initialized (COD Limit: 50 mg/L)."
  );

  // 2. Initialize Aeration Tank-3 & DO Sensor (Calibrated 12 days ago)
  const tankId = "Tank-3";
  await Effect.runPromise(
    store.putObject({
      id: tankId,
      lastModifiedAt: Date.now(),
      properties: {
        currentSetpointDO: 2.6,
        operatingStatus: "operating",
        tankId,
        volumeM3: 8500,
      },
      typeId: AerationTankType.id,
      version: 0,
    })
  );

  await Effect.runPromise(
    store.putObject({
      id: `sensor-${tankId}`,
      lastModifiedAt: Date.now(),
      properties: {
        calibrationStatus: "valid",
        daysSinceCalibration: 12, // Valid (< 30 days)
        sensorId: `sensor-${tankId}`,
        tankId,
      },
      typeId: DOSensorType.id,
      version: 0,
    })
  );
  console.log(
    "2. Bioreactor Basin Tank-3 and DO Sensor initialized (Current Setpoint: 2.6 mg/L, Calibration: 12 days)."
  );

  // 3. Ingest Drop in DO Telemetry
  const now = Date.now();
  await Effect.runPromise(
    store.putObject({
      id: `reading_${now}`,
      lastModifiedAt: now,
      properties: {
        airFlowRateM3h: 3200,
        measuredDO: 1.8, // Low DO excursion
        readingId: `reading_${now}`,
        recordedAt: new Date(now).toISOString(),
        tankId,
      },
      typeId: TelemetryReadingType.id,
      version: 0,
    })
  );
  console.log(
    "3. SCADA Telemetry Stream: DO dropped to 1.8 mg/L (Nitrification risk)."
  );

  // 4. Test EPA Margin Guard: Unsafe AI Recommendation (Predicted COD 48 mg/L > 45 mg/L ceiling)
  console.log(
    "4. Testing Safety Guard: AI attempts to propose low aeration with Predicted COD 48 mg/L..."
  );
  const unsafeSubmission = {
    actionType: ProposeSetpointChangeAction,
    rawParameters: {
      predictedEffluentCOD: 48, // Fails 10% safety margin: 48 > 45 mg/L
      proposedDO: 1.9,
      rationale: "Aggressive energy minimization",
      tankId,
    },
    security: {
      correlationId: "corr-ww-unsafe-01",
      subject: {
        agentTier: 2 as const,
        id: "ai_blower_optimizer",
        name: "BSM1 Aeration Optimizer",
        roles: ["optimization_agent"],
        type: "agent" as const,
      },
      timestamp: Date.now(),
    },
  };

  const unsafeResult = await Effect.runPromise(
    executeWritePipeline(unsafeSubmission, store, audit).pipe(Effect.flip)
  );
  console.log(
    `   --> [INTERCEPTED BY OPERON EPA GUARD]: ${unsafeResult.message}`
  );

  // 5. Valid AI Recommendation (Predicted COD 41 mg/L <= 45 mg/L ceiling)
  console.log(
    "\n5. AI Optimizer proposes compliant setpoint (2.4 mg/L, Predicted COD: 41 mg/L)..."
  );
  const validSubmission = {
    actionType: ProposeSetpointChangeAction,
    rawParameters: {
      predictedEffluentCOD: 41,
      proposedDO: 2.4,
      rationale: "Restore nitrification while maintaining EPA margin",
      tankId,
    },
    security: {
      correlationId: "corr-ww-valid-01",
      subject: {
        agentTier: 2 as const,
        id: "ai_blower_optimizer",
        name: "BSM1 Aeration Optimizer",
        roles: ["optimization_agent"],
        type: "agent" as const,
      },
      timestamp: Date.now(),
    },
  };

  const validResult = await Effect.runPromise(
    executeWritePipeline(validSubmission, store, audit)
  );
  console.log(`   --> Pipeline Status: ${validResult.status}`);
  if (validResult.status === "proposed") {
    console.log(
      `   --> Routed to Process Engineer Action Inbox (Proposal ID: ${validResult.proposalId})`
    );
    const item = inbox.addProposal(validSubmission, validResult.decisionRecord);

    // 6. Process Engineer reviews and modifies setpoint to 2.2 mg/L for energy balance
    console.log(
      "\n6. Process Engineer (Dr. Vance) reviews proposal in Action Inbox..."
    );
    const override = await Effect.runPromise(
      inbox.rejectProposal(
        item.id,
        {
          agentTier: 4 as const,
          id: "eng_vance",
          name: "Dr. Vance (Process Engineer)",
          roles: ["process_engineer"],
          type: "user" as const,
        },
        "operational_override",
        "Process engineer sets 2.2 mg/L to balance blower energy with safety margin"
      )
    );
    console.log(
      `   --> Override Recorded: Category '${override.reasonCategory}' by ${override.humanSubject.name}`
    );
  }

  const finalTank = await Effect.runPromise(
    store.getObject(AerationTankType.id, tankId)
  );
  console.log(
    `   --> Tank-3 Operating State verified in OSv2: '${finalTank?.properties.operatingStatus}'`
  );

  const decisions = await Effect.runPromise(audit.listDecisions({ limit: 10 }));
  const overrides = await Effect.runPromise(audit.listOverrides());
  console.log(`\n7. Audit & Verification Trail:`);
  console.log(`   - Decision Records: ${decisions.length}`);
  console.log(`   - First-Class Override Records: ${overrides.length}`);
  console.log(
    `   - Latest Decision Hash: ${decisions[0]?.recordHash.slice(0, 16)}...`
  );
  console.log("=== WASTEWATER SIMULATION COMPLETED SUCCESSFULLY ===\n");
}
