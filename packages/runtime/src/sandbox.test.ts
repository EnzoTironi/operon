import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SandboxedModelRunner } from "./sandbox.js";

class ComputationDivergenceError extends Data.TaggedError(
  "ComputationDivergenceError"
)<{
  readonly message: string;
}> {}

describe("SandboxedModelRunner & Determinism Verification (sandbox.ts)", () => {
  it("verifies mathematical determinism when outputs match identically across all iterations", async () => {
    const runner = new SandboxedModelRunner();

    runner.registerModel({
      compute: (inputs) =>
        Effect.sync(() => ({
          doubled: (inputs.x as number) * 2,
        })),
      isDeterministic: true,
      modelId: "double-fn",
      requiredInputs: ["x"],
      version: "1.0.0",
    });

    const proof = await Effect.runPromise(
      runner.verifyDeterminism("double-fn", { x: 21 }, 4)
    );

    expect(proof.modelId).toBe("double-fn");
    expect(proof.iterations).toBe(4);
    expect(proof.allOutputsMatch).toBe(true);
    expect(proof.samples).toHaveLength(4);
    expect(proof.samples).toEqual([
      { doubled: 42 },
      { doubled: 42 },
      { doubled: 42 },
      { doubled: 42 },
    ]);
  });

  it("detects non-determinism when samples differ between iterations", async () => {
    const runner = new SandboxedModelRunner();
    let counter = 0;

    // Flaky / non-deterministic model whose output changes per invocation
    runner.registerModel({
      compute: () =>
        Effect.sync(() => {
          counter++;
          return { value: counter };
        }),
      isDeterministic: false,
      modelId: "flaky-counter",
      requiredInputs: [],
      version: "1.0.0",
    });

    const proof = await Effect.runPromise(
      runner.verifyDeterminism("flaky-counter", {}, 3)
    );

    expect(proof.modelId).toBe("flaky-counter");
    expect(proof.iterations).toBe(3);
    expect(proof.allOutputsMatch).toBe(false);
    expect(proof.samples).toHaveLength(3);
    expect(proof.samples).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  it("fails execution when required inputs are missing", async () => {
    const runner = new SandboxedModelRunner();

    runner.registerModel({
      compute: (inputs) => Effect.sync(() => ({ out: inputs.val })),
      isDeterministic: true,
      modelId: "requires-val",
      requiredInputs: ["val"],
      version: "1.0.0",
    });

    const err = await Effect.runPromise(
      Effect.flip(runner.execute("requires-val", {}))
    );

    expect(err).toBeDefined();
    expect((err as any)._tag).toBe("ValidationError");
  });

  it("fails execution when model throws computation error", async () => {
    const runner = new SandboxedModelRunner();

    runner.registerModel({
      compute: () =>
        Effect.fail(
          new ComputationDivergenceError({ message: "Computation divergence" })
        ),
      isDeterministic: false,
      modelId: "divergent-model",
      requiredInputs: [],
      version: "1.0.0",
    });

    const err = await Effect.runPromise(
      Effect.flip(runner.execute("divergent-model", {}))
    );

    expect(err).toBeDefined();
    expect((err as any)._tag).toBe("SandboxExecutionError");
  });
});
