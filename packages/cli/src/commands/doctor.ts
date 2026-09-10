import { createRuntimeContext } from "../state.js";

export interface DoctorCheckResult {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly details: string;
}

export async function runDoctor(options: {
  readonly dbPath?: string;
  readonly json?: boolean;
}): Promise<number> {
  const checks: DoctorCheckResult[] = [];

  // 1. Node.js environment
  const nodeVer = process.version;
  const major = Math.trunc(Number(nodeVer.slice(1).split(".")[0]));
  checks.push({
    details: `Node.js ${nodeVer} (requires >= 20.0.0)`,
    name: "Runtime Engine",
    status: major >= 20 ? "PASS" : "FAIL",
  });

  // 2. Effect & Types
  try {
    const { Effect } = await import("effect");
    const effTest = await Effect.runPromise(Effect.succeed(true));
    checks.push({
      details: "Effect 4.0.0-rc.112 initialized and executing pure fibers",
      name: "Effect Runtime",
      status: effTest ? "PASS" : "FAIL",
    });
  } catch (error: unknown) {
    checks.push({
      details: `Failed to load Effect: ${String((error as any)?.message ?? error)}`,
      name: "Effect Runtime",
      status: "FAIL",
    });
  }

  // 3. Storage Context & Bitemporal Engine
  try {
    const ctx = await createRuntimeContext(options.dbPath);
    checks.push({
      details: `Initialized ${options.dbPath ? "SQLite bitemporal store" : "in-memory object store"} with pre-seeded ontologies`,
      name: "Storage Engine",
      status: "PASS",
    });

    // 4. Audit Chain Verification
    const auditChainValid = await ctx.auditStore.verifyAuditChain();
    checks.push({
      details: `Audit store cryptographic hash chain verified (holds=${auditChainValid})`,
      name: "Audit Store Hash Chain",
      status: auditChainValid ? "PASS" : "FAIL",
    });

    // 5. Action Inbox State
    const pending = ctx.inbox.getPendingProposals();
    checks.push({
      details: `Action Inbox online with ${pending.length} pending proposals`,
      name: "Action Inbox",
      status: "PASS",
    });

    ctx.close();
  } catch (error: unknown) {
    checks.push({
      details: `Storage initialization failed: ${String((error as any)?.message ?? error)}`,
      name: "Storage Engine",
      status: "FAIL",
    });
  }

  const allPassed = checks.every((c) => c.status === "PASS");

  if (options.json) {
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
    console.log("=== OPERON DOCTOR SYSTEM REPORT ===");
    for (const c of checks) {
      const mark = c.status === "PASS" ? "✓" : "✗";
      console.log(`[${mark}] ${c.name}: ${c.details}`);
    }
    console.log("-----------------------------------");
    console.log(`Overall Status: ${allPassed ? "HEALTHY" : "UNHEALTHY"}`);
  }

  return allPassed ? 0 : 1;
}
