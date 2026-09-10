import * as fs from "node:fs";
import path from "node:path";

import {
  AccountableIngestionService,
  ActionInbox,
  DynamicSecurityEngine,
  InMemoryAuditStore,
  InMemoryObjectStore,
  NativeSqliteDriver,
  OntologyMetadataService,
  ReconciliationService,
  SandboxedModelRunner,
  SqlBitemporalStore,
} from "@operon/runtime";
import type {
  ActionType,
  LinkType,
  ObjectType,
  ObjectTypeId,
  Subject,
} from "@operon/schema";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
} from "@operon/schema";
import { Effect, Schema } from "effect";

export const PatientType = defineObjectType({
  description: "Hospital patient undergoing medical treatment",
  id: "Patient",
  name: "Patient",
  primaryKey: "id",
  properties: {
    currentDose: { description: "Current insulin dose", schema: Schema.Number },
    egfr: {
      description: "Estimated glomerular filtration rate",
      schema: Schema.Number,
    },
    id: { description: "Patient identifier", schema: Schema.String },
    name: { description: "Patient name", schema: Schema.String },
    room: { description: "Room number", schema: Schema.String },
  },
  typology: "master",
});

export const ClarifierTankType = defineObjectType({
  description: "Wastewater secondary clarifier tank",
  id: "ClarifierTank",
  name: "Clarifier Tank",
  primaryKey: "id",
  properties: {
    effluentTss: {
      description: "Effluent total suspended solids",
      schema: Schema.Number,
    },
    id: { description: "Tank identifier", schema: Schema.String },
    sludgeDepth: { description: "Sludge blanket depth", schema: Schema.Number },
    status: { description: "Operational status", schema: Schema.String },
  },
  typology: "master",
});

export const AircraftTwinType = defineObjectType({
  description: "Airframe digital twin for predictive fleet maintenance",
  id: "AircraftTwin",
  name: "Aircraft Twin",
  primaryKey: "id",
  properties: {
    flightHours: { description: "Total flight hours", schema: Schema.Number },
    id: { description: "Aircraft tail identifier", schema: Schema.String },
    model: { description: "Aircraft model", schema: Schema.String },
    tailNumber: {
      description: "Tail registration number",
      schema: Schema.String,
    },
    turbineVibration: {
      description: "Vibration telemetry in mm/s",
      schema: Schema.Number,
    },
  },
  typology: "master",
});

export const PatientObservationLink: LinkType = defineLinkType({
  cardinality: "one-to-many",
  description: "Patient observations linked to clinical decisions",
  id: "PatientObservation",
  sourceToTargetName: "observations",
  sourceTypeId: "Patient",
  targetToSourceName: "patient",
  targetTypeId: "Patient",
});

export const UpdateVitalsAction: ActionType = defineActionType({
  defaultExecutionMode: "automated",
  description: "Record and update patient vital signs",
  id: "update_vitals",
  minimumAgentTier: 1,
  mutation: (params, ctx) =>
    Effect.map(
      ctx.getObject("Patient" as ObjectTypeId, params.patientId),
      (p) =>
        p
          ? [
              {
                ...p,
                lastModifiedAt: ctx.now,
                properties: {
                  ...p.properties,
                  heartRate: params.heartRate,
                },
                version: p.version + 1,
              },
            ]
          : []
    ),
  name: "Update Vitals",
  parametersSchema: Schema.Struct({
    heartRate: Schema.Number,
    patientId: Schema.String,
  }),
  riskTier: "low",
  targetObjectTypeId: "Patient",
});

export const SetValvePositionAction: ActionType = defineActionType({
  defaultExecutionMode: "proposal",
  description:
    "Adjust secondary clarifier return sludge valve opening percentage",
  id: "set_valve_position",
  minimumAgentTier: 2,
  mutation: (params, ctx) =>
    Effect.map(
      ctx.getObject("ClarifierTank" as ObjectTypeId, params.tankId),
      (tank) =>
        tank
          ? [
              {
                ...tank,
                lastModifiedAt: ctx.now,
                properties: {
                  ...tank.properties,
                  openingPercent: params.openingPercent,
                },
                version: tank.version + 1,
              },
            ]
          : []
    ),
  name: "Set Valve Position",
  parametersSchema: Schema.Struct({
    openingPercent: Schema.Number,
    tankId: Schema.String,
  }),
  riskTier: "medium",
  targetObjectTypeId: "ClarifierTank",
});

