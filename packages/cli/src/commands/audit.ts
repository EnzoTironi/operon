import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runAudit(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.tryPromise({
      catch: (e) => e,
      try: () => createRuntimeContext(dbPath),
    });

    try {
      if (sub === "list") {
        const limitIndex = args.indexOf("--limit");
        const limit =
          limitIndex === -1 ? 20 : Math.trunc(Number(args[limitIndex + 1]));

        const decisions = yield* Effect.tryPromise({
          catch: () => [],
          try: () => ctx.auditStore.listDecisions(),
        });
        const sliced = decisions.slice(-limit);

        if (isJson) {
          console.log(JSON.stringify(sliced, null, 2));
        } else {
          console.log(
            `=== CRYPTOGRAPHIC AUDIT LEDGER (Total: ${decisions.length}) ===`
          );
          if (sliced.length === 0) {
            console.log("No audit records in ledger.");
          } else {
            for (const d of sliced) {
              console.log(
                `• ID: ${d.id} | Action: ${d.actionTypeId} | Outcome: ${d.outcome}`
              );
              console.log(`  Hash: ${d.recordHash}`);
              if (d.previousRecordHash) {
                console.log(`  Prev Hash: ${d.previousRecordHash}`);
              }
              console.log(
                `  Timestamp: ${new Date(d.timestamp).toISOString()}`
              );
            }
          }
        }
        return 0;
      }

      if (sub === "verify") {
        const isValid = yield* Effect.tryPromise({
          catch: () => false,
          try: () => ctx.auditStore.verifyAuditChain(),
        });
        const decisions = yield* Effect.tryPromise({
          catch: () => [],
          try: () => ctx.auditStore.listDecisions(),
        });

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                chainValid: isValid,
                ledgerLength: decisions.length,
                status: isValid ? "VERIFIED" : "TAMPERED",
                timestamp: Date.now(),
              },
              null,
              2
            )
          );
        } else {
          console.log("=== AUDIT HASH-CHAIN VERIFICATION ===");
          console.log(
            `Chain Integrity: ${isValid ? "VALID (100% UNTAMPERED)" : "INVALID (CHAIN BROKEN)"}`
          );
          console.log(`Records Verified: ${decisions.length}`);
        }
        return isValid ? 0 : 1;
      }

      console.error(`Error: Unknown audit subcommand '${sub ?? ""}'`);
      console.error("  Available subcommands: list, verify");
      console.error("  Run 'operon audit --help' for details.");
      return 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "audit", subcommand: args[0] ?? "none" })
  );
}
