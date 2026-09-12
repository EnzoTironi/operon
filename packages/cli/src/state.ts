import {
  AccountableIngestionService,
  ActionInbox,
  AtomicCommitService,
  AuthorityService,
  DynamicSecurityEngine,
  GovernedActionService,
  InMemoryAuditStore,
  InMemoryObjectStore,
  NativeSqliteDriver,
  OntologyMetadataService,
  OperonServiceImpl,
  PostgresDriver,
  ReconciliationService,
  SandboxedModelRunner,
  SqlBitemporalStore,
  isPostgresUrl,
} from "@operon/runtime";
import type {
  DecisionRecord,
  InMemoryAuditSnapshot,
  InMemoryObjectSnapshot,
  OperonService,
  OverrideRecord,
  SerializedProposal,
} from "@operon/runtime";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
  parseJson,
  serializeJson,
} from "@operon/schema";
import type { ActionType, LinkType, ObjectType, Subject } from "@operon/schema";
import { Config, Effect, Exit, Option, Redacted, Schema, Scope } from "effect";

import {
  fileExistsSync,
  joinPath,
  readTextFileSync,
  writeTextFileSync,
} from "./fs-io.js";

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

export const UpdateVitalsAction = defineActionType({
  defaultExecutionMode: "automated",
  description: "Record and update patient vital signs",
  id: "update_vitals",
  minimumAgentTier: 1,
  mutation: (params, ctx) =>
    Effect.map(ctx.getObject(PatientType.id, params.patientId), (p) =>
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

export const SetValvePositionAction = defineActionType({
  defaultExecutionMode: "proposal",
  description:
    "Adjust secondary clarifier return sludge valve opening percentage",
  id: "set_valve_position",
  minimumAgentTier: 2,
  mutation: (params, ctx) =>
    Effect.map(ctx.getObject(ClarifierTankType.id, params.tankId), (tank) =>
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

export const AdjustDoseAction = defineActionType({
  defaultExecutionMode: "proposal",
  description: "Adjust clinical insulin dose for hospitalized patient",
  id: "adjust_dose",
  minimumAgentTier: 2,
  mutation: (params, ctx) =>
    Effect.map(ctx.getObject(PatientType.id, params.patientId), (patient) =>
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

export type RuntimeContext = OperonRuntimeContext;

export interface OperonRuntimeContext {
  readonly objectStore: InMemoryObjectStore | SqlBitemporalStore;
  readonly auditStore: InMemoryAuditStore;
  readonly inbox: ActionInbox;
  readonly oms: OntologyMetadataService;
  readonly securityEngine: DynamicSecurityEngine;
  readonly sandbox: SandboxedModelRunner;
  readonly objectTypes: readonly ObjectType[];
  readonly actionTypes: readonly ActionType[];
  readonly linkTypes: readonly LinkType[];
  readonly ingestion: AccountableIngestionService;
  readonly reconciliation: ReconciliationService;
  readonly authority: AuthorityService;
  readonly governedActions: GovernedActionService;
  readonly atomicCommit: AtomicCommitService;
  readonly operonService: OperonService;
  readonly database: DatabaseTarget;
  readonly close: () => Promise<void>;
}

function registerDefaultModels(sandbox: SandboxedModelRunner): void {
  sandbox.registerModel({
    compute: (inputs) => {
      const num = Number(inputs["value"]) || 0;
      return Effect.succeed({
        prediction: num * 1.5,
        status: "computed",
      });
    },
    isDeterministic: true,
    modelId: "predictive_vibration_model",
    requiredInputs: ["value"],
    timeoutMs: 2000,
    version: "1.0.0",
  });
}

/**
 * Where the object store lives. Parsed once from `--db` or
 * `OPERON_DATABASE_URL`: a Postgres URL selects the cell database, any other
 * value is a SQLite file path, nothing means in-memory.
 */
export type DatabaseTarget =
  | { readonly kind: "memory" }
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "postgres"; readonly url: Redacted.Redacted<string> };

function parseDatabaseTarget(value: string): DatabaseTarget {
  return isPostgresUrl(value)
    ? { kind: "postgres", url: Redacted.make(value) }
    : { kind: "sqlite", path: value };
}

export function resolveDatabaseTarget(dbPath?: string): DatabaseTarget {
  if (dbPath) {
    return parseDatabaseTarget(dbPath);
  }
  // Read live so a caller that sets the variable after startup is honoured.
  const envDbUrl = process.env.OPERON_DATABASE_URL;
  return envDbUrl ? parseDatabaseTarget(envDbUrl) : { kind: "memory" };
}

function resolveStateFilePath(target: DatabaseTarget): string {
  const envStatePath = Effect.runSync(
    Effect.option(Config.string("OPERON_STATE_PATH"))
  );
  const statePath = Option.getOrUndefined(envStatePath);
  if (statePath) {
    return statePath;
  }
  if (target.kind === "sqlite") {
    return `${target.path}.state.json`;
  }
  return joinPath(process.cwd(), ".operon-cli-state.json");
}

function isPersistenceEnabled(): boolean {
  const envInMemory = Effect.runSync(
    Effect.option(Config.string("OPERON_IN_MEMORY"))
  );
  return Option.getOrUndefined(envInMemory) !== "true";
}

interface DbStoreResult {
  readonly objectStore: InMemoryObjectStore | SqlBitemporalStore;
  readonly close: () => Promise<void>;
}

const openPostgresStore = Effect.fn("openPostgresStore")(function* (
  url: Redacted.Redacted<string>
) {
  const scope = yield* Scope.make();
  const driver = yield* PostgresDriver.connect({ url }).pipe(
    Scope.provide(scope)
  );
  return {
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    objectStore: new SqlBitemporalStore(driver, "postgres"),
  } satisfies DbStoreResult;
});

function createDbStore(target: DatabaseTarget): Promise<DbStoreResult> {
  switch (target.kind) {
    case "postgres": {
      return Effect.runPromise(openPostgresStore(target.url));
    }
    case "sqlite": {
      const driver = new NativeSqliteDriver(target.path);
      return Promise.resolve({
        close: () => {
          driver.close();
          return Promise.resolve();
        },
        objectStore: new SqlBitemporalStore(driver, "sqlite"),
      });
    }
    case "memory": {
      return Promise.resolve({
        close: () => Promise.resolve(),
        objectStore: new InMemoryObjectStore(),
      });
    }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

async function seedDefaultObjects(
  objectStore: InMemoryObjectStore | SqlBitemporalStore
): Promise<void> {
  const patient = await Effect.runPromise(
    objectStore.getObject(PatientType.id, "P001")
  );
  if (patient) {
    return;
  }
  const now = Date.now();
  await Effect.runPromise(
    objectStore.putObject({
      id: "P001",
      lastModifiedAt: now,
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
      lastModifiedAt: now,
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
      lastModifiedAt: now,
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

interface CliStatePayload {
  readonly atomicCommit?: Parameters<AtomicCommitService["importSnapshot"]>[0];
  readonly authority?: Parameters<AuthorityService["importSnapshot"]>[0];
  readonly audit?: InMemoryAuditSnapshot;
  readonly decisions?: readonly DecisionRecord[];
  readonly governedActions?: Parameters<
    GovernedActionService["importSnapshot"]
  >[0];
  readonly ingestion?: Parameters<
    AccountableIngestionService["importSnapshot"]
  >[0];
  readonly objects?: InMemoryObjectSnapshot;
  readonly oms?: Parameters<OntologyMetadataService["importSnapshot"]>[0];
  readonly overrides?: readonly OverrideRecord[];
  readonly proposals?: readonly SerializedProposal[];
  readonly reconciliation?: Parameters<
    ReconciliationService["importSnapshot"]
  >[0];
}

interface RuntimeStores {
  readonly actionTypes: readonly ActionType[];
  readonly atomicCommit: AtomicCommitService;
  readonly auditStore: InMemoryAuditStore;
  readonly authority: AuthorityService;
  readonly governedActions: GovernedActionService;
  readonly inbox: ActionInbox;
  readonly ingestion: AccountableIngestionService;
  readonly objectStore: InMemoryObjectStore | SqlBitemporalStore;
  readonly oms: OntologyMetadataService;
  readonly reconciliation: ReconciliationService;
}

function restoreAuditAndInbox(
  data: CliStatePayload,
  auditStore: InMemoryAuditStore,
  inbox: ActionInbox,
  actionTypes: readonly ActionType[]
): void {
  if (data.audit) {
    auditStore.importSnapshot(data.audit);
  } else if (data.decisions && data.decisions.length > 0) {
    auditStore.importSnapshot({
      decisions: data.decisions,
      overrides: data.overrides,
    });
  }
  if (data.proposals) {
    inbox.restoreProposalSnapshots(data.proposals, actionTypes);
  }
}

function restoreOntologyServices(
  data: CliStatePayload,
  stores: Pick<RuntimeStores, "ingestion" | "oms" | "reconciliation">
): void {
  if (data.oms) {
    stores.oms.importSnapshot(data.oms);
  }
  if (data.ingestion) {
    stores.ingestion.importSnapshot(data.ingestion);
  }
  if (data.reconciliation) {
    stores.reconciliation.importSnapshot(data.reconciliation);
  }
}

function restoreDomainServices(
  data: CliStatePayload,
  stores: Pick<RuntimeStores, "atomicCommit" | "authority" | "governedActions">
): void {
  if (data.authority) {
    stores.authority.importSnapshot(data.authority);
  }
  if (data.governedActions) {
    stores.governedActions.importSnapshot(data.governedActions);
  }
  if (data.atomicCommit) {
    stores.atomicCommit.importSnapshot(data.atomicCommit);
  }
}

function restoreRuntimeState(stateFile: string, stores: RuntimeStores): void {
  if (!fileExistsSync(stateFile)) {
    return;
  }
  try {
    // SAFETY: stateFile is parsed as structured CliStatePayload for initialization
    const data = parseJson(readTextFileSync(stateFile)) as CliStatePayload;
    restoreAuditAndInbox(
      data,
      stores.auditStore,
      stores.inbox,
      stores.actionTypes
    );
    if (data.objects && stores.objectStore instanceof InMemoryObjectStore) {
      stores.objectStore.importSnapshot(data.objects);
    }
    restoreOntologyServices(data, stores);
    restoreDomainServices(data, stores);
  } catch (error) {
    console.error("DEBUG RESTORE ERROR:", error);
  }
}

function persistRuntimeState(stateFile: string, stores: RuntimeStores): void {
  try {
    const payload: CliStatePayload = {
      atomicCommit: stores.atomicCommit.exportSnapshot(),
      audit: stores.auditStore.exportSnapshot(),
      authority: stores.authority.exportSnapshot(),
      decisions: stores.auditStore.exportSnapshot().decisions,
      governedActions: stores.governedActions.exportSnapshot(),
      ingestion: stores.ingestion.exportSnapshot(),
      objects:
        stores.objectStore instanceof InMemoryObjectStore
          ? stores.objectStore.exportSnapshot()
          : undefined,
      oms: stores.oms.exportSnapshot(),
      overrides: stores.auditStore.exportSnapshot().overrides,
      proposals: stores.inbox.listProposalSnapshots(),
      reconciliation: stores.reconciliation.exportSnapshot(),
    };
    writeTextFileSync(stateFile, serializeJson(payload));
  } catch (error) {
    console.error("DEBUG PERSIST ERROR:", error);
  }
}

function isActionTypeArray(
  actions: readonly object[]
): actions is readonly ActionType[] {
  return actions.every(
    (a) => "id" in a && "parametersSchema" in a && "name" in a
  );
}

export async function createRuntimeContext(
  dbPath?: string
): Promise<OperonRuntimeContext> {
  const auditStore = new InMemoryAuditStore();
  const oms = new OntologyMetadataService();
  const securityEngine = new DynamicSecurityEngine();
  const sandbox = new SandboxedModelRunner();
  registerDefaultModels(sandbox);

  const objectTypes = [PatientType, ClarifierTankType, AircraftTwinType];
  const rawActions = [
    UpdateVitalsAction,
    SetValvePositionAction,
    AdjustDoseAction,
  ];
  const actionTypes: readonly ActionType[] = isActionTypeArray(rawActions)
    ? rawActions
    : [];
  const linkTypes = [PatientObservationLink];

  const target = resolveDatabaseTarget(dbPath);
  const dbConfig = await createDbStore(target);
  const objectStore = dbConfig.objectStore;

  const inbox = new ActionInbox(auditStore, objectStore);
  const ingestion = new AccountableIngestionService(objectStore);
  const reconciliation = ReconciliationService.make();
  const authority = new AuthorityService();

  const actionTypesMap = new Map<string, ActionType>();
  for (const a of actionTypes) {
    actionTypesMap.set(a.id, a);
  }

  const governedActions = new GovernedActionService(
    actionTypes,
    objectStore,
    authority
  );
  const atomicCommit = new AtomicCommitService({
    actionTypes: actionTypesMap,
    auditStore,
    authorityService: authority,
    objectStore,
  });
  const operonService = new OperonServiceImpl({
    atomicCommitService: atomicCommit,
    authorityService: authority,
    governedActionService: governedActions,
    objectStore,
    reconciliationService: reconciliation,
  });

  const stateFile = resolveStateFilePath(target);
  const isPersisted = isPersistenceEnabled();
  const stores: RuntimeStores = {
    actionTypes,
    atomicCommit,
    auditStore,
    authority,
    governedActions,
    inbox,
    ingestion,
    objectStore,
    oms,
    reconciliation,
  };

  if (isPersisted) {
    restoreRuntimeState(stateFile, stores);
  }

  await seedDefaultObjects(objectStore);

  const enhancedClose = () => {
    if (isPersisted) {
      persistRuntimeState(stateFile, stores);
    }
    return dbConfig.close();
  };

  return {
    ...stores,
    close: enhancedClose,
    database: target,
    linkTypes,
    objectTypes,
    operonService,
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
