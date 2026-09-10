import { evaluateDecisionReadiness } from "@operon/runtime";
import type { ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runReadiness(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    if (sub !== "check") {
      console.error(`Error: Unknown readiness subcommand '${sub ?? ""}'`);
      console.error(
        "  Usage: operon readiness check <typeId> <id> [--json] [--db <path>]"
      );
      console.error("  Example: operon readiness check Patient P001 --json");
      return 1;
    }

    const typeId = args[1];
    const id = args[2];
    if (!typeId || !id) {
      console.error("Error: Missing required arguments: <typeId> <id>");
      console.error(
        "  Usage: operon readiness check <typeId> <id> [--json] [--db <path>]"
      );
      console.error("  Example: operon readiness check Patient P001");
      return 1;
    }

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));

    try {
      const oType = ctx.objectTypes.find((t) => t.id === typeId);
      if (!oType) {
        console.error(`Error: ObjectType '${typeId}' is not registered.`);
        return 1;
      }

      const obj = yield* ctx.objectStore.getObject(typeId as ObjectTypeId, id);
      if (!obj) {
        console.error(
          `Error: Object '${id}' of type '${typeId}' does not exist.`
        );
        return 1;
      }

      const readiness = evaluateDecisionReadiness(obj, oType);

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              id,
              readiness,
              status: readiness.isReady ? "READY" : "NOT_READY",
              typeId,
            },
            null,
            2
          )
        );
      } else {
        console.log(
          `=== 4C DECISION READINESS EVALUATION: ${typeId}#${id} ===`
        );
        console.log(
          `Decision Ready: ${readiness.isReady ? "YES (READY)" : "NO (GAPS FOUND)"}`
        );
        console.log(
          `  [C1] Completeness: ${readiness.complete.passed ? "PASS" : "FAIL"}`
        );
        if (!readiness.complete.passed) {
          console.log(
            `       Missing properties: ${readiness.complete.missingProperties.join(", ")}`
          );
        }
        console.log(
          `  [C2] Correctness:   ${readiness.correct.passed ? "PASS" : "FAIL"}`
        );
        if (!readiness.correct.passed) {
          console.log(
            `       Violations: ${readiness.correct.violations.join("; ")}`
          );
        }
        console.log(
          `  [C3] Currentness:   ${readiness.current.passed ? "PASS" : "FAIL"}`
        );
        if (!readiness.current.passed) {
          console.log(
            `       Stale: ${readiness.current.staleProperties.map((p) => p.property).join(", ")}`
          );
        }
        console.log(
          `  [C4] Consistency:   ${readiness.consistent.passed ? "PASS" : "FAIL"}`
        );
        if (!readiness.consistent.passed) {
          console.log(
            `       Contradictions: ${readiness.consistent.contradictions.join("; ")}`
          );
        }
      }

      return readiness.isReady ? 0 : 2;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "readiness", subcommand: args[0] ?? "none" })
  );
}
