import type {
  ActionExecutionResult,
  AuditStore,
  DynamicSecurityEngine,
  ObjectSet,
  ObjectStore,
  OperonService,
  QueryOptions,
  StaleDependencyError,
} from "@operon/runtime";
import {
  AtomicCommitService,
  AuthorityService,
  AuthorizationError,
  executeWritePipeline,
  GovernedActionService,
  ObjectSetService,
  OperonServiceImpl,
  ReconciliationService,
} from "@operon/runtime";
import type {
  ActionParameters,
  ActionType,
  ApprovalRecord,
  DiagnosticBundle,
  ExactQueryRequest,
  ObjectInstance,
  ObjectProperties,
  ObjectType,
  OperationReceipt,
  PreparedAction,
  QueryCoverage,
  SecurityContext,
  WorldView,
} from "@operon/schema";
import { Effect } from "effect";

export interface OperonClientConfig {
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly objectTypes: readonly ObjectType[];
  readonly actionTypes: readonly ActionType[];
  readonly defaultSecurity?: SecurityContext;
  readonly securityEngine?: DynamicSecurityEngine;
  readonly reconciliationService?: ReconciliationService;
  readonly authorityService?: AuthorityService;
  readonly governedActionService?: GovernedActionService;
  readonly atomicCommitService?: AtomicCommitService;
  readonly operonService?: OperonService;
  readonly tenantId?: string;
  readonly environmentId?: string;
}

export interface ObjectTypeAccessor<T = ObjectProperties> {
  readonly get: (id: string) => Effect.Effect<ObjectInstance<T> | undefined>;
  readonly list: (
    predicate?: (instance: ObjectInstance<T>) => boolean
  ) => Effect.Effect<readonly ObjectInstance<T>[]>;
  readonly set: () => ObjectSet;
}

export interface ActionAccessor<Params = ActionParameters> {
  readonly execute: (
    params: Params,
    security?: SecurityContext
  ) => Effect.Effect<ActionExecutionResult, unknown>;
}

export interface PrepareActionOptions {
  readonly grantId?: string;
  readonly ttlMs?: number;
  readonly tenantId?: string;
  readonly environmentId?: string;
}

export interface ApproveActionInput {
  readonly preparedDigest: string;
  readonly viewedDigest: string;
  readonly decision?: "approved" | "rejected";
  readonly reason?: string;
}

export interface CommitActionInput {
  readonly preparedDigest: string;
  readonly approvalId?: string;
  readonly idempotencyKey: string;
}

export interface QueryResult {
  readonly rows: readonly ObjectInstance[];
  readonly coverage: QueryCoverage;
  readonly worldView: WorldView;
  readonly cursor: string | null;
}

export type ObjectAccessorMap = Record<string, ObjectTypeAccessor>;
export type ActionAccessorMap = Record<string, ActionAccessor>;

export interface OperonClient {
  readonly actions: ActionAccessorMap;
  readonly objects: ObjectAccessorMap;
  readonly oss: ObjectSetService;
  readonly query: (
    request: ExactQueryRequest,
    options?: QueryOptions
  ) => Effect.Effect<QueryResult, StaleDependencyError>;
  readonly reconciliation: ReconciliationService;
  readonly authority: AuthorityService;
  readonly governedActions: GovernedActionService;
  readonly atomicCommit: AtomicCommitService;
  readonly operonService: OperonService;
  readonly prepareAction: (
    actionId: string,
    params: ActionParameters,
    options?: PrepareActionOptions
  ) => Effect.Effect<PreparedAction, unknown>;
  readonly approveAction: (
    input: ApproveActionInput
  ) => Effect.Effect<ApprovalRecord, unknown>;
  readonly commitAction: (
    input: CommitActionInput
  ) => Effect.Effect<OperationReceipt, unknown>;
  readonly diagnose: (
    runId: string
  ) => Effect.Effect<DiagnosticBundle, unknown, never>;
}

function projectInstanceIfAllowed(
  inst: ObjectInstance | undefined,
  securityEngine?: DynamicSecurityEngine,
  defaultSecurity?: SecurityContext
): ObjectInstance | undefined {
  if (!inst || !securityEngine || !defaultSecurity) {
    return inst;
  }
  return securityEngine.canRead(inst, defaultSecurity.subject)
    ? securityEngine.projectInstance(inst, defaultSecurity.subject)
    : undefined;
}

