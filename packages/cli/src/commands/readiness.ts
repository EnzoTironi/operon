import { evaluateDecisionReadiness } from "@operon/runtime";
import type { ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

function getFlagValue(
  args: readonly string[],
  flag: string
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseReadinessArgs(args: readonly string[]) {
  const sub = args[0];
  const typeId = args[1];
  const id = args[2];
  if (sub !== "check" || !typeId || !id) {
    return null;
  }
  return { id, typeId };
}

function printCorrectness(correct: {
  readonly passed: boolean;
  readonly violations: readonly string[];
}): void {
  printCli(`  [C1] Correctness:   ${correct.passed ? "PASS" : "FAIL"}`);
  if (!correct.passed) {
    printCli(`       Errors: ${correct.violations.join(", ")}`);
  }
}

function printCompleteness(complete: {
  readonly missingProperties: readonly string[];
  readonly passed: boolean;
}): void {
  printCli(`  [C2] Completeness:  ${complete.passed ? "PASS" : "FAIL"}`);
  if (!complete.passed) {
    printCli(`       Missing: ${complete.missingProperties.join(", ")}`);
  }
}

function printCurrency(current: {
  readonly passed: boolean;
  readonly staleProperties: readonly { readonly property: string }[];
}): void {
  printCli(`  [C3] Currency:      ${current.passed ? "PASS" : "FAIL"}`);
  if (!current.passed) {
    const staleNames = current.staleProperties
      .map((p) => p.property)
      .join(", ");
    printCli(`       Stale: ${staleNames}`);
  }
}

function printConsistency(consistent: {
  readonly contradictions: readonly string[];
  readonly passed: boolean;
}): void {
  printCli(`  [C4] Consistency:   ${consistent.passed ? "PASS" : "FAIL"}`);
  if (!consistent.passed) {
    printCli(`       Contradictions: ${consistent.contradictions.join("; ")}`);
  }
}

function printReadinessHuman(
  readiness: ReturnType<typeof evaluateDecisionReadiness>,
  typeId: string,
  id: string
): void {
  printCli("=== 4C DECISION READINESS EVALUATION (Chapter 7) ===");
  printCli(`Object: ${typeId}#${id}`);
  printCli(
    `Overall Status:     ${readiness.isReady ? "✅ READY FOR AUTOMATION" : "❌ ESCALATE / NOT READY"}`
  );
  printCorrectness(readiness.correct);
  printCompleteness(readiness.complete);
  printCurrency(readiness.current);
  printConsistency(readiness.consistent);
}

const handleReadinessCheck = Effect.fn("handleReadinessCheck")(function* (
  ctx: RuntimeContext,
  typeId: string,
  id: string,
  isJson: boolean
) {
  const oType = ctx.objectTypes.find((t) => t.id === typeId);
  if (!oType) {
    printCliError(`Error: ObjectType '${typeId}' is not registered.`);
    return 1;
  }

  // SAFETY: typeId string argument from CLI validated against registered ObjectType
  const obj = yield* ctx.objectStore.getObject(typeId as ObjectTypeId, id);
  if (!obj) {
    printCliError(`Error: Object '${id}' of type '${typeId}' does not exist.`);
    return 1;
  }

  const readiness = evaluateDecisionReadiness(obj, oType);

  if (isJson) {
    printCliJson({
      id,
      readiness,
      status: readiness.isReady ? "READY" : "NOT_READY",
      typeId,
    });
  } else {
    printReadinessHuman(readiness, typeId, id);
  }

  return readiness.isReady ? 0 : 2;
});

export function runReadiness(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const parsed = parseReadinessArgs(args);
  if (!parsed) {
    printCliError(`Error: Unknown or missing arguments for readiness check.`);
    printCliError(
      "  Usage: operon readiness check <typeId> <id> [--json] [--db <path>]"
    );
    printCliError("  Example: operon readiness check Patient P001 --json");
    return Effect.succeed(1);
  }

  const isJson = args.includes("--json");
  const dbPath = getFlagValue(args, "--db");

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => handleReadinessCheck(ctx, parsed.typeId, parsed.id, isJson),
    (ctx) => Effect.sync(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "readiness", subcommand: args[0] ?? "none" })
  );
}
