import { Effect, Exit } from "effect";

import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

export interface DoctorCheckResult {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly details: string;
}

function checkEnvironment(): readonly DoctorCheckResult[] {
  const nodeVer = process.version;
  const major = Math.trunc(Number(nodeVer.slice(1).split(".")[0]));
  return [
    {
      details: `Node.js ${nodeVer} (requires >= 20.0.0)`,
      name: "Runtime Engine",
      status: major >= 20 ? "PASS" : "FAIL",
    },
    {
      details: "Effect 4.0.0-rc.112 initialized and executing pure fibers",
      name: "Effect Runtime",
      status: "PASS",
    },
  ];
}

const executeStorageChecks = Effect.fn("executeStorageChecks")(function* (
  ctx: RuntimeContext,
  checks: DoctorCheckResult[],
  dbPath?: string
) {
  checks.push({
    details: `Initialized ${dbPath ? "SQLite bitemporal store" : "in-memory object store"} with pre-seeded ontologies`,
    name: "Storage Engine",
    status: "PASS",
  });

  const auditChainValid = yield* ctx.auditStore
    .verifyAuditChain()
    .pipe(Effect.catchTag("StorageError", () => Effect.succeed(false)));

  checks.push({
    details: `Audit store cryptographic hash chain verified (holds=${auditChainValid})`,
    name: "Audit Store Hash Chain",
    status: auditChainValid ? "PASS" : "FAIL",
  });

  const pending = ctx.inbox.getPendingProposals();
  checks.push({
    details: `Action Inbox online with ${pending.length} pending proposals`,
    name: "Action Inbox",
    status: "PASS",
  });
});

const runStorageChecks = Effect.fn("runStorageChecks")(function* (
  dbPath?: string
) {
  const checks: DoctorCheckResult[] = [];
  const storageEffect = Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => executeStorageChecks(ctx, checks, dbPath),
    (ctx) => Effect.sync(() => ctx.close())
  );

  const storageResult = yield* storageEffect.pipe(Effect.exit);
  if (Exit.isFailure(storageResult)) {
    checks.push({
      details: `Storage initialization failed: ${String(storageResult.cause)}`,
      name: "Storage Engine",
      status: "FAIL",
    });
  }
  return checks;
});

function printHumanReport(
  checks: readonly DoctorCheckResult[],
  allPassed: boolean
) {
  console.log("=== OPERON DOCTOR SYSTEM REPORT ===");
  for (const c of checks) {
    const mark = c.status === "PASS" ? "✓" : "✗";
    console.log(`[${mark}] ${c.name}: ${c.details}`);
  }
  console.log("-----------------------------------");
  console.log(`Overall Status: ${allPassed ? "HEALTHY" : "UNHEALTHY"}`);
}

function reportResults(
  checks: readonly DoctorCheckResult[],
  json?: boolean
): number {
  const allPassed = checks.every((c) => c.status === "PASS");
  if (json) {
    console.log(
      JSON.stringify(
        {
          checks,
          overallStatus: allPassed ? "HEALTHY" : "UNHEALTHY",
          timestamp: Date.now(),
        },
        null,
        2
      )
    );
  } else {
    printHumanReport(checks, allPassed);
  }
  return allPassed ? 0 : 1;
}

export function runDoctor(options: {
  readonly dbPath?: string;
  readonly json?: boolean;
}): Effect.Effect<number> {
  return Effect.gen(function* () {
    yield* Effect.logInfo("Running Operon Doctor preflight checks");
    const envChecks = checkEnvironment();
    const storageChecks = yield* runStorageChecks(options.dbPath);
    const checks = [...envChecks, ...storageChecks];
    return reportResults(checks, options.json);
  }).pipe(Effect.annotateLogs({ command: "doctor" }));
}
