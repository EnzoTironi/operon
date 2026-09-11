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
  ActionType,
  ApprovalRecord,
  DiagnosticBundle,
  ExactQueryRequest,
  ObjectInstance,
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
  readonly actionTypes: readonly ActionType<any>[];
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

export interface ObjectTypeAccessor<T = Record<string, unknown>> {
  readonly get: (id: string) => Effect.Effect<ObjectInstance<T> | undefined>;
  readonly list: (
    predicate?: (instance: ObjectInstance<T>) => boolean
  ) => Effect.Effect<readonly ObjectInstance<T>[]>;
  readonly set: () => ObjectSet;
}

export interface ActionAccessor<Params = unknown> {
  readonly execute: (
    params: Params,
    security?: SecurityContext
  ) => Effect.Effect<ActionExecutionResult, unknown>;
}

export interface OperonClient {
  readonly actions: Record<string, ActionAccessor<any>>;
  readonly objects: Record<string, ObjectTypeAccessor<any>>;
  readonly oss: ObjectSetService;
  readonly query: (
    request: ExactQueryRequest,
    options?: QueryOptions
  ) => Effect.Effect<
    {
      readonly rows: readonly ObjectInstance[];
      readonly coverage: QueryCoverage;
      readonly worldView: WorldView;
      readonly cursor: string | null;
    },
    StaleDependencyError
  >;
  readonly reconciliation: ReconciliationService;
  readonly authority: AuthorityService;
  readonly governedActions: GovernedActionService;
  readonly atomicCommit: AtomicCommitService;
  readonly operonService: OperonService;
  readonly prepareAction: (
    actionId: string,
    params: unknown,
    options?: {
      grantId?: string;
      ttlMs?: number;
      tenantId?: string;
      environmentId?: string;
    }
  ) => Effect.Effect<PreparedAction, unknown>;
  readonly approveAction: (input: {
    preparedDigest: string;
    viewedDigest: string;
    decision?: "approved" | "rejected";
    reason?: string;
  }) => Effect.Effect<ApprovalRecord, unknown>;
  readonly commitAction: (input: {
    preparedDigest: string;
    approvalId?: string;
    idempotencyKey: string;
  }) => Effect.Effect<OperationReceipt, unknown>;
  readonly diagnose: (
    runId: string
  ) => Effect.Effect<DiagnosticBundle, unknown, never>;
}

export function createOperonClient(config: OperonClientConfig): OperonClient {
  const oss = new ObjectSetService(config.objectStore);
  const reconciliation =
    config.reconciliationService ?? ReconciliationService.make();
  const objects: Record<string, ObjectTypeAccessor<any>> = {};
  const actions: Record<string, ActionAccessor<any>> = {};

  for (const ot of config.objectTypes) {
    objects[ot.id] = {
      get: (id: string) =>
        config.objectStore.getObject(ot.id, id).pipe(
          Effect.map((inst) => {
            if (!inst) return undefined;
            if (config.securityEngine && config.defaultSecurity) {
              if (
                !config.securityEngine.canRead(
                  inst,
                  config.defaultSecurity.subject
                )
              ) {
                return undefined;
              }
              return config.securityEngine.projectInstance(
                inst,
                config.defaultSecurity.subject
              );
            }
            return inst;
          })
        ) as Effect.Effect<ObjectInstance<any> | undefined>,
      list: (predicate?: (instance: ObjectInstance<any>) => boolean) =>
        config.objectStore.findObjects(ot.id, predicate).pipe(
          Effect.map((instances) => {
            if (config.securityEngine && config.defaultSecurity) {
              const filtered = instances.filter((inst) =>
                config.securityEngine!.canRead(
                  inst,
                  config.defaultSecurity!.subject
                )
              );
              return filtered.map((inst) =>
                config.securityEngine!.projectInstance(
                  inst,
                  config.defaultSecurity!.subject
                )
              );
            }
            return instances;
          })
        ) as Effect.Effect<readonly ObjectInstance<any>[]>,
      set: () => oss.getSet(ot.id),
    };
  }

  for (const act of config.actionTypes) {
    actions[act.id] = {
      execute: (params: unknown, security?: SecurityContext) => {
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

  const query = (request: ExactQueryRequest, options?: QueryOptions) =>
    reconciliation.query(request, config.objectStore, options);

  const authority = config.authorityService ?? new AuthorityService();
  const actionTypesMap = new Map<string, ActionType<any>>();
  for (const act of config.actionTypes) {
    actionTypesMap.set(act.id, act);
  }

  const governedActions =
    config.governedActionService ??
    new GovernedActionService(
      config.actionTypes,
      config.objectStore,
      authority
    );

  const atomicCommit =
    config.atomicCommitService ??
    new AtomicCommitService(
      actionTypesMap,
      config.objectStore,
      config.auditStore,
      authority
    );

  const defaultTenantId = config.tenantId ?? "default";
  const defaultEnvironmentId = config.environmentId ?? "default";

  const operonService =
    config.operonService ??
    new OperonServiceImpl(
      governedActions,
      atomicCommit,
      authority,
      reconciliation,
      config.objectStore
    );

  const prepareAction = (
    actionId: string,
    params: unknown,
    options?: {
      grantId?: string;
      ttlMs?: number;
      tenantId?: string;
      environmentId?: string;
    }
  ) => {
    const effectiveSecurity = config.defaultSecurity;
    if (!effectiveSecurity) {
      return Effect.fail(
        new AuthorizationError({
          reason: "SecurityContext required: defaultSecurity is not configured",
        })
      );
    }
    return governedActions.prepareAction({
      actionId,
      environmentId: options?.environmentId ?? defaultEnvironmentId,
      grantId: options?.grantId,
      proposer: effectiveSecurity.subject,
      rawParameters: params,
      tenantId: options?.tenantId ?? defaultTenantId,
      ttlMs: options?.ttlMs,
    });
  };

  const approveAction = (input: {
    preparedDigest: string;
    viewedDigest: string;
    decision?: "approved" | "rejected";
    reason?: string;
  }) => {
    const effectiveSecurity = config.defaultSecurity;
    if (!effectiveSecurity) {
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
        reviewer: effectiveSecurity.subject,
        tenantId: defaultTenantId,
      },
      viewedDigest: input.viewedDigest,
    });
  };

  const commitAction = (input: {
    preparedDigest: string;
    approvalId?: string;
    idempotencyKey: string;
  }) =>
    governedActions
      .getPreparedAction(input.preparedDigest, defaultTenantId)
      .pipe(
        Effect.flatMap((prepared) => {
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
        })
      );

  return {
    actions,
    approveAction,
    atomicCommit,
    authority,
    commitAction,
    diagnose: (runId: string) => operonService.diagnose(runId),
    governedActions,
    objects,
    operonService,
    oss,
    prepareAction,
    query,
    reconciliation,
  };
}
