import type {
  AccessKey,
  GovernedAgentMemoryRecord,
  ReconstructableExecutionTrace,
} from "@operon/schema";
import { Clock, Context, Effect, Layer } from "effect";

import { MemoryAccessDeniedError } from "../actions-errors.js";

const FORBIDDEN_MEMORY_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  "approved",
  "approvalReceipt",
  "authorityElevated",
  "bypassReview",
  "isSystemAuthorized",
  "skipReview",
  "verdict",
]);

/**
 * Service governing agent memory and reconstructable execution traces per S12 & OPR-AGT-005
 */
export class GovernedMemoryService extends Context.Service<
  GovernedMemoryService,
  {
    readonly queryTenantMemories: (
      tenantId: string,
      accessKey: AccessKey,
      options?: { readonly mandateId?: string; readonly now?: number }
    ) => Effect.Effect<
      readonly GovernedAgentMemoryRecord[],
      MemoryAccessDeniedError
    >;

    readonly recordExecutionTrace: (
      trace: ReconstructableExecutionTrace
    ) => Effect.Effect<void, never>;

    readonly recordMemory: (
      record: GovernedAgentMemoryRecord,
      accessKey: AccessKey
    ) => Effect.Effect<GovernedAgentMemoryRecord, MemoryAccessDeniedError>;

    readonly reconstructExecutionTrace: (
      traceId: string
    ) => Effect.Effect<ReconstructableExecutionTrace | null, never>;

    readonly retrieveMemory: (
      memoryId: string,
      accessKey: AccessKey,
      now?: number
    ) => Effect.Effect<GovernedAgentMemoryRecord, MemoryAccessDeniedError>;
  }
>()("operon/runtime/GovernedMemoryService") {}

/**
 * Live implementation of GovernedMemoryService
 */
export const GovernedMemoryServiceLive = Layer.sync(
  GovernedMemoryService,
  () => {
    // Keyed by `${tenantId}:${memoryId}`
    const memoryStore = new Map<string, GovernedAgentMemoryRecord>();
    // Keyed by traceId
    const traceStore = new Map<string, ReconstructableExecutionTrace>();

    return GovernedMemoryService.of({
      queryTenantMemories: Effect.fn(
        "GovernedMemoryService.queryTenantMemories"
      )(function* (
        tenantId: string,
        accessKey: AccessKey,
        options?: { readonly mandateId?: string; readonly now?: number }
      ) {
        if (tenantId !== accessKey.tenantId) {
          return yield* 
            new MemoryAccessDeniedError({
              memoryId: "query",
              message: `Cross-tenant memory access prohibited: caller tenant '${accessKey.tenantId}' cannot query tenant '${tenantId}'`,
              reason: "TENANT_MISMATCH",
              tenantId,
            })
          ;
        }

        const now = options?.now ?? (yield* Clock.currentTimeMillis);
        const results: GovernedAgentMemoryRecord[] = [];

        for (const [key, record] of memoryStore.entries()) {
          if (key.startsWith(`${tenantId}:`)) {
            if (options?.mandateId && record.mandateId !== options.mandateId) {
              continue;
            }
            if (record.expiresAt !== undefined && now > record.expiresAt) {
              continue;
            }
            results.push(record);
          }
        }

        return results;
      }),

      recordExecutionTrace: Effect.fn(
        "GovernedMemoryService.recordExecutionTrace"
      )((trace: ReconstructableExecutionTrace) =>
        Effect.sync(() => {
          traceStore.set(trace.traceId, trace);
        })
      ),

      recordMemory: Effect.fn("GovernedMemoryService.recordMemory")(function* (
        record: GovernedAgentMemoryRecord,
        accessKey: AccessKey
      ) {
        // 1. Enforce tenant boundary
        if (record.tenantId !== accessKey.tenantId) {
          return yield* 
            new MemoryAccessDeniedError({
              memoryId: record.memoryId,
              message: `Cross-tenant memory write denied: record tenant '${record.tenantId}' does not match access key tenant '${accessKey.tenantId}'`,
              reason: "TENANT_MISMATCH",
              tenantId: record.tenantId,
            })
          ;
        }

        // 2. Enforce authority key immutability (memory cannot mint or store forged authority)
        const forbiddenKey = Object.keys(record.content).find((key) =>
          FORBIDDEN_MEMORY_AUTHORITY_KEYS.has(key)
        );
        if (forbiddenKey) {
          return yield* new MemoryAccessDeniedError({
            memoryId: record.memoryId,
            message: `Agent memory cannot store reserved authority key '${forbiddenKey}': memory cannot grant authority`,
            reason: "FORBIDDEN_AUTHORITY_INJECTION",
            tenantId: record.tenantId,
          });
        }

        const storeKey = `${record.tenantId}:${record.memoryId}`;
        memoryStore.set(storeKey, record);
        return record;
      }),

      reconstructExecutionTrace: Effect.fn(
        "GovernedMemoryService.reconstructExecutionTrace"
      )((traceId: string) =>
        Effect.sync(() => traceStore.get(traceId) ?? null)
      ),

      retrieveMemory: Effect.fn("GovernedMemoryService.retrieveMemory")(
        function* (memoryId: string, accessKey: AccessKey, nowParam?: number) {
          const now = nowParam ?? (yield* Clock.currentTimeMillis);
          const storeKey = `${accessKey.tenantId}:${memoryId}`;
          const record = memoryStore.get(storeKey);

          if (!record) {
            // Check if it exists under another tenant to detect cross-tenant attempt
            const crossTenantCandidate = [...memoryStore.values()].find(
              (candidate) =>
                candidate.memoryId === memoryId &&
                candidate.tenantId !== accessKey.tenantId
            );
            if (crossTenantCandidate) {
              return yield* new MemoryAccessDeniedError({
                memoryId,
                message: `Cross-tenant memory retrieval denied: memory '${memoryId}' belongs to a different tenant`,
                reason: "TENANT_MISMATCH",
                tenantId: crossTenantCandidate.tenantId,
              });
            }

            return yield* 
              new MemoryAccessDeniedError({
                memoryId,
                message: `Memory '${memoryId}' not found in tenant '${accessKey.tenantId}'`,
                reason: "TENANT_MISMATCH",
                tenantId: accessKey.tenantId,
              })
            ;
          }

          // Check expiration
          if (record.expiresAt !== undefined && now > record.expiresAt) {
            return yield* 
              new MemoryAccessDeniedError({
                memoryId,
                message: `Memory '${memoryId}' has expired (expiredAt: ${record.expiresAt}, now: ${now})`,
                reason: "EXPIRED",
                tenantId: record.tenantId,
              })
            ;
          }

          return record;
        }
      ),
    });
  }
);
