import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runReconcile(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));

    try {
      if (sub === "propose") {
        const sysIndex = args.indexOf("--source-system");
        const keyIndex = args.indexOf("--source-key");
        const targetIndex = args.indexOf("--target-canonical");
        const actionIndex = args.indexOf("--action");
        const confIndex = args.indexOf("--confidence");
        const reasonIndex = args.indexOf("--reason");
        const origIdsIndex = args.indexOf("--original-ids");
        const idemIndex = args.indexOf("--idempotency-key");

        if (
          sysIndex === -1 ||
          keyIndex === -1 ||
          targetIndex === -1 ||
          actionIndex === -1 ||
          confIndex === -1
        ) {
          console.error("Error: Missing required flags for reconcile propose.");
          console.error(
            "  Usage: operon reconcile propose --source-system <sys> --source-key <key> --target-canonical <id> --action <link|merge|split> --confidence <float> [--reason <str>] [--original-ids <id1,id2>] [--idempotency-key <key>] [--json]"
          );
          console.error(
            "  Example: operon reconcile propose --source-system crm --source-key c_101 --target-canonical cust_999 --action merge --confidence 0.95 --json"
          );
          return 1;
        }

        const sourceSystem = args[sysIndex + 1];
        const sourceKey = args[keyIndex + 1];
        const targetCanonicalId = args[targetIndex + 1];
        const action = args[actionIndex + 1] as "link" | "merge" | "split";
        const confidence = Number(args[confIndex + 1]);
        const reason = reasonIndex === -1 ? undefined : args[reasonIndex + 1];
        const originalIds =
          origIdsIndex === -1 ? undefined : args[origIdsIndex + 1].split(",");
        const idempotencyKey =
          idemIndex === -1 ? undefined : args[idemIndex + 1];

        const proposalId = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const proposal = yield* ctx.reconciliation.proposeIdentityResolution({
          action,
          confidence,
          evidence: [],
          idempotencyKey,
          proposalId,
          sourceKey,
          sourceSystem,
          splitDetails:
            action === "split" && (originalIds || reason)
              ? {
                  originalIds: originalIds ?? [sourceKey],
                  reason: reason ?? "Identity split correction",
                }
              : null,
          targetCanonicalId,
        });

        if (isJson) {
          console.log(JSON.stringify(proposal, null, 2));
        } else {
          console.log("=== IDENTITY RESOLUTION PROPOSAL CREATED (S03) ===");
          console.log(`Proposal ID: ${proposal.proposalId}`);
          console.log(`Action: ${proposal.action}`);
          console.log(`Confidence: ${proposal.confidence}`);
          console.log(`Source: ${proposal.sourceSystem}:${proposal.sourceKey}`);
          console.log(`Target Canonical: ${proposal.targetCanonicalId}`);
          console.log(`Status: ${proposal.status}`);
        }
        return 0;
      }

      if (sub === "resolve") {
        const proposalId = args[1];
        const decIndex = args.indexOf("--decision-ref");
        const forceOverride = args.includes("--force-override");
        const idemIndex = args.indexOf("--idempotency-key");

        if (!proposalId || decIndex === -1) {
          console.error(
            "Error: Missing required arguments: <proposalId> --decision-ref <ref>"
          );
          console.error(
            "  Usage: operon reconcile resolve <proposalId> --decision-ref <ref> [--force-override] [--idempotency-key <key>] [--json]"
          );
          console.error(
            "  Example: operon reconcile resolve prop_123 --decision-ref dec_supervisor_1 --json"
          );
          return 1;
        }

        const decisionRef = args[decIndex + 1];
        const idempotencyKey =
          idemIndex === -1 ? undefined : args[idemIndex + 1];

        const receipt = yield* ctx.reconciliation.resolveIdentity(
          proposalId,
          decisionRef,
          {
            forceOverride,
            idempotencyKey,
          }
        );

        if (isJson) {
          console.log(JSON.stringify(receipt, null, 2));
        } else {
          console.log("=== IDENTITY RESOLUTION RECEIPT (S03) ===");
          console.log(`Resolution ID: ${receipt.resolutionId}`);
          console.log(`Proposal ID: ${receipt.proposalId}`);
          console.log(`Status: ${receipt.status}`);
          console.log(`Action: ${receipt.action}`);
          console.log(`Canonical ID: ${receipt.canonicalId}`);
          console.log(
            `Historical References: ${receipt.historicalReferences.join(", ")}`
          );
          console.log(
            `Invalidated Projections: ${receipt.invalidatedProjections.join(", ")}`
          );
        }
        return 0;
      }

      if (sub === "list") {
        const proposals = yield* ctx.reconciliation.listProposals();
        if (isJson) {
          console.log(JSON.stringify(proposals, null, 2));
        } else {
          console.log("=== IDENTITY RESOLUTION PROPOSALS ===");
          console.log(`Total: ${proposals.length}`);
          for (const p of proposals) {
            console.log(
              `  - [${p.status.toUpperCase()}] ${p.proposalId}: ${p.action} ${p.sourceSystem}:${p.sourceKey} -> ${p.targetCanonicalId} (conf: ${p.confidence})`
            );
          }
        }
        return 0;
      }

      if (sub === "get") {
        const proposalId = args[1];
        if (!proposalId) {
          console.error("Error: Missing required argument: <proposalId>");
          console.error("  Usage: operon reconcile get <proposalId> [--json]");
          return 1;
        }

        const proposal = yield* ctx.reconciliation.getProposal(proposalId);
        if (isJson) {
          console.log(JSON.stringify(proposal, null, 2));
        } else {
          console.log(`Proposal ID: ${proposal.proposalId}`);
          console.log(`Status: ${proposal.status}`);
          console.log(`Action: ${proposal.action}`);
          console.log(`Confidence: ${proposal.confidence}`);
          console.log(`Source: ${proposal.sourceSystem}:${proposal.sourceKey}`);
          console.log(`Target: ${proposal.targetCanonicalId}`);
        }
        return 0;
      }

      console.error(`Error: Unknown reconcile subcommand '${sub ?? ""}'`);
      console.error("  Available subcommands: propose, resolve, list, get");
      console.error("  Run 'operon reconcile --help' for details.");
      return 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "reconcile", subcommand: args[0] ?? "none" })
  );
}