export const AdjustDoseAction: ActionType = defineActionType({
  defaultExecutionMode: "proposal",
  description: "Adjust clinical insulin dose for hospitalized patient",
  id: "adjust_dose",
  minimumAgentTier: 2,
  mutation: (params, ctx) =>
    Effect.map(
      ctx.getObject("Patient" as ObjectTypeId, params.patientId),
      (patient) =>
        patient
          ? [
              {
                ...patient,
                lastModifiedAt: ctx.now,
                properties: {
                  ...patient.properties,
                  currentDose: params.recommendedDose,
                },
                version: patient.version + 1,
              },
            ]
          : []
    ),
  name: "Adjust Dose",
  parametersSchema: Schema.Struct({
    patientId: Schema.String,
    recommendedDose: Schema.Number,
  }),
  riskTier: "high",
  targetObjectTypeId: "Patient",
});

export interface OperonRuntimeContext {
  readonly objectStore: InMemoryObjectStore | SqlBitemporalStore;
  readonly auditStore: InMemoryAuditStore;
  readonly inbox: ActionInbox;
  readonly oms: OntologyMetadataService;
  readonly securityEngine: DynamicSecurityEngine;
  readonly sandbox: SandboxedModelRunner;
  readonly objectTypes: readonly ObjectType<any>[];
  readonly actionTypes: readonly ActionType[];
  readonly linkTypes: readonly LinkType[];
  readonly ingestion: AccountableIngestionService;
  readonly reconciliation: ReconciliationService;
  readonly close: () => void;
}

const noopClose = () => undefined;

