import { createHash } from "node:crypto";

import type {
  DependencyRecord,
  FunctionExecutionContext,
  MaterializedOutputRecord,
} from "@operon/schema";
import { Context, Effect, Layer, Schema } from "effect";

import {
  FunctionPermissionDeniedError,
  FunctionValidationError,
} from "../actions-errors.js";

/**
 * Definition of a pure, deterministic typed read function (OPR-FUN-001)
 */
export interface TypedReadFunction<TInput = unknown, TOutput = unknown> {
  readonly description: string;
  readonly execute: (
    input: TInput,
    ctx: FunctionExecutionContext
  ) => Effect.Effect<TOutput, never>;
  readonly functionId: string;
  readonly inputSchema: Schema.Decoder<any>;
  readonly isPure: true;
  readonly outputSchema: Schema.Decoder<any>;
  readonly requiredPermissions: readonly string[];
  readonly version: string;
}

/**
 * Staged edit candidate (OPR-FUN-002)
 */
export interface StagedEditMutation {
  readonly entityId: string;
  readonly entityType: string;
  readonly hasUndeclaredSideEffect?: boolean;
  readonly mutationType: "CREATE" | "UPDATE" | "DELETE";
  readonly payload: Record<string, unknown>;
}

/**
 * Service managing typed read functions, staged edit discipline, and materialization (OPR-FUN-001, 002, 003)
 */
export class TypedReadService extends Context.Service<
  TypedReadService,
  {
    readonly checkFreshness: (
      outputId: string,
      currentVersions: Record<string, string | number>
    ) => Effect.Effect<{
      readonly isStale: boolean;
      readonly staleDependencies: readonly string[];
    }>;

    readonly getAuditLineage: (
      outputId: string
    ) => Effect.Effect<MaterializedOutputRecord | undefined>;

    readonly getVisibleStagedEdits: () => Effect.Effect<
      readonly StagedEditMutation[]
    >;

    readonly invokeFunction: (
      functionId: string,
      rawInput: unknown,
      ctx: FunctionExecutionContext
    ) => Effect.Effect<
      unknown,
      FunctionPermissionDeniedError | FunctionValidationError
    >;

    readonly materializeOutput: (
      functionId: string,
      rawInput: unknown,
      ctx: FunctionExecutionContext,
      dependencies: readonly DependencyRecord[]
    ) => Effect.Effect<
      MaterializedOutputRecord,
      FunctionPermissionDeniedError | FunctionValidationError
    >;

    readonly registerFunction: (
      fn: TypedReadFunction
    ) => Effect.Effect<void, never>;

    readonly stageEdits: (
      mutations: readonly StagedEditMutation[],
      runner: (
        staged: readonly StagedEditMutation[]
      ) => Effect.Effect<void, Error>
    ) => Effect.Effect<
      { readonly committedCount: number },
      Error | FunctionValidationError
    >;
  }
>()("operon/runtime/TypedReadService") {}