function projectInstancesIfAllowed(
  instances: readonly ObjectInstance[],
  securityEngine?: DynamicSecurityEngine,
  defaultSecurity?: SecurityContext
): readonly ObjectInstance[] {
  if (!securityEngine || !defaultSecurity) {
    return instances;
  }
  const filtered = instances.filter((inst) =>
    securityEngine.canRead(inst, defaultSecurity.subject)
  );
  return filtered.map((inst) =>
    securityEngine.projectInstance(inst, defaultSecurity.subject)
  );
}

function buildObjectAccessors(
  config: OperonClientConfig,
  oss: ObjectSetService
) {
  const objects: Record<string, ObjectTypeAccessor> = {};
  for (const ot of config.objectTypes) {
    objects[ot.id] = {
      get: (id: string) =>
        config.objectStore
          .getObject(ot.id, id)
          .pipe(
            Effect.map((inst) =>
              projectInstanceIfAllowed(
                inst,
                config.securityEngine,
                config.defaultSecurity
              )
            )
          ),
      list: (predicate?: (instance: ObjectInstance) => boolean) =>
        config.objectStore
          .findObjects(ot.id, predicate)
          .pipe(
            Effect.map((instances) =>
              projectInstancesIfAllowed(
                instances,
                config.securityEngine,
                config.defaultSecurity
              )
            )
          ),
      set: () => oss.getSet(ot.id),
    };
  }
  return objects;
}

function buildActionAccessors(config: OperonClientConfig) {
  const actions: Record<string, ActionAccessor> = {};
  for (const act of config.actionTypes) {
    actions[act.id] = {
      execute: (params: ActionParameters, security?: SecurityContext) => {
        const effectiveSecurity = security ?? config.defaultSecurity;
        if (!effectiveSecurity) {
          return Effect.fail(
            new AuthorizationError({
              reason:
                "SecurityContext required for action execution: neither explicit security nor defaultSecurity was configured",
            })
          );
        }
        return executeWritePipeline(
          {
            actionType: act,
            rawParameters: params,
            security: effectiveSecurity,
          },
          config.objectStore,
          config.auditStore
        );
      },
    };
  }
  return actions;
}

function buildActionTypesMap(
  actionTypes: readonly ActionType[]
): Map<string, ActionType> {
  const map = new Map<string, ActionType>();
  for (const act of actionTypes) {
    map.set(act.id, act);
  }
  return map;
}

interface ResolvedServices {
  readonly reconciliation: ReconciliationService;
  readonly authority: AuthorityService;
  readonly governedActions: GovernedActionService;
  readonly atomicCommit: AtomicCommitService;
  readonly operonService: OperonService;
}

function resolveServices(
  config: OperonClientConfig,
  actionTypesMap: Map<string, ActionType>
): ResolvedServices {
  const reconciliation =
    config.reconciliationService ?? ReconciliationService.make();
  const authority = config.authorityService ?? new AuthorityService();
  const governedActions =
    config.governedActionService ??
    new GovernedActionService(
      config.actionTypes,
      config.objectStore,
      authority
    );
  const atomicCommit =
    config.atomicCommitService ??
    new AtomicCommitService({
      actionTypes: actionTypesMap,
      auditStore: config.auditStore,
      authorityService: authority,
      objectStore: config.objectStore,
    });
  const operonService =
    config.operonService ??
    new OperonServiceImpl({
      atomicCommitService: atomicCommit,
      authorityService: authority,
      governedActionService: governedActions,
      objectStore: config.objectStore,
      reconciliationService: reconciliation,
    });

  return {
    atomicCommit,
    authority,
    governedActions,
    operonService,
    reconciliation,
  };
}

function resolveEnvironmentId(
  options?: PrepareActionOptions,
  defaultId = "default"
): string {
  return options?.environmentId ?? defaultId;
}

function resolveTenantId(
  options?: PrepareActionOptions,
  defaultId = "default"
): string {
  return options?.tenantId ?? defaultId;
}

