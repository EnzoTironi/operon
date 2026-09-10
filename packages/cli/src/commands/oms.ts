import * as fs from "node:fs";

import type { Subject } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runOms(args: string[]): Effect.Effect<number, unknown, never> {
  const group = args[0];
  const action = args[1];
  const isJson = args.includes("--json");

  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) =>
      Effect.gen(function* () {
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

        if (group === "artifact" && action === "apply") {
          const branch = args[2];
          const fileIndex = args.indexOf("--file");
          const revIndex = args.indexOf("--revision");
          const idempIndex = args.indexOf("--idempotency-key");

          if (!branch || fileIndex === -1) {
            console.error(
              "Error: Missing required arguments: <branch> --file <path>"
            );
            console.error(
              "  Usage: operon oms artifact apply <branch> --file <artifact.json> [--revision <n>] [--idempotency-key <key>] [--json]"
            );
            return 1;
          }

          const filePath = args[fileIndex + 1];
          const expectedRevision =
            revIndex === -1
              ? undefined
              : Math.trunc(Number(args[revIndex + 1]));
          const idempotencyKey =
            idempIndex === -1 ? undefined : args[idempIndex + 1];

          const fileContent = yield* Effect.try(() =>
            fs.readFileSync(filePath, "utf-8")
          );

          const rawArtifact = JSON.parse(fileContent);
          const receipt = yield* ctx.oms.applyArtifact({
            artifact: rawArtifact,
            branch,
            expectedRevision,
            idempotencyKey,
          });

          if (isJson) {
            console.log(JSON.stringify(receipt, null, 2));
          } else {
            console.log(
              `Applied artifact to branch '${branch}' at revision ${receipt.revision} (Digest: ${receipt.candidateDigest})`
            );
          }
          return 0;
        }

        if (group === "candidate" && action === "inspect") {
          const digest = args[2];
          if (!digest) {
            console.error("Error: Missing candidate digest.");
            console.error(
              "  Usage: operon oms candidate inspect <candidateDigest> [--json]"
            );
            return 1;
          }

          const candidate = yield* ctx.oms.inspectCandidate(digest);
          if (isJson) {
            console.log(JSON.stringify(candidate, null, 2));
          } else {
            console.log(
              `Candidate ${digest}: revision ${candidate.revision}, compiled ${new Date(candidate.compiledAt).toISOString()}`
            );
          }
          return 0;
        }

        if (group === "candidate" && action === "diff") {
          const digest = args[2];
          if (!digest) {
            console.error("Error: Missing candidate digest.");
            console.error(
              "  Usage: operon oms candidate diff <candidateDigest> [--json]"
            );
            return 1;
          }

          const diff = yield* ctx.oms.diffCandidate(digest);
          if (isJson) {
            console.log(JSON.stringify(diff, null, 2));
          } else {
            console.log(`Candidate ${digest} diff vs main:`);
            console.log(
              `  Added types: ${diff.addedTypes.join(", ") || "none"}`
            );
            console.log(
              `  Modified types: ${diff.modifiedTypes.join(", ") || "none"}`
            );
            console.log(
              `  Added links: ${diff.addedLinks.join(", ") || "none"}`
            );
            console.log(
              `  Added actions: ${diff.addedActions.join(", ") || "none"}`
            );
          }
          return 0;
        }

        if (group === "release" && action === "publish") {
          const candidateIndex = args.indexOf("--candidate");
          const expectedIndex = args.indexOf("--expected-release");
          const isInitial = args.includes("--initial");
          const reviewerIndex = args.indexOf("--reviewer");
          const idempIndex = args.indexOf("--idempotency-key");

          if (candidateIndex === -1 || reviewerIndex === -1) {
            console.error(
              "Error: Missing required arguments: --candidate <digest> --reviewer <id>"
            );
            console.error(
              "  Usage: operon oms release publish --candidate <digest> [--expected-release <digest> | --initial] --reviewer <id> [--idempotency-key <key>] [--json]"
            );
            return 1;
          }

          const candidateDigest = args[candidateIndex + 1];
          const reviewerId = args[reviewerIndex + 1];
          const idempotencyKey =
            idempIndex === -1 ? undefined : args[idempIndex + 1];
          const expectedCurrentRelease = isInitial
            ? ({ kind: "none" } as const)
            : ({
                digest:
                  expectedIndex === -1 ? undefined : args[expectedIndex + 1],
                kind: "release",
              } as const);

          const publisher: Subject = {
            id: reviewerId,
            name: reviewerId.toUpperCase(),
            roles: ["lead_architect"],
            type: "user",
          };

          const pubReceipt = yield* ctx.oms.publishRelease({
            candidateDigest,
            expectedCurrentRelease,
            idempotencyKey,
            publisher,
            reviewRefs: [`rev_${reviewerId}`],
          });

          if (isJson) {
            console.log(JSON.stringify(pubReceipt, null, 2));
          } else {
            console.log(
              `Published release ${pubReceipt.release.releaseId} (Version: ${pubReceipt.release.version}, Digest: ${pubReceipt.release.canonicalDigest})`
            );
          }
          return 0;
        }

        if (group === "release" && action === "get") {
          const idIndex = args.indexOf("--id");
          const idempIndex = args.indexOf("--idempotency-key");

          if (idIndex === -1 && idempIndex === -1) {
            console.error(
              "Error: Must specify either --id <publicationId> or --idempotency-key <key>"
            );
            return 1;
          }

          const publicationId = idIndex === -1 ? undefined : args[idIndex + 1];
          const idempotencyKey =
            idempIndex === -1 ? undefined : args[idempIndex + 1];

          const pubReceipt = yield* ctx.oms.getPublication({
            idempotencyKey,
            publicationId,
          });

          if (isJson) {
            console.log(JSON.stringify(pubReceipt, null, 2));
          } else {
            console.log(
              `Publication ${pubReceipt.publicationId}: Version ${pubReceipt.release.version} (Status: ${pubReceipt.status})`
            );
          }
          return 0;
        }

        if (group === "release" && action === "active") {
          const release = yield* ctx.oms.getActiveRelease();
          if (isJson) {
            console.log(JSON.stringify(release, null, 2));
          } else if (release) {
            console.log(
              `Active Release: ${release.releaseId} (Version ${release.version}, Digest: ${release.canonicalDigest})`
            );
          } else {
            console.log("No active release published.");
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
        console.error(
          "    operon oms artifact apply <branch> --file <path> [--revision <rev>] [--idempotency-key <key>]"
        );
        console.error("    operon oms candidate inspect <digest>");
        console.error("    operon oms candidate diff <digest>");
        console.error(
          "    operon oms release publish --candidate <digest> [--expected-release <digest> | --initial] --reviewer <id>"
        );
        console.error(
          "    operon oms release get --id <id> | --idempotency-key <key>"
        );
        console.error("    operon oms release active");
        return 1;
      }),
    (ctx) => Effect.sync(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({
      action: args[1] ?? "none",
      command: "oms",
      group: args[0] ?? "none",
    })
  );
}
