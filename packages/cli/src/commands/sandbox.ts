import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runSandbox(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");

    if (sub !== "verify") {
      console.error(`Error: Unknown sandbox command '${sub ?? ""}'`);
      console.error(
        "  Usage: operon sandbox verify <modelId> [--inputs '<json>'] [--iterations <n>] [--json]"
      );
      console.error(
        "  Example: operon sandbox verify predictive_vibration_model --inputs '{\"value\":10}' --iterations 3"
      );
      return 1;
    }

    const modelId = args[1];
    if (!modelId) {
      console.error("Error: Missing model ID for sandbox verify.");
      return 1;
    }

    const inputsIndex = args.indexOf("--inputs");
    let inputs: Record<string, unknown> = { value: 10 };
    if (inputsIndex !== -1 && args[inputsIndex + 1]) {
      try {
        inputs = JSON.parse(args[inputsIndex + 1]);
      } catch {
        console.error("Error: --inputs must be valid JSON.");
        return 1;
      }
    }

    const iterIndex = args.indexOf("--iterations");
    const iterations =
      iterIndex === -1 ? 3 : Math.trunc(Number(args[iterIndex + 1]));

    const ctx = yield* Effect.tryPromise({
      catch: (e) => e,
      try: () => createRuntimeContext(),
    });

    try {
      const proofResult = yield* ctx.sandbox
        .verifyDeterminism(modelId, inputs, iterations)
        .pipe(Effect.result);

      if (proofResult._tag === "Failure") {
        console.error(
          `Error: Model execution failed: ${String((proofResult.failure as any)?.message ?? proofResult.failure)}`
        );
        return 1;
      }

      const proof = proofResult.success;

      if (isJson) {
        console.log(JSON.stringify(proof, null, 2));
      } else {
        console.log(`=== MODEL SANDBOX DETERMINISM PROOF ===`);
        console.log(`Model ID: ${proof.modelId}`);
        console.log(`Iterations Executed: ${proof.iterations}`);
        console.log(
          `Determinism Proof: ${proof.allOutputsMatch ? "VERIFIED (100% IDENTICAL OUTPUTS)" : "FAILED (NON-DETERMINISTIC)"}`
        );
        console.log(`Outputs: ${JSON.stringify(proof.samples[0])}`);
      }

      return proof.allOutputsMatch ? 0 : 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "sandbox", subcommand: args[0] ?? "none" })
  );
}
