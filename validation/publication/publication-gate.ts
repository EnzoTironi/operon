import { Effect, Exit } from "effect";

import { PublicationBoundaryService } from "../../packages/assurance/src/publication-boundary.js";
import { joinPath, resolvePath } from "./paths.js";

const __dirname = import.meta.dirname;
const rootDir = resolvePath(__dirname, "../..");

export function runPublicationGate(
  targetDirectory: string = joinPath(rootDir, "packages")
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
        yield* Effect.logError(
          `Publication Gate FAILED: ${String(exit.cause)}`
        );
        return 1;
      }
      yield* Effect.logInfo(
        `Publication Gate Passed: Scanned ${exit.value.scannedPaths.length} files. Zero leaks.`
      );
      return 0;
    })
  );
  process.exit(exitCode);
}
