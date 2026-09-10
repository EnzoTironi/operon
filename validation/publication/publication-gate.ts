import path from "node:path";

import { PublicationBoundaryService } from "@operon/assurance";
import { Effect } from "effect";

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
  try {
    const res = await Effect.runPromise(runPublicationGate());
    console.log(
      `Publication Gate Passed: Scanned ${res.scannedPaths.length} files. Zero leaks.`
    );
    process.exit(0);
  } catch (error) {
    console.error("Publication Gate FAILED:", error);
    process.exit(1);
  }
}
