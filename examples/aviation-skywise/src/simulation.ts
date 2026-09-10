import {
  ActionInbox,
  BitemporalObjectStore,
  FunnelService,
  InMemoryAuditStore,
  executeWritePipeline,
} from "@operon/runtime";
import { Effect } from "effect";

import {
  AircraftType,
  MaintenanceWorkOrderType,
  ScheduleMaintenanceAction,
  TurbineTelemetryType,
} from "./ontology.js";

export async function runAviationSimulation() {
  console.log("=== OPERON AVIATION SKYWISE DIGITAL TWIN SIMULATION ===");
  console.log(
    "Reference Architecture: Airbus 5-Million-Part Predictive Maintenance\n"
  );

  const store = new BitemporalObjectStore();
  const audit = new InMemoryAuditStore();
  const funnel = new FunnelService(store);
  const inbox = new ActionInbox(audit, store);

  // Step 1: Initialize Aircraft Digital Twin
  const tailNumber = "F-WZNW";
  await Effect.runPromise(
    store.putObject({
      id: tailNumber,
      lastModifiedAt: Date.now(),
      properties: {
        model: "A350-900",
        status: "in_service",
        tailNumber,
        totalFlightHours: 12450,
      },
      typeId: AircraftType.id,
      version: 0,
    })
  );
  console.log(
    `1. Aircraft Airframe Digital Twin '${tailNumber}' (A350-900) initialized.`
  );

  // Step 2: Ingest High-Frequency IoT Telemetry via Funnel
  await Effect.runPromise(
    funnel.registerPipeline({
      conflictPolicy: "source_wins",
      id: "engine_stream",
      mode: "streaming",
      name: "Turbine Sensor Telemetry",
      primaryKeyField: "telemetry_id",
      propertyMappings: [
        { sourceField: "telemetry_id", targetPropertyName: "telemetryId" },
        { sourceField: "tail_number", targetPropertyName: "tailNumber" },
        {
          sourceField: "engine_position",
          targetPropertyName: "enginePosition",
        },
        { sourceField: "vibration_mm_s", targetPropertyName: "vibrationMmS" },
        { sourceField: "egt_c", targetPropertyName: "egtCelsius" },
      ],
      sourceDatasetId: "aircraft_iot_gateway",
      targetObjectTypeId: TurbineTelemetryType.id,
    })
  );

  console.log("2. Streaming IoT Telemetry ingested via Funnel Pipeline...");
  const telemetrySample = await Effect.runPromise(
    funnel.ingestStreamRecord("engine_stream", {
      egt_c: 685,
      engine_position: "left",
      tail_number: tailNumber,
      telemetry_id: "TELEM_001",
      vibration_mm_s: 14.2, // Critical vibration threshold (> 10 mm/s)
    })
  );
  console.log(
    `   --> Turbine Vibration: ${(telemetrySample.properties as any).vibrationMmS} mm/s (THRESHOLD EXCEEDED: >10 mm/s)`
  );

  // Step 3: AI Predictive Maintenance Agent Proposes Work Order
  console.log(
    "3. AI Predictive Maintenance Agent (Tier 2) proposes urgent maintenance..."
  );
  const agentSubmission = {
    actionType: ScheduleMaintenanceAction,
    rawParameters: {
      assignedStation: "CDG",
      reason:
        "Radial vibration (14.2 mm/s) indicates potential Stage-2 turbine blade wear",
      tailNumber,
      urgency: "urgent" as const,
    },
    security: {
      correlationId: "corr-aviation-101",
      subject: {
        agentTier: 2 as const,
        id: "skywise-predictive-agent",
        name: "Skywise AI Anomaly Detector",
        roles: ["predictive_agent"],
        type: "agent" as const,
      },
      timestamp: Date.now(),
    },
    stagedLogic: (params: any) =>
      Effect.succeed([
        {
          id: `WO_${Date.now()}`,
          lastModifiedAt: Date.now(),
          properties: {
            assignedStation: params.assignedStation,
            orderId: `WO_${Date.now()}`,
            reason: params.reason,
            status: "scheduled",
            tailNumber: params.tailNumber,
            urgency: params.urgency,
          },
          typeId: MaintenanceWorkOrderType.id,
          version: 0,
        },
      ]),
  };

  const actionResult = await Effect.runPromise(
    executeWritePipeline(agentSubmission, store, audit)
  );

  console.log(`   --> Pipeline Status: ${actionResult.status}`);
  if (actionResult.status === "proposed") {
    console.log(
      `   --> Intercepted by Safety Guard: Proposal routed to Action Inbox (ID: ${actionResult.proposalId})`
    );
    inbox.addProposal(agentSubmission, actionResult.decisionRecord);
  }

  // Step 4: Chief Fleet Engineer Reviews in Approvals / Action Inbox
  console.log("4. Chief Fleet Engineer reviews proposal in Action Inbox...");
  const chiefEngineer = {
    id: "eng-chief-01",
    name: "Jean-Luc Moreau (Chief Fleet Engineer)",
    roles: ["chief_engineer", "fleet_manager"],
    type: "user" as const,
  };

  const approvalResult = await Effect.runPromise(
    inbox.approveProposal(actionResult.decisionRecord.id, chiefEngineer)
  );
  console.log(`   --> Approved by: ${chiefEngineer.name}`);
  console.log(
    `   --> Action Execution Confirmed. Decision Hash: ${approvalResult.recordHash}`
  );

  // Step 5: Verify 1-to-1 ActionLog Object & Audit Trail
  const actionLogs = await Effect.runPromise(
    store.findObjects("ActionLog" as any)
  );
  const workOrders = await Effect.runPromise(
    store.findObjects(MaintenanceWorkOrderType.id)
  );

  console.log("\n5. Verification & Traceability:");
  console.log(`   - Scheduled Work Orders in OSv2: ${workOrders.length}`);
  console.log(
    `   - Materialized 1-to-1 ActionLog Objects: ${actionLogs.length}`
  );
  console.log(
    `   - ActionLog linked to target: ${(actionLogs[0].properties as any).targetObjectId}`
  );
  console.log("\n=== AVIATION SIMULATION COMPLETED SUCCESSFULLY ===");

  return { actionLogs, workOrders };
}