function buildPrepareAction(
  governedActions: GovernedActionService,
  defaultSecurity?: SecurityContext,
  defaultTenantId = "default",
  defaultEnvironmentId = "default"
) {
  return (
    actionId: string,
    params: ActionParameters,
    options?: PrepareActionOptions
  ) => {
    if (!defaultSecurity) {
      return Effect.fail(
        new AuthorizationError({
          reason: "SecurityContext required: defaultSecurity is not configured",
        })
      );
    }
    return governedActions.prepareAction({
      actionId,
      environmentId: resolveEnvironmentId(options, defaultEnvironmentId),
      grantId: options?.grantId,
      proposer: defaultSecurity.subject,
      rawParameters: params,
      tenantId: resolveTenantId(options, defaultTenantId),
      ttlMs: options?.ttlMs,
    });
  };
}

function buildApproveAction(
  governedActions: GovernedActionService,
  defaultSecurity?: SecurityContext,
  defaultTenantId = "default",
  defaultEnvironmentId = "default"
) {
  return (input: ApproveActionInput) => {
    if (!defaultSecurity) {
      return Effect.fail(
        new AuthorizationError({
          reason: "SecurityContext required: defaultSecurity is not configured",
        })
      );
    }
    return governedActions.approvePreparedAction({
      decision: input.decision ?? "approved",
      preparedDigest: input.preparedDigest,
      reason: input.reason,
      reviewerContext: {
        assurance: "human_verified",
        environmentId: defaultEnvironmentId,
        reviewer: defaultSecurity.subject,
        tenantId: defaultTenantId,
      },
      viewedDigest: input.viewedDigest,
    });
  };
}

interface ExecuteCommitWithPreparedOptions {
  readonly atomicCommit: AtomicCommitService;
  readonly governedActions: GovernedActionService;
  readonly prepared: PreparedAction;
  readonly input: CommitActionInput;
  readonly defaultTenantId: string;
  readonly defaultEnvironmentId: string;
}

function executeCommitWithPrepared(options: ExecuteCommitWithPreparedOptions) {
  const {
    atomicCommit,
    governedActions,
    prepared,
    input,
    defaultTenantId,
    defaultEnvironmentId,
  } = options;
  if (input.approvalId) {
    return governedActions
      .getApprovalRecord(input.approvalId, defaultTenantId)
      .pipe(
        Effect.flatMap((approval) =>
          atomicCommit.commit({
            approval,
            environmentId: defaultEnvironmentId,
            idempotencyKey: input.idempotencyKey,
            prepared,
            tenantId: defaultTenantId,
          })
        )
      );
  }
  return atomicCommit.commit({
    environmentId: defaultEnvironmentId,
    idempotencyKey: input.idempotencyKey,
    prepared,
    tenantId: defaultTenantId,
  });
}

function buildCommitAction(
  atomicCommit: AtomicCommitService,
  governedActions: GovernedActionService,
  defaultTenantId = "default",
  defaultEnvironmentId = "default"
) {
  return (input: CommitActionInput) =>
    governedActions
      .getPreparedAction(input.preparedDigest, defaultTenantId)
      .pipe(
        Effect.flatMap((prepared) =>
          executeCommitWithPrepared({
            atomicCommit,
            defaultEnvironmentId,
            defaultTenantId,
            governedActions,
            input,
            prepared,
          })
        )
      );
}

export function createOperonClient(config: OperonClientConfig): OperonClient {
  const oss = new ObjectSetService(config.objectStore);
  const actionTypesMap = buildActionTypesMap(config.actionTypes);
  const services = resolveServices(config, actionTypesMap);
  const defaultTenantId = config.tenantId ?? "default";
  const defaultEnvironmentId = config.environmentId ?? "default";

  return {
    actions: buildActionAccessors(config),
    approveAction: buildApproveAction(
      services.governedActions,
      config.defaultSecurity,
      defaultTenantId,
      defaultEnvironmentId
    ),
    atomicCommit: services.atomicCommit,
    authority: services.authority,
    commitAction: buildCommitAction(
      services.atomicCommit,
      services.governedActions,
      defaultTenantId,
      defaultEnvironmentId
    ),
    diagnose: (runId: string) => services.operonService.diagnose(runId),
    governedActions: services.governedActions,
    objects: buildObjectAccessors(config, oss),
    operonService: services.operonService,
    oss,
    prepareAction: buildPrepareAction(
      services.governedActions,
      config.defaultSecurity,
      defaultTenantId,
      defaultEnvironmentId
    ),
    query: (request: ExactQueryRequest, options?: QueryOptions) =>
      services.reconciliation.query(request, config.objectStore, options),
    reconciliation: services.reconciliation,
  };
}
