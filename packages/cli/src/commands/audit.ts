import { Clock, Effect } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

interface DecisionRecordView {
  readonly actionTypeId: string;
  readonly id: string;
  readonly outcome: string;
  readonly previousRecordHash?: string;
  readonly recordHash: string;
  readonly timestamp: number;
}

function printDecisionsHuman(
  decisions: readonly DecisionRecordView[],
  total: number
) {
  printCli(`=== CRYPTOGRAPHIC AUDIT LEDGER (Total: ${total}) ===`);
  if (decisions.length === 0) {
    printCli("No audit records in ledger.");
    return;
  }
  for (const d of decisions) {
    printCli(
      `• ID: ${d.id} | Action: ${d.actionTypeId} | Outcome: ${d.outcome}`
    );
    printCli(`  Hash: ${d.recordHash}`);
    if (d.previousRecordHash) {
      printCli(`  Prev Hash: ${d.previousRecordHash}`);
    }
    printCli(`  Timestamp: ${new Date(d.timestamp).toISOString()}`);
  }
}

const handleAuditList = Effect.fn("handleAuditList")(function* (
  ctx: RuntimeContext,
  args: string[],
  isJson: boolean
) {
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex === -1 ? 20 : Math.trunc(Number(args[limitIndex + 1]));
  const decisions = yield* ctx.auditStore.listDecisions();
  const sliced = decisions.slice(-limit);

  if (isJson) {
    printCliJson(sliced);
  } else {
    printDecisionsHuman(sliced, decisions.length);
  }
  return 0;
});

const handleAuditVerify = Effect.fn("handleAuditVerify")(function* (
  ctx: RuntimeContext,
  isJson: boolean
) {
  const isValid = yield* ctx.auditStore.verifyAuditChain();
  const decisions = yield* ctx.auditStore.listDecisions();

  if (isJson) {
    printCliJson({
      chainValid: isValid,
      ledgerLength: decisions.length,
      status: isValid ? "VERIFIED" : "TAMPERED",
      timestamp: yield* Clock.currentTimeMillis,
    });
  } else {
    printCli("=== AUDIT HASH-CHAIN VERIFICATION ===");
    printCli(
      `Chain Integrity: ${isValid ? "VALID (100% UNTAMPERED)" : "INVALID (CHAIN BROKEN)"}`
    );
    printCli(`Records Verified: ${decisions.length}`);
  }
  return isValid ? 0 : 1;
});

const executeAudit = Effect.fn("executeAudit")(function* (
  ctx: RuntimeContext,
  sub: string | undefined,
  args: string[],
  isJson: boolean
) {
  if (sub === "list") {
    return yield* handleAuditList(ctx, args, isJson);
  }
  if (sub === "verify") {
    return yield* handleAuditVerify(ctx, isJson);
  }

  printCliError(`Error: Unknown audit subcommand '${sub ?? ""}'`);
  printCliError("  Available subcommands: list, verify");
  printCliError("  Run 'operon audit --help' for details.");
  return 1;
});

export function runAudit(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => executeAudit(ctx, sub, args, isJson),
    (ctx) => Effect.sync(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "audit", subcommand: args[0] ?? "none" })
  );
}
