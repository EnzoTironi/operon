import type { Subject } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runOms(args: string[]): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const group = args[0];
    const action = args[1];
    const isJson = args.includes("--json");

    const ctx = yield* Effect.tryPromise({
      catch: (e) => e,
      try: () => createRuntimeContext(),
    });

    try {
      if (group === "branch" && action === "create") {
        const branchName = args[2];
        const authorIndex = args.indexOf("--author");
        if (!branchName || authorIndex === -1) {
          console.error("Error: Missing branch name or --author.");
          console.error(
            "  Usage: operon oms branch create <branchName> --author <id> [--json]"
          );
          console.error(
            "  Example: operon oms branch create feature/new-telemetry --author arch_1"
          );
          return 1;
        }
        const authorId = args[authorIndex + 1];
        const author: Subject = {
          id: authorId,
          name: authorId.toUpperCase(),
          roles: ["ontology_architect"],
          type: "user",
        };

        const branch = yield* ctx.oms.createBranch(branchName, author);

        if (isJson) {
          console.log(JSON.stringify(branch, null, 2));
        } else {
          console.log(
            `Created ontology branch '${branch.name}' (ID: ${branch.id})`
          );
        }
        return 0;
      }

      if (group === "proposal" && action === "create") {
        const branchIndex = args.indexOf("--branch");
        const titleIndex = args.indexOf("--title");
        const authorIndex = args.indexOf("--author");

        if (branchIndex === -1 || titleIndex === -1 || authorIndex === -1) {
          console.error(
            "Error: Missing required flags for proposal create: --branch, --title, --author"
          );
          console.error(
            "  Usage: operon oms proposal create --branch <branchName> --title <title> --author <id> [--json]"
          );
          return 1;
        }

        const branch = args[branchIndex + 1];
        const title = args[titleIndex + 1];
        const authorId = args[authorIndex + 1];
        const author: Subject = {
          id: authorId,
          name: authorId.toUpperCase(),
          roles: ["ontology_architect"],
          type: "user",
        };

        const proposal = yield* ctx.oms.createProposal({
          author,
          changeSet: {
            addedActionTypes: [],
            addedLinkTypes: [],
            addedObjectTypes: [],
            deletedActionTypeIds: [],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: [],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: title,
          sourceBranch: branch,
          title,
        });

        if (isJson) {
          console.log(JSON.stringify(proposal, null, 2));
        } else {
          console.log(
            `Submitted ontology proposal '${proposal.id}': ${proposal.title} (Status: ${proposal.status})`
          );
        }
        return 0;
      }

      if (group === "proposal" && action === "review") {
        const proposalId = args[2];
        const reviewerIndex = args.indexOf("--reviewer");
        const verdictIndex = args.indexOf("--verdict");
        const commentsIndex = args.indexOf("--comments");

        if (
          !proposalId ||
          reviewerIndex === -1 ||
          verdictIndex === -1 ||
          commentsIndex === -1
        ) {
          console.error(
            "Error: Missing required arguments for proposal review: <proposalId> --reviewer <id> --verdict <approve|reject> --comments <text>"
          );
          return 1;
        }

        const reviewerId = args[reviewerIndex + 1];
        const verdict = args[verdictIndex + 1] as
          | "approve"
          | "reject"
          | "request_changes";
        const comments = args[commentsIndex + 1];

        const reviewer: Subject = {
          id: reviewerId,
          name: reviewerId.toUpperCase(),
          roles: ["domain_specialist", "reviewer"],
          type: "user",
        };

        const proposal = yield* ctx.oms.reviewProposal(proposalId, {
          comments,
          reviewedAt: Date.now(),
          reviewer,
          verdict,
        });

        if (isJson) {
          console.log(JSON.stringify(proposal, null, 2));
        } else {
          console.log(
            `Reviewed proposal '${proposalId}': recorded verdict '${verdict}' (Status: ${proposal.status})`
          );
        }
        return 0;
      }

      if (group === "proposal" && action === "merge") {
        const proposalId = args[2];
        const authorIndex = args.indexOf("--author");
        const requireSpecialist = args.includes("--require-specialist");

        if (!proposalId || authorIndex === -1) {
          console.error(
            "Error: Missing required arguments for proposal merge: <proposalId> --author <id>"
          );
          return 1;
        }

        const authorId = args[authorIndex + 1];
        const author: Subject = {
          id: authorId,
          name: authorId.toUpperCase(),
          roles: ["lead_architect"],
          type: "user",
        };

        const proposal = yield* ctx.oms.mergeProposal(proposalId, author, {
          requireComplianceReview: false,
          requireDomainSpecialistReview: requireSpecialist,
          requiredMinApprovals: 1,
        });

        if (isJson) {
          console.log(JSON.stringify(proposal, null, 2));
        } else {
          console.log(
            `Merged ontology proposal '${proposalId}' into target branch (Status: ${proposal.status})`
          );
        }
        return 0;
      }

      console.error(`Error: Unknown oms command: ${group} ${action}`);
      console.error("  Available commands:");
      console.error("    operon oms branch create <branch> --author <id>");
      console.error(
        "    operon oms proposal create --branch <branch> --title <title> --author <id>"
      );
      console.error(
        "    operon oms proposal review <id> --reviewer <id> --verdict <approve|reject> --comments <text>"
      );
      console.error(
        "    operon oms proposal merge <id> --author <id> [--require-specialist]"
      );
      return 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({
      action: args[1] ?? "none",
      command: "oms",
      group: args[0] ?? "none",
    })
  );
}
