import type { ActionParameters } from "@operon/schema";
import { Effect, Exit } from "effect";

import { printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

function parseInputs(
  args: readonly string[]
): Effect.Effect<ActionParameters, Error> {
  const index = args.indexOf("--inputs");
  if (index === -1 || !args[index + 1]) {
    return Effect.succeed({ value: 10 });
  }
  return Effect.try({
    catch: () => new Error("--inputs must be valid JSON."),
    // SAFETY: parsed JSON object as ActionParameters
    try: () => JSON.parse(args[index + 1]) as ActionParameters,
  });
}

function parseIterations(args: readonly string[]): number {
  const index = args.indexOf("--iterations");
  if (index === -1) {
    return 3;
  }
  return Math.trunc(Number(args[index + 1]));
}

function printProof(proof: {
  readonly allOutputsMatch: boolean;
  readonly iterations: number;
  readonly modelId: string;
  readonly samples: readonly unknown[];
}): void {
  console.log("=== MODEL SANDBOX DETERMINISM PROOF ===");
  console.log(`Model ID: ${proof.modelId}`);
  console.log(`Iterations Executed: ${proof.iterations}`);
  const status = proof.allOutputsMatch
    ? "VERIFIED (100% IDENTICAL OUTPUTS)"
    : "FAILED (NON-DETERMINISTIC)";
  console.log(`Determinism Proof: ${status}`);
  console.log(`Outputs: ${JSON.stringify(proof.samples[0])}`);
}

const handleSandboxVerify = Effect.fn("handleSandboxVerify")(function* (
  ctx: RuntimeContext,
  modelId: string,
  args: readonly string[],
  isJson: boolean
) {
  const inputsResult = yield* parseInputs(args).pipe(Effect.exit);
  if (Exit.isFailure(inputsResult)) {
    printCliError("Error: --inputs must be valid JSON.");
    return 1;
  }
  const inputs = inputsResult.value;
  const iterations = parseIterations(args);

  const proofResult = yield* ctx.sandbox
    .verifyDeterminism(modelId, inputs, iterations)
    .pipe(Effect.exit);

  if (Exit.isFailure(proofResult)) {
    printCliError(
      `Error: Model execution failed: ${String(proofResult.cause)}`
    );
    return 1;
  }

  const proof = proofResult.value;
  if (isJson) {
    printCliJson(proof);
  } else {
    printProof(proof);
  }

  return proof.allOutputsMatch ? 0 : 1;
});

export function runSandbox(args: string[]): Effect.Effect<number> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const modelId = args[1];

  if (sub !== "verify" || !modelId) {
    console.error(
      `Error: Unknown or incomplete sandbox command '${sub ?? ""}'`
    );
    console.error(
      "  Usage: operon sandbox verify <modelId> [--inputs '<json>'] [--iterations <n>] [--json]"
    );
    console.error(
      "  Example: operon sandbox verify predictive_vibration_model --inputs '{\"value\":10}' --iterations 3"
    );
    return Effect.succeed(1);
  }

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext()),
    (ctx) => handleSandboxVerify(ctx, modelId, args, isJson),
    (ctx) => Effect.promise(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "sandbox", subcommand: args[0] ?? "none" })
  );
}
