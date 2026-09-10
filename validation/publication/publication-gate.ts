import path from "node:path";

import { PublicationBoundaryService } from "@operon/assurance";
import { Effect, Exit } from "effect";

const __dirname = import.meta.dirname;
const rootDir = path.resolve(__dirname, "../..");

export function runPublicationGate(
  targetDirectory: string = path.join(rootDir, "packages")
) {
  const boundary = new PublicationBoundaryService();
  return boundary.scanDirectory(targetDirectory, {
    allowedPublicOnly: true,
    failOnViolation: true,
  });
}

// Direct runner
if (process.argv[1] && process.argv[1].endsWith("publication-gate.ts")) {
  const exitCode = await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(runPublicationGate());
      if (Exit.isFailure(exit)) {
        console.error("Publication Gate FAILED:", exit.cause);
        return 1;
      }
      console.log(
        `Publication Gate Passed: Scanned ${exit.value.scannedPaths.length} files. Zero leaks.`
      );
      return 0;
    })
  );
  process.exit(exitCode);
}
