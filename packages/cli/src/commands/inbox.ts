import type { Subject } from "@operon/schema";
import { Effect } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";
import { createRuntimeContext } from "../state.js";
import type { RuntimeContext } from "../state.js";

interface PendingProposalOutput {
  readonly actionTypeId: string;
  readonly createdAt: string;
  readonly evidenceHash: string;
  readonly id: string;
  readonly proposerId: string;
  readonly status: string;
}

function printProposalsHuman(output: readonly PendingProposalOutput[]) {
  printCli("=== ACTION INBOX: PENDING PROPOSALS ===");
  if (output.length === 0) {
    printCli("No pending proposals awaiting human review.");
    return;
  }
  for (const p of output) {
    printCli(`• Proposal ID: ${p.id}`);
    printCli(
      `  Action: ${p.actionTypeId} | Submitted by: ${p.proposerId} at ${p.createdAt}`
    );
    printCli(`  Evidence Digest: ${p.evidenceHash}`);
  }
}

function handleInboxList(ctx: RuntimeContext, isJson: boolean) {
  const proposals = ctx.inbox.getPendingProposals();
  const output: readonly PendingProposalOutput[] = proposals.map((p) => ({
    actionTypeId: p.submission.actionType.id,
    createdAt: new Date(p.createdAt).toISOString(),
    evidenceHash: p.evidenceHash,
    id: p.id,
    proposerId: p.submission.security.subject.id,
    status: p.status,
  }));

  if (isJson) {
    printCli(JSON.stringify(output, null, 2));
  } else {
    printProposalsHuman(output);
  }
  return Effect.succeed(0);
}

const handleInboxApprove = Effect.fn("handleInboxApprove")(function* (
  ctx: RuntimeContext,
  args: string[],
  isJson: boolean
) {
  const proposalId = args[1];
  const reviewerIndex = args.indexOf("--reviewer");
  const roleIndex = args.indexOf("--role");
  const hashIndex = args.indexOf("--evidence-hash");

  if (!proposalId || reviewerIndex === -1 || roleIndex === -1) {
    printCliError(
      "Error: Missing required arguments: <proposalId> --reviewer <id> --role <role>"
    );
    printCliError(
      "  Usage: operon inbox approve <proposalId> --reviewer <id> --role <role> [--evidence-hash <hash>] [--json]"
    );
    printCliError(
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

  const result = yield* ctx.inbox.approveProposal(
    proposalId,
    reviewer,
    expectedHash
  );

  if (isJson) {
    printCliJson({
      approver: reviewerId,
      decisionRecordHash: result.recordHash,
      proposalId,
      status: "APPROVED_AND_COMMITTED",
    });
  } else {
    printCli(`=== PROPOSAL APPROVED & COMMITTED ===`);
    printCli(`Proposal ID: ${proposalId}`);
    printCli(`Approved by: ${reviewerId} (Role: ${role})`);
    printCli(`Decision Hash: ${result.recordHash}`);
  }
  return 0;
});

const handleInboxReject = Effect.fn("handleInboxReject")(function* (
  ctx: RuntimeContext,
  args: string[],
  isJson: boolean
) {
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
    printCliError(
      "Error: Missing required arguments: <proposalId> --reviewer <id> --role <role> --reason <reason>"
    );
    printCliError(
      "  Usage: operon inbox reject <proposalId> --reviewer <id> --role <role> --reason <reason> [--json]"
    );
    printCliError(
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

  const record = yield* ctx.inbox.rejectProposal(
    proposalId,
    reviewer,
    "safety_veto",
    reason
  );

  if (isJson) {
    printCliJson({
      overrideId: record.id,
      proposalId,
      reason,
      rejector: reviewerId,
      status: "REJECTED",
    });
  } else {
    printCli(`=== PROPOSAL REJECTED ===`);
    printCli(`Proposal ID: ${proposalId}`);
    printCli(`Rejected by: ${reviewerId}`);
    printCli(`Reason: ${reason}`);
    printCli(`Override Dossier ID: ${record.id}`);
  }
  return 0;
});

const executeInbox = Effect.fn("executeInbox")(function* (
  ctx: RuntimeContext,
  sub: string | undefined,
  args: string[],
  isJson: boolean
) {
  if (sub === "list") {
    return yield* handleInboxList(ctx, isJson);
  }
  if (sub === "approve") {
    return yield* handleInboxApprove(ctx, args, isJson);
  }
  if (sub === "reject") {
    return yield* handleInboxReject(ctx, args, isJson);
  }

  printCliError(`Error: Unknown inbox subcommand '${sub ?? ""}'`);
  printCliError("  Available subcommands: list, approve, reject");
  printCliError("  Run 'operon inbox --help' for details.");
  return 1;
});

export function runInbox(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => executeInbox(ctx, sub, args, isJson),
    (ctx) => Effect.promise(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "inbox", subcommand: args[0] ?? "none" })
  );
}
