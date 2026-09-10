import {
  defineActionType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  BitemporalObjectStore,
  DynamicSecurityEngine,
  FunnelService,
  InMemoryAuditStore,
  ObjectSetService,
  OntologyMetadataService,
  executeWritePipeline,
} from "./index.js";

describe("Operon Microservice Pillars (OMS, OSS, Funnel, Bitemporal, Security)", () => {
  it("supports bitemporal time-travel queries across Valid and Transaction time", async () => {
    const store = new BitemporalObjectStore();

    // T_v=100: Patient dose 14U
    await Effect.runPromise(
      store.putObject(
        {
          id: "P1",
          lastModifiedAt: 100,
          properties: { dose: 14 },
          typeId: "Patient" as any,
          version: 0,
        },
        100
      )
    );

    // Later at T_v=200: Patient dose 12U
    const current = await Effect.runPromise(
      store.getObject("Patient" as any, "P1")
    );
    await Effect.runPromise(
      store.putObject(
        {
          id: "P1",
          lastModifiedAt: 200,
          properties: { dose: 12 },
          typeId: "Patient" as any,
          version: current!.version,
        },
        200
      )
    );

    // Query valid time at T_v=150
    const pastValid = await Effect.runPromise(
      store.asOfValidTime("Patient" as any, "P1", 150)
    );
    expect(pastValid).toBeDefined();
    expect((pastValid!.properties as any).dose).toBe(14);

    // Query valid time at T_v=250
    const currentValid = await Effect.runPromise(
      store.asOfValidTime("Patient" as any, "P1", 250)
    );
    expect(currentValid).toBeDefined();
    expect((currentValid!.properties as any).dose).toBe(12);
  });

  it("manages branches and enforces multi-stakeholder ontology proposals in OMS", async () => {
    const oms = new OntologyMetadataService();
    const admin = {
      id: "admin",
      name: "Alice",
      roles: ["admin"],
      type: "human" as const,
    };
    const complianceOfficer = {
      id: "comp1",
      name: "Bob",
      roles: ["compliance_officer"],
      type: "human" as const,
    };

    // 1. Create working branch
    const branch = await Effect.runPromise(
      oms.createBranch("feature-telemetry", admin)
    );
    expect(branch.name).toBe("feature-telemetry");

    // 2. Register new ObjectType on branch
    const TelemetryType = defineObjectType({
      description: "Sensor readings",
      id: "Telemetry",
      name: "Telemetry",
      primaryKey: "id",
      properties: {
        id: defineProperty({ description: "ID", schema: Schema.String }),
        temp: defineProperty({
          description: "Temperature",
          schema: Schema.Number,
        }),
      },
      typology: "observation",
    });
    await Effect.runPromise(
      oms.registerObjectType("feature-telemetry", TelemetryType)
    );

    // 3. Create proposal
    const proposal = await Effect.runPromise(
      oms.createProposal({
        author: admin,
        changeSet: {
          addedActionTypes: [],
          addedLinkTypes: [],
          addedObjectTypes: [TelemetryType],
          deletedActionTypeIds: [],
          deletedLinkTypeIds: [],
          deletedObjectTypeIds: [],
          modifiedActionTypes: [],
          modifiedLinkTypes: [],
          modifiedObjectTypes: [],
        },
        description: "Add Telemetry observation model",
        sourceBranch: "feature-telemetry",
        title: "Telemetry Ingestion Support",
      })
    );
    expect(proposal.status).toBe("open");

    // 4. Try merge without compliance review (should fail under compliance policy)
    const mergeAttempt = await Effect.runPromise(
      oms
        .mergeProposal(proposal.id, admin, {
          requireComplianceReview: true,
          requireDomainSpecialistReview: false,
          requiredMinApprovals: 1,
        })
        .pipe(Effect.result)
    );
    expect(mergeAttempt._tag).toBe("Failure");

    // 5. Compliance officer reviews and approves
    await Effect.runPromise(
      oms.reviewProposal(proposal.id, {
        comments: "Approved from data compliance standpoint",
        reviewedAt: Date.now(),
        reviewer: complianceOfficer,
        verdict: "approve",
      })
    );

    // 6. Merge now succeeds
    const merged = await Effect.runPromise(
      oms.mergeProposal(proposal.id, admin, {
        requireComplianceReview: true,
        requireDomainSpecialistReview: false,
        requiredMinApprovals: 1,
      })
    );
    expect(merged.status).toBe("merged");

    // Main branch now has Telemetry
    const mainSchema = await Effect.runPromise(oms.getSchema("main"));
    expect(mainSchema.objectTypes.has("Telemetry")).toBe(true);
  });

  it("performs set algebra and graph traversals in OSS", async () => {
    const store = new BitemporalObjectStore();
    const oss = new ObjectSetService(store);

    await Effect.runPromise(
      store.putObject({
        id: "A1",
        lastModifiedAt: Date.now(),
        properties: { model: "A350", status: "active" },
        typeId: "Aircraft" as any,
        version: 0,
      })
    );
    await Effect.runPromise(
      store.putObject({
        id: "A2",
        lastModifiedAt: Date.now(),
        properties: { model: "A380", status: "maintenance" },
        typeId: "Aircraft" as any,
        version: 0,
      })
    );
    await Effect.runPromise(
      store.putObject({
        id: "A3",
        lastModifiedAt: Date.now(),
        properties: { model: "A350", status: "maintenance" },
        typeId: "Aircraft" as any,
        version: 0,
      })
    );

    const aircraftSet = oss.getSet("Aircraft" as any);

    // Filter
    const a350s = aircraftSet.whereEquals("model", "A350");
    const a350List = await Effect.runPromise(a350s.all());
    expect(a350List.length).toBe(2);

    // Aggregate
    const grouped = await Effect.runPromise(
      aircraftSet.aggregate({ groupByProperty: "status", metric: "count" })
    );
    expect(grouped.groups?.["active"]).toBe(1);
    expect(grouped.groups?.["maintenance"]).toBe(2);

    // Link traversal
    await Effect.runPromise(
      store.putObject({
        id: "P_TURBINE_1",
        lastModifiedAt: Date.now(),
        properties: { serial: "SN-998" },
        typeId: "Part" as any,
        version: 0,
      })
    );
    await Effect.runPromise(
      store.linkObjects({
        createdAt: Date.now(),
        linkTypeId: "AircraftParts" as any,
        sourceId: "A1",
        targetId: "P_TURBINE_1",
      })
    );

    const activeAircraft = aircraftSet.whereEquals("status", "active");
    const activeParts = activeAircraft.traverseLink(
      "AircraftParts" as any,
      "Part" as any,
      "forward"
    );
    const partsList = await Effect.runPromise(activeParts.all());
    expect(partsList.length).toBe(1);
    expect((partsList[0].properties as any).serial).toBe("SN-998");
  });

  it("ingests batch data and resolves conflicts in the Funnel Service", async () => {
    const store = new BitemporalObjectStore();
    const funnel = new FunnelService(store);

    await Effect.runPromise(
      funnel.registerPipeline({
        conflictPolicy: "user_edit_wins",
        id: "sensor-stream",
        mode: "batch",
        name: "Sensor Ingestion",
        primaryKeyField: "sensor_id",
        propertyMappings: [
          { sourceField: "vibration_hz", targetPropertyName: "vibrationHz" },
          { sourceField: "temperature_c", targetPropertyName: "tempC" },
        ],
        sourceDatasetId: "dwh_telemetry",
        targetObjectTypeId: "Sensor",
      })
    );

    // Ingest initial batch
    const res = await Effect.runPromise(
      funnel.ingestBatch("sensor-stream", [
        { sensor_id: "S1", temperature_c: 85, vibration_hz: 120 },
        { sensor_id: "S2", temperature_c: 90, vibration_hz: 140 },
      ])
    );
    expect(res.createdCount).toBe(2);

    const s1 = await Effect.runPromise(store.getObject("Sensor" as any, "S1"));
    expect((s1!.properties as any).tempC).toBe(85);
  });

  it("enforces Restricted Views and Multi-Dataset Objects in Dynamic Security", () => {
    const security = new DynamicSecurityEngine();

    // Row-level RV: Sales can only see active customers
    security.registerRestrictedView({
      description: "Sales sees active accounts only",
      id: "rv_sales_active",
      name: "Sales Active Filter",
      objectTypeId: "Customer",
      predicate: (inst, subj) => {
        if (subj.roles.includes("sales")) {
          return (inst.properties as any).status === "active";
        }
        return true;
      },
    });

    // Column-level MDO: SSN requires compliance role
    security.registerMdoMapping({
      authorizedRolesPerClassification: {
        confidential: ["manager"],
        internal: ["employee"],
        pii: ["compliance_officer"],
        public: [],
        restricted: ["admin"],
      },
      datasetSources: { name: "ds1", ssn: "ds2" },
      objectTypeId: "Customer",
      propertyClassifications: {
        name: "public",
        ssn: "pii",
      },
    });

    const instances = [
      {
        id: "C1",
        lastModifiedAt: Date.now(),
        properties: { name: "Acme", ssn: "000-11-2222", status: "active" },
        typeId: "Customer" as any,
        version: 1,
      },
      {
        id: "C2",
        lastModifiedAt: Date.now(),
        properties: { name: "Beta", ssn: "333-44-5555", status: "churned" },
        typeId: "Customer" as any,
        version: 1,
      },
    ];

    const salesUser = {
      id: "u1",
      name: "Sam",
      roles: ["sales"],
      type: "human" as const,
    };
    const filtered = security.filterInstances(instances, salesUser);
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe("C1");

    // Check MDO property masking for sales user
    const projected = security.projectInstance(filtered[0], salesUser);
    expect((projected.properties as any).name).toBe("Acme");
    expect((projected.properties as any).ssn).toBe(
      "[REDACTED_BY_SECURITY_POLICY]"
    );

    // Compliance user can see SSN
    const complianceUser = {
      id: "u2",
      name: "Carol",
      roles: ["compliance_officer"],
      type: "human" as const,
    };
    const compProjected = security.projectInstance(filtered[0], complianceUser);
    expect((compProjected.properties as any).ssn).toBe("000-11-2222");
  });

  it("automatically materializes 1-to-1 ActionLog objects upon action execution", async () => {
    const store = new BitemporalObjectStore();
    const audit = new InMemoryAuditStore();

    await Effect.runPromise(
      store.putObject({
        id: "P100",
        lastModifiedAt: Date.now(),
        properties: { dose: 20 },
        typeId: "Patient" as any,
        version: 0,
      })
    );

    const SetDoseAction = defineActionType({
      defaultExecutionMode: "automated",
      description: "Set dose",
      id: "set_dose",
      minimumAgentTier: 1,
      name: "Set Dose",
      parametersSchema: Schema.Struct({
        newDose: Schema.Number,
        patientId: Schema.String,
      }),
      riskTier: "low",
    });

    const result = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: SetDoseAction,
          rawParameters: { newDose: 18, patientId: "P100" },
          security: {
            correlationId: "c-action-log",
            subject: {
              id: "dr-smith",
              name: "Dr Smith",
              roles: ["physician"],
              type: "human",
            },
            timestamp: Date.now(),
          },
          stagedLogic: (params) =>
            Effect.succeed([
              {
                id: params.patientId,
                lastModifiedAt: Date.now(),
                properties: { dose: params.newDose },
                typeId: "Patient" as any,
                version: 1,
              },
            ]),
        },
        store,
        audit
      )
    );

    expect(result.status).toBe("executed");

    // Verify ActionLog object was created in the store
    const logs = await Effect.runPromise(store.findObjects("ActionLog" as any));
    expect(logs.length).toBe(1);
    expect((logs[0].properties as any).actionTypeId).toBe("set_dose");
    expect((logs[0].properties as any).targetObjectId).toBe("P100");

    // Verify link exists between ActionLog and target Patient
    const links = await Effect.runPromise(
      store.getLinks("ActionLogTarget" as any, logs[0].id)
    );
    expect(links.length).toBe(1);
    expect(links[0].targetId).toBe("P100");
  });
});