function computeHash(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

/**
 * Live layer for TypedReadService
 */
export const TypedReadServiceLive = Layer.sync(TypedReadService, () => {
  const functions = new Map<string, TypedReadFunction>();
  const materializedStore = new Map<string, MaterializedOutputRecord>();
  let visibleCommittedEdits: StagedEditMutation[] = [];

  return TypedReadService.of({
    checkFreshness: Effect.fn("TypedReadService.checkFreshness")(
      (outputId: string, currentVersions: Record<string, string | number>) =>
        Effect.sync(() => {
          const record = materializedStore.get(outputId);
          if (!record) {
            return { isStale: true, staleDependencies: ["RECORD_NOT_FOUND"] };
          }

          const staleDependencies: string[] = [];
          for (const dep of record.dependencies) {
            const currentVer = currentVersions[dep.entityId];
            if (
              currentVer === undefined ||
              String(currentVer) !== String(dep.version)
            ) {
              staleDependencies.push(dep.entityId);
            }
          }

          const isStale = staleDependencies.length > 0;
          if (isStale && !record.isStale) {
            const updatedRecord: MaterializedOutputRecord = {
              ...record,
              isStale: true,
            };
            materializedStore.set(outputId, updatedRecord);
          }

          return {
            isStale,
            staleDependencies,
          };
        })
    ),

    getAuditLineage: Effect.fn("TypedReadService.getAuditLineage")(
      (outputId: string) => Effect.sync(() => materializedStore.get(outputId))
    ),

    getVisibleStagedEdits: Effect.fn("TypedReadService.getVisibleStagedEdits")(
      () => Effect.sync(() => visibleCommittedEdits)
    ),

    invokeFunction: Effect.fn("TypedReadService.invokeFunction")(function* (
      functionId: string,
      rawInput: unknown,
      ctx: FunctionExecutionContext
    ) {
      const fn = functions.get(functionId);
      if (!fn) {
        return yield* Effect.fail(
          new FunctionValidationError({
            errors: [`Function '${functionId}' is not registered`],
            functionId,
            message: `Function '${functionId}' not found`,
            phase: "INPUT_VALIDATION",
          })
        );
      }

      // 1. Check permissions (OPR-FUN-001)
      const missingPermissions = fn.requiredPermissions.filter(
        (perm) => !ctx.callerPermissions.includes(perm)
      );
      if (missingPermissions.length > 0) {
        return yield* Effect.fail(
          new FunctionPermissionDeniedError({
            callerId: ctx.callerId,
            functionId,
            message: `Caller '${ctx.callerId}' lacks required permissions: ${missingPermissions.join(", ")}`,
            missingPermissions,
          })
        );
      }

      // 2. Validate input schema
      const inputExit = Schema.decodeUnknownExit(fn.inputSchema)(rawInput);
      if (inputExit._tag === "Failure") {
        return yield* Effect.fail(
          new FunctionValidationError({
            errors: [String(inputExit.cause)],
            functionId,
            message: `Input schema validation failed for '${functionId}'`,
            phase: "INPUT_VALIDATION",
          })
        );
      }

      // 3. Execute pure function
      const output = yield* fn.execute(inputExit.value, ctx);

      // 4. Validate output schema
      const outputExit = Schema.decodeUnknownExit(fn.outputSchema)(output);
      if (outputExit._tag === "Failure") {
        return yield* Effect.fail(
          new FunctionValidationError({
            errors: [String(outputExit.cause)],
            functionId,
            message: `Output schema validation failed for '${functionId}'`,
            phase: "OUTPUT_VALIDATION",
          })
        );
      }

      return outputExit.value;
    }),

    materializeOutput: Effect.fn("TypedReadService.materializeOutput")(
      function* (
        functionId: string,
        rawInput: unknown,
        ctx: FunctionExecutionContext,
        dependencies: readonly DependencyRecord[]
      ) {
        const invokeResult = yield* TypedReadService.pipe(
          Effect.flatMap((service) =>
            service.invokeFunction(functionId, rawInput, ctx)
          )
        );

        const fn = functions.get(functionId);
        const logicVersion = fn?.version ?? "1.0.0";
        const inputHash = computeHash(rawInput);
        const outputId = `mat-${functionId}-${inputHash.slice(0, 12)}`;

        const record: MaterializedOutputRecord = {
          computedAt: Date.now(),
          dependencies: [...dependencies],
          functionId,
          inputHash,
          isStale: false,
          logicVersion,
          outputId,
          result: invokeResult,
        };

        materializedStore.set(outputId, record);
        return record;
      }
    ),

    registerFunction: Effect.fn("TypedReadService.registerFunction")(
      (fn: TypedReadFunction) =>
        Effect.sync(() => {
          functions.set(fn.functionId, fn);
        })
    ),

    stageEdits: Effect.fn("TypedReadService.stageEdits")(function* (
      mutations: readonly StagedEditMutation[],
      runner: (
        staged: readonly StagedEditMutation[]
      ) => Effect.Effect<void, Error>
    ) {
      // Check for forbidden undeclared remote side effects (OPR-FUN-002)
      for (const m of mutations) {
        if (m.hasUndeclaredSideEffect) {
          return yield* Effect.fail(
            new FunctionValidationError({
              errors: [
                `Mutation on '${m.entityId}' attempted undeclared remote side-effect within staging buffer`,
              ],
              functionId: "stageEdits",
              message: "Undeclared side effect in staging is forbidden",
              phase: "INPUT_VALIDATION",
            })
          );
        }
      }

      // Buffer staged edits isolated from visible state
      const stagingBuffer: StagedEditMutation[] = [...mutations];

      // Execute runner inside transaction boundary
      yield* runner(stagingBuffer);

      // Only on success do edits become visible
      visibleCommittedEdits = [...visibleCommittedEdits, ...stagingBuffer];
      return { committedCount: stagingBuffer.length };
    }),
  });
});
