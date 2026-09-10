import type {
  ActionExecutionResult,
  AuditStore,
  DynamicSecurityEngine,
  ObjectSet,
  ObjectStore,
  QueryOptions,
  StaleDependencyError,
} from "@operon/runtime";
import {
  AuthorizationError,
  executeWritePipeline,
  ObjectSetService,
  ReconciliationService,
} from "@operon/runtime";
import type {
  ActionType,
  ExactQueryRequest,
  ObjectInstance,
  ObjectType,
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

  return { actions, objects, oss, query, reconciliation };
}
