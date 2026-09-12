import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  joinPath,
  makeTempDirSync,
  rmDirRecursiveSync,
  writeTextFileSync,
} from "./paths.js";
import { runPublicationGate } from "./publication-gate.js";

describe("Publication Gate (validation/publication/publication-gate.ts)", () => {
  it("passes when scanning clean workspace files", () =>
    Effect.gen(function* () {
      const tempCleanDir = makeTempDirSync(
        joinPath(process.cwd(), ".tmp-pub-gate-clean-")
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmDirRecursiveSync(tempCleanDir);
        })
      );

      writeTextFileSync(
        joinPath(tempCleanDir, "index.ts"),
        "export const version = '0.1.0';"
      );

      const result = yield* runPublicationGate(tempCleanDir);
      expect(result.isClean).toBe(true);
      expect(result.violations.length).toBe(0);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("fails and halts release when private oracle marker is introduced", () =>
    Effect.gen(function* () {
      const tempDirtyDir = makeTempDirSync(
        joinPath(process.cwd(), ".tmp-pub-gate-dirty-")
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rmDirRecursiveSync(tempDirtyDir);
        })
      );

      writeTextFileSync(
        joinPath(tempDirtyDir, "index.ts"),
        "export const version = '0.1.0';"
      );
      writeTextFileSync(
        joinPath(tempDirtyDir, "leaked.ts"),
        "const hiddenWeight = '__OPERON_EVALUATOR_WEIGHTS__';"
      );

      const exit = yield* Effect.exit(runPublicationGate(tempDirtyDir));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("PublicationLeakError");
      }
    }).pipe(Effect.scoped, Effect.runPromise));
});
