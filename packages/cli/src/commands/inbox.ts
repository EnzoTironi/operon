import type { Subject } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export async function runInbox(args: string[]): Promise<number> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

  const ctx = await createRuntimeContext(dbPath);

  try {
    if (sub === "list") {
      const proposals = ctx.inbox.getPendingProposals();
      const output = proposals.map((p) => ({
        actionTypeId: p.submission.actionType.id,
        createdAt: new Date(p.createdAt).toISOString(),
        evidenceHash: p.evidenceHash,
        id: p.id,
        proposerId: p.submission.security.subject.id,
        status: p.status,
      }));

      if (isJson) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log("=== ACTION INBOX: PENDING PROPOSALS ===");
        if (output.length === 0) {
          console.log("No pending proposals awaiting human review.");
        } else {
          for (const p of output) {
            console.log(`• Proposal ID: ${p.id}`);
            console.log(
              `  Action: ${p.actionTypeId} | Submitted by: ${p.proposerId} at ${p.createdAt}`
            );
            console.log(`  Evidence Digest: ${p.evidenceHash}`);
          }
        }
      }
      return 0;
    }

    if (sub === "approve") {
      const proposalId = args[1];
      const reviewerIndex = args.indexOf("--reviewer");
      const roleIndex = args.indexOf("--role");
      const hashIndex = args.indexOf("--evidence-hash");

      if (!proposalId || reviewerIndex === -1 || roleIndex === -1) {
        console.error(
          "Error: Missing required arguments: <proposalId> --reviewer <id> --role <role>"
        );
        console.error(
          "  Usage: operon inbox approve <proposalId> --reviewer <id> --role <role> [--evidence-hash <hash>] [--json]"
        );
        console.error(
          "  Example: operon inbox approve proposal_123 --reviewer dr_li --role physician"
        );
        return 1;
      }

      const reviewerId = args[reviewerIndex + 1];
      const role = args[roleIndex + 1];
      const expectedHash = hashIndex === -1 ? undefined : args[hashIndex + 1];

      const reviewer: Subject = {
        id: reviewerId,
        name: reviewerId.toUpperCase(),
        roles: [role],
        type: "user",
      };

      const result = await Effect.runPromise(
        ctx.inbox.approveProposal(proposalId, reviewer, expectedHash)
      );

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              approver: reviewerId,
              decisionRecordHash: result.recordHash,
              proposalId,
              status: "APPROVED_AND_COMMITTED",
            },
            null,
            2
          )
        );
      } else {
        console.log(`=== PROPOSAL APPROVED & COMMITTED ===`);
        console.log(`Proposal ID: ${proposalId}`);
        console.log(`Approved by: ${reviewerId} (Role: ${role})`);
        console.log(`Decision Hash: ${result.recordHash}`);
      }
      return 0;
    }

    if (sub === "reject") {
      const proposalId = args[1];
      const reviewerIndex = args.indexOf("--reviewer");
      const roleIndex = args.indexOf("--role");
      const reasonIndex = args.indexOf("--reason");

      if (
        !proposalId ||
        reviewerIndex === -1 ||
        roleIndex === -1 ||
        reasonIndex === -1
      ) {
        console.error(
          "Error: Missing required arguments: <proposalId> --reviewer <id> --role <role> --reason <reason>"
        );
        console.error(
          "  Usage: operon inbox reject <proposalId> --reviewer <id> --role <role> --reason <reason> [--json]"
        );
        console.error(
          '  Example: operon inbox reject proposal_123 --reviewer supervisor --role operator --reason "Out of bounds"'
        );
        return 1;
      }

      const reviewerId = args[reviewerIndex + 1];
      const role = args[roleIndex + 1];
      const reason = args[reasonIndex + 1];

      const reviewer: Subject = {
        id: reviewerId,
        name: reviewerId.toUpperCase(),
        roles: [role],
        type: "user",
      };

      const record = await Effect.runPromise(
        ctx.inbox.rejectProposal(proposalId, reviewer, "safety_veto", reason)
      );

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              overrideId: record.id,
              proposalId,
              reason,
              rejector: reviewerId,
              status: "REJECTED",
            },
            null,
            2
          )
        );
      } else {
        console.log(`=== PROPOSAL REJECTED ===`);
        console.log(`Proposal ID: ${proposalId}`);
        console.log(`Rejected by: ${reviewerId}`);
        console.log(`Reason: ${reason}`);
        console.log(`Override Dossier ID: ${record.id}`);
      }
      return 0;
    }

    console.error(`Error: Unknown inbox subcommand '${sub ?? ""}'`);
    console.error("  Available subcommands: list, approve, reject");
    console.error("  Run 'operon inbox --help' for details.");
    return 1;
  } finally {
    ctx.close();
  }
}
