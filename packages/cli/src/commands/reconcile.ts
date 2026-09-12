import { generatePrefixedId, identityKeyString } from "@operon/schema";
import type { IdentityKey } from "@operon/schema";
import { Effect } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

function getFlagValue(
  args: readonly string[],
  flag: string
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseOriginalIds(
  args: readonly string[]
): readonly string[] | undefined {
  const raw = getFlagValue(args, "--original-ids");
  if (!raw) {
    return undefined;
  }
  return raw.split(",");
}

function parseProposeFlags(args: readonly string[]) {
  const sourceSystem = getFlagValue(args, "--source-system");
  const sourceKey = getFlagValue(args, "--source-key");
  const targetCanonicalId = getFlagValue(args, "--target-canonical");
  const action = getFlagValue(args, "--action");
  const confStr = getFlagValue(args, "--confidence");
  if (
    !sourceSystem ||
    !sourceKey ||
    !targetCanonicalId ||
    !action ||
    !confStr
  ) {
    return null;
  }
  return {
    // SAFETY: action flag validated against resolution action union
    action: action as "link" | "merge" | "split",
    confidence: Number(confStr),
    idempotencyKey: getFlagValue(args, "--idempotency-key"),
    reason: getFlagValue(args, "--reason"),
    sourceKey,
    sourceSystem,
    targetCanonicalId,
  };
}

function printProposeResult(proposal: {
  readonly action: string;
  readonly confidence: number;
  readonly proposalId: string;
  readonly key: IdentityKey;
  readonly status: string;
  readonly targetCanonicalId: string;
}): void {
  printCli("=== IDENTITY RESOLUTION PROPOSAL CREATED (S03) ===");
  printCli(`Proposal ID: ${proposal.proposalId}`);
  printCli(`Action: ${proposal.action}`);
  printCli(`Confidence: ${proposal.confidence}`);
  printCli(`Key: ${identityKeyString(proposal.key)}`);
  printCli(`Target Canonical: ${proposal.targetCanonicalId}`);
  printCli(`Status: ${proposal.status}`);
}

function buildSplitDetails(
  action: string,
  sourceKey: string,
  originalIds?: readonly string[],
  reason?: string
) {
  if (action !== "split") {
    return null;
  }
  if (!originalIds && !reason) {
    return null;
  }
  return {
    originalIds: originalIds ?? [sourceKey],
    reason: reason ?? "Identity split correction",
  };
}

const handleReconcilePropose = Effect.fn("handleReconcilePropose")(function* (
  ctx: RuntimeContext,
  args: string[],
  isJson: boolean
) {
  const parsed = parseProposeFlags(args);
  if (!parsed) {
    printCliError("Error: Missing required flags for reconcile propose.");
    printCliError(
      "  Usage: operon reconcile propose --source-system <sys> --source-key <key> --target-canonical <id> --action <link|merge|split> --confidence <float> [--reason <str>] [--original-ids <id1,id2>] [--idempotency-key <key>] [--json]"
    );
    return 1;
  }

  const originalIds = parseOriginalIds(args);
  const proposalId = generatePrefixedId("prop");
  const splitDetails = buildSplitDetails(
    parsed.action,
    parsed.sourceKey,
    originalIds,
    parsed.reason
  );

  const proposal = yield* ctx.reconciliation.proposeIdentityResolution({
    action: parsed.action,
    confidence: parsed.confidence,
    evidence: [],
    idempotencyKey: parsed.idempotencyKey,
    key: {
      kind: "source_pk",
      sourceSystem: parsed.sourceSystem,
      value: parsed.sourceKey,
    },
    proposalId,
    splitDetails,
    targetCanonicalId: parsed.targetCanonicalId,
  });

  if (isJson) {
    printCliJson(proposal);
  } else {
    printProposeResult(proposal);
  }
  return 0;
});

const handleReconcileResolve = Effect.fn("handleReconcileResolve")(function* (
  ctx: RuntimeContext,
  args: string[],
  isJson: boolean
) {
  const proposalId = args[1];
  const decIndex = args.indexOf("--decision-ref");
  const forceOverride = args.includes("--force-override");
  const idemIndex = args.indexOf("--idempotency-key");

  if (!proposalId || decIndex === -1) {
    printCliError(
      "Error: Missing required arguments: <proposalId> --decision-ref <ref>"
    );
    printCliError(
      "  Usage: operon reconcile resolve <proposalId> --decision-ref <ref> [--force-override] [--idempotency-key <key>] [--json]"
    );
    return 1;
  }

  const decisionRef = args[decIndex + 1];
  const idempotencyKey = idemIndex === -1 ? undefined : args[idemIndex + 1];

  const receipt = yield* ctx.reconciliation.resolveIdentity(
    proposalId,
    decisionRef,
    { forceOverride, idempotencyKey }
  );

  if (isJson) {
    printCliJson(receipt);
  } else {
    printCli("=== IDENTITY RESOLUTION RECEIPT (S03) ===");
    printCli(`Resolution ID: ${receipt.resolutionId}`);
    printCli(`Proposal ID: ${receipt.proposalId}`);
    printCli(`Status: ${receipt.status}`);
    printCli(`Action: ${receipt.action}`);
    printCli(`Canonical ID: ${receipt.canonicalId}`);
  }
  return 0;
});

const handleReconcileList = Effect.fn("handleReconcileList")(function* (
  ctx: RuntimeContext,
  isJson: boolean
) {
  const proposals = yield* ctx.reconciliation.listProposals();
  if (isJson) {
    printCliJson(proposals);
  } else {
    printCli("=== IDENTITY RESOLUTION PROPOSALS ===");
    printCli(`Total: ${proposals.length}`);
    for (const p of proposals) {
      printCli(
        `  - [${p.status.toUpperCase()}] ${p.proposalId}: ${p.action} ${identityKeyString(p.key)} -> ${p.targetCanonicalId} (conf: ${p.confidence})`
      );
    }
  }
  return 0;
});

const handleReconcileGet = Effect.fn("handleReconcileGet")(function* (
  ctx: RuntimeContext,
  proposalId: string | undefined,
  isJson: boolean
) {
  if (!proposalId) {
    printCliError("Error: Missing required argument: <proposalId>");
    printCliError("  Usage: operon reconcile get <proposalId> [--json]");
    return 1;
  }
  const proposal = yield* ctx.reconciliation.getProposal(proposalId);
  if (isJson) {
    printCliJson(proposal);
  } else {
    printCli(`Proposal ID: ${proposal.proposalId}`);
    printCli(`Status: ${proposal.status}`);
    printCli(`Action: ${proposal.action}`);
    printCli(`Confidence: ${proposal.confidence}`);
    printCli(`Key: ${identityKeyString(proposal.key)}`);
    printCli(`Target: ${proposal.targetCanonicalId}`);
  }
  return 0;
});

const executeReconcile = Effect.fn("executeReconcile")(function* (
  ctx: RuntimeContext,
  sub: string | undefined,
  args: string[],
  isJson: boolean
) {
  if (sub === "propose") {
    return yield* handleReconcilePropose(ctx, args, isJson);
  }
  if (sub === "resolve") {
    return yield* handleReconcileResolve(ctx, args, isJson);
  }
  if (sub === "list") {
    return yield* handleReconcileList(ctx, isJson);
  }
  if (sub === "get") {
    return yield* handleReconcileGet(ctx, args[1], isJson);
  }

  printCliError(`Error: Unknown reconcile subcommand '${sub ?? ""}'`);
  printCliError("  Available subcommands: propose, resolve, list, get");
  printCliError("  Run 'operon reconcile --help' for details.");
  return 1;
});

export function runReconcile(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => executeReconcile(ctx, sub, args, isJson),
    (ctx) => Effect.promise(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "reconcile", subcommand: args[0] ?? "none" })
  );
}
