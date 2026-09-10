import * as fs from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runPublicationGate } from "./publication-gate.js";

describe("Publication Gate (validation/publication/publication-gate.ts)", () => {
  it("passes when scanning clean workspace files", () =>
    Effect.gen(function* () {
      const tempCleanDir = fs.mkdtempSync(
        path.join(process.cwd(), ".tmp-pub-gate-clean-")
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fs.rmSync(tempCleanDir, { recursive: true, force: true });
        })
      );

      fs.writeFileSync(
        path.join(tempCleanDir, "index.ts"),
        "export const version = '0.1.0';",
        "utf-8"
      );

      const result = yield* runPublicationGate(tempCleanDir);
      expect(result.isClean).toBe(true);
      expect(result.violations.length).toBe(0);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("fails and halts release when private oracle marker is introduced", () =>
    Effect.gen(function* () {
      const tempDirtyDir = fs.mkdtempSync(
        path.join(process.cwd(), ".tmp-pub-gate-dirty-")
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fs.rmSync(tempDirtyDir, { recursive: true, force: true });
        })
      );

      fs.writeFileSync(
        path.join(tempDirtyDir, "index.ts"),
        "export const version = '0.1.0';",
        "utf-8"
      );
      fs.writeFileSync(
        path.join(tempDirtyDir, "leaked.ts"),
        "const hiddenWeight = '__OPERON_EVALUATOR_WEIGHTS__';",
        "utf-8"
      );

      const exit = yield* Effect.exit(runPublicationGate(tempDirtyDir));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("PublicationLeakError");
      }
    }).pipe(Effect.scoped, Effect.runPromise));
});
