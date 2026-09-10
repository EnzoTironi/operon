import { Effect } from "effect";

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
  public execute(
    modelId: string,
    inputs: Record<string, unknown>
  ): Effect.Effect<
    ModelExecutionReport,
    SandboxExecutionError | ValidationError
  > {
    return Effect.suspend<
      ModelExecutionReport,
      SandboxExecutionError | ValidationError,
      never
    >(() => {
      const model = this.models.get(modelId);
      if (!model) {
        return Effect.fail(
          new ValidationError({
            details: `Model '${modelId}' is not registered in the sandbox`,
            entityId: modelId,
            rule: "model_exists",
          })
        );
      }

      // 1. Validate required inputs
      for (const req of model.requiredInputs) {
        if (inputs[req] === undefined || inputs[req] === null) {
          return Effect.fail(
            new ValidationError({
              details: `Missing required model input parameter: '${req}'`,
              entityId: modelId,
              rule: "required_inputs",
            })
          );
        }
      }

      const timeoutMs = model.timeoutMs ?? 1000;
      const startTime = Date.now();

      // 2. Execute computation with fiber timeout isolation
      return model.compute(inputs).pipe(
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
        Effect.mapBoth({
          onFailure: (err) =>
            err instanceof SandboxExecutionError
              ? err
              : new SandboxExecutionError({
                  modelId,
                  reason: String((err as any)?.message ?? err),
                }),
          onSuccess: (
            outputs: Record<string, unknown>
          ): ModelExecutionReport => ({
            durationMs: Date.now() - startTime,
            isDeterministic: model.isDeterministic,
            modelId: model.modelId,
            outputs,
            version: model.version,
          }),
        })
      );
    });
  }

  /**
   * Verifies mathematical determinism of a model by running multiple iterations with identical inputs
   */
  public verifyDeterminism(
    modelId: string,
    inputs: Record<string, unknown>,
    iterations = 3
  ): Effect.Effect<DeterminismProof, SandboxExecutionError | ValidationError> {
    return Effect.gen({ self: this }, function* () {
      const samples: Record<string, unknown>[] = [];

      for (let i = 0; i < iterations; i++) {
        const res = yield* this.execute(modelId, inputs);
        samples.push(res.outputs);
      }

      const firstJson = JSON.stringify(samples[0]);
      const allMatch = samples.every((s) => JSON.stringify(s) === firstJson);

      return {
        modelId,
        iterations,
        allOutputsMatch: allMatch,
        samples,
      };
    });
  }
}
