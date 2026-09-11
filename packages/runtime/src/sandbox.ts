import { serializeJson } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Clock, Effect } from "effect";

import { SandboxExecutionError, ValidationError } from "./errors.js";

export interface SandboxedModelDefinition {
  readonly modelId: string;
  readonly version: string;
  readonly isDeterministic: boolean;
  readonly timeoutMs?: number;
  readonly requiredInputs: readonly string[];
  readonly compute: (
    inputs: Record<string, unknown>
  ) => Effect.Effect<Record<string, unknown>, Error>;
}

export interface ModelExecutionReport {
  readonly modelId: string;
  readonly version: string;
  readonly durationMs: number;
  readonly outputs: Record<string, unknown>;
  readonly isDeterministic: boolean;
}

export interface DeterminismProof {
  readonly modelId: string;
  readonly iterations: number;
  readonly allOutputsMatch: boolean;
  readonly samples: readonly Record<string, unknown>[];
}

/**
 * Enterprise Sandboxed Model / Function Runner enforcing timeouts, input checks, and determinism proofs
 */
export class SandboxedModelRunner {
  private readonly models = new Map<string, SandboxedModelDefinition>();

  public registerModel(model: SandboxedModelDefinition): void {
    this.models.set(model.modelId, model);
  }

  public getModel(modelId: string): SandboxedModelDefinition | undefined {
    return this.models.get(modelId);
  }

  /**
   * Executes a model within a fiber-isolated sandbox with enforced timeout
   */
  public readonly execute = Effect.fn("SandboxedModelRunner.execute")(
    function* (
      this: SandboxedModelRunner,
      modelId: string,
      inputs: Record<string, unknown>
    ): Effect.fn.Return<
      ModelExecutionReport,
      SandboxExecutionError | ValidationError
    > {
      const model = this.models.get(modelId);
      if (!model) {
        return yield* new ValidationError({
          details: `Model '${modelId}' is not registered in the sandbox`,
          entityId: modelId,
          rule: "model_exists",
        });
      }

      // 1. Validate required inputs
      const missingInput = model.requiredInputs.find(
        (req) => inputs[req] === undefined || inputs[req] === null
      );
      if (missingInput) {
        return yield* new ValidationError({
          details: `Missing required model input parameter: '${missingInput}'`,
          entityId: modelId,
          rule: "required_inputs",
        });
      }

      const timeoutMs = model.timeoutMs ?? 1000;
      const startTime = yield* Clock.currentTimeMillis;

      // 2. Execute computation with fiber timeout isolation
      const outputs = yield* model.compute(inputs).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new SandboxExecutionError({
                modelId,
                reason: `Model computation timed out after ${timeoutMs}ms`,
              })
            ),
        }),
        Effect.mapError((err) =>
          err instanceof SandboxExecutionError
            ? err
            : new SandboxExecutionError({
                modelId,
                reason:
                  typeof err === "object" &&
                  err !== null &&
                  "message" in err &&
                  typeof (err as { message: unknown }).message === "string"
                    ? (err as { message: string }).message
                    : String(err),
              })
        )
      );
      const endTime = yield* Clock.currentTimeMillis;
      const report: ModelExecutionReport = {
        durationMs: endTime - startTime,
        isDeterministic: model.isDeterministic,
        modelId: model.modelId,
        outputs,
        version: model.version,
      };

      OperonTelemetryService.getInstance().trackEvent({
        event: "operon_model_executed",
        properties: {
          durationMs: report.durationMs,
          isDeterministic: report.isDeterministic,
          modelId: report.modelId,
          timedOut: false,
          version: report.version,
        },
      });

      return report;
    }
  );

  /**
   * Verifies mathematical determinism of a model by running multiple iterations with identical inputs
   */
  public readonly verifyDeterminism = Effect.fn(
    "SandboxedModelRunner.verifyDeterminism"
  )(function* (
    this: SandboxedModelRunner,
    modelId: string,
    inputs: Record<string, unknown>,
    iterations = 3
  ): Effect.fn.Return<
    DeterminismProof,
    SandboxExecutionError | ValidationError
  > {
    const samples: Record<string, unknown>[] = [];

    const iterationIndices = Array.from({ length: iterations }, (_, i) => i);
    const runSample = (id: string, inps: Record<string, unknown>) =>
      this.execute(id, inps);
    yield* Effect.forEach(
      iterationIndices,
      () =>
        Effect.gen(function* () {
          const res = yield* runSample(modelId, inputs);
          samples.push(res.outputs);
        }),
      { concurrency: 1 }
    );

    const firstJson = serializeJson(samples[0]);
    const allMatch = samples.every((s) => serializeJson(s) === firstJson);

    return {
      allOutputsMatch: allMatch,
      iterations,
      modelId,
      samples,
    };
  });
}