export async function createRuntimeContext(
  dbPath?: string
): Promise<OperonRuntimeContext> {
  const auditStore = new InMemoryAuditStore();
  const oms = new OntologyMetadataService();
  const securityEngine = new DynamicSecurityEngine();
  const sandbox = new SandboxedModelRunner();

  // Register deterministic demo model
  sandbox.registerModel({
    compute: (inputs: Record<string, unknown>) =>
      Effect.succeed({
        prediction: ((inputs.value as number) || 0) * 1.5,
        status: "computed",
      }),
    isDeterministic: true,
    modelId: "predictive_vibration_model",
    requiredInputs: ["value"],
    timeoutMs: 2000,
    version: "1.0.0",
  });

  const objectTypes = [PatientType, ClarifierTankType, AircraftTwinType];
  const actionTypes = [
    UpdateVitalsAction,
    SetValvePositionAction,
    AdjustDoseAction,
  ];
  const linkTypes = [PatientObservationLink];

  let objectStore: InMemoryObjectStore | SqlBitemporalStore;
  let close = noopClose;
  const targetDbPath = dbPath || process.env.OPERON_DATABASE_URL;

  if (targetDbPath) {
    const driver = new NativeSqliteDriver(targetDbPath);
    objectStore = new SqlBitemporalStore(driver, "sqlite");
    close = () => {
      driver.close();
    };
  } else {
    objectStore = new InMemoryObjectStore();
  }

  // Seed default objects if empty
  const patient = await Effect.runPromise(
    objectStore.getObject(PatientType.id, "P001")
  );
  if (!patient) {
    await Effect.runPromise(
      objectStore.putObject({
        id: "P001",
        lastModifiedAt: Date.now(),
        properties: {
          currentDose: 14,
          egfr: 52,
          name: "Zhang Minghua",
          room: "302-A",
        },
        typeId: PatientType.id,
        version: 1,
      })
    );
    await Effect.runPromise(
      objectStore.putObject({
        id: "tank-alpha",
        lastModifiedAt: Date.now(),
        properties: {
          effluentTss: 12.5,
          sludgeDepth: 1.8,
          status: "normal",
        },
        typeId: ClarifierTankType.id,
        version: 1,
      })
    );
    await Effect.runPromise(
      objectStore.putObject({
        id: "F-WZNW",
        lastModifiedAt: Date.now(),
        properties: {
          flightHours: 3420,
          model: "A350-900",
          tailNumber: "F-WZNW",
          turbineVibration: 14.2,
        },
        typeId: AircraftTwinType.id,
        version: 1,
      })
    );
  }

  const inbox = new ActionInbox(auditStore, objectStore);
  const ingestion = new AccountableIngestionService(objectStore);
  const reconciliation = ReconciliationService.make();

  const stateFile =
    process.env.OPERON_STATE_PATH ||
    (targetDbPath
      ? `${targetDbPath}.state.json`
      : path.join(process.cwd(), ".operon-cli-state.json"));

  const isPersisted = process.env.OPERON_IN_MEMORY !== "true";

  if (isPersisted && fs.existsSync(stateFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      if (Array.isArray(data.decisions) && data.decisions.length > 0) {
        const auditAny = auditStore as any;
        auditAny.decisions.push(...data.decisions);
        auditAny.lastHash = data.decisions.at(-1)?.recordHash;
      }
      if (Array.isArray(data.overrides)) {
        const auditAny = auditStore as any;
        auditAny.overrides.push(...data.overrides);
      }
      if (Array.isArray(data.proposals)) {
        const proposalMap = (inbox as any).proposals as Map<string, any>;
        for (const p of data.proposals) {
          const actionType =
            actionTypes.find((a) => a.id === p.actionTypeId) ??
            UpdateVitalsAction;
          proposalMap.set(p.id, {
            claimedAt: p.claimedAt,
            claimedBy: p.claimedBy,
            createdAt: p.createdAt,
            decisionRecord: p.decisionRecord,
            evidenceHash: p.evidenceHash,
            expiresAt: p.expiresAt,
            id: p.id,
            proposerId: p.proposerId,
            status: p.status,
            submission: {
              actionType,
              rawParameters: p.rawParameters,
              security: p.security,
            },
          });
        }
      }
      if (data.oms) {
        oms.importSnapshot(data.oms);
      }
      if (data.ingestion) {
        ingestion.importSnapshot(data.ingestion);
      }
      if (data.reconciliation) {
        reconciliation.importSnapshot(data.reconciliation);
      }
    } catch {
      // Ignore corrupted state file
    }
  }

  const enhancedClose = () => {
    close();
    if (isPersisted) {
      try {
        const proposalMap = (inbox as any).proposals as Map<string, any>;
        const proposalsToSave = proposalMap
          ? [...proposalMap.values()].map((item) => ({
              actionTypeId: item.submission?.actionType?.id,
              claimedAt: item.claimedAt,
              claimedBy: item.claimedBy,
              createdAt: item.createdAt,
              decisionRecord: item.decisionRecord,
              evidenceHash: item.evidenceHash,
              expiresAt: item.expiresAt,
              id: item.id,
              proposerId: item.proposerId,
              rawParameters: item.submission?.rawParameters,
              security: item.submission?.security,
              status: item.status,
            }))
          : [];

        const payload = {
          decisions: (auditStore as any).decisions ?? [],
          ingestion: ingestion.exportSnapshot(),
          oms: oms.exportSnapshot(),
          overrides: (auditStore as any).overrides ?? [],
          proposals: proposalsToSave,
          reconciliation: reconciliation.exportSnapshot(),
        };

        fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), "utf-8");
      } catch {
        // Best effort persist
      }
    }
  };

  return {
    actionTypes,
    auditStore,
    close: enhancedClose,
    inbox,
    ingestion,
    linkTypes,
    objectStore,
    objectTypes,
    oms,
    reconciliation,
    sandbox,
    securityEngine,
  };
}

export function createSubject(
  id = "operator",
  type: "user" | "agent" = "agent",
  roles: string[] = ["clinician", "operator"],
  tier: 1 | 2 | 3 | 4 = 2
): Subject {
  return {
    agentTier: type === "agent" ? tier : undefined,
    id,
    name: id.toUpperCase(),
    roles,
    type,
  };
}
