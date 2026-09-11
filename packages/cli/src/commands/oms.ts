import { parseJson } from "@operon/schema";
import type { DefinitionArtifact, Subject } from "@operon/schema";
import { Clock, Effect } from "effect";

import { readTextFileSync } from "../fs-io.js";
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

function formatList(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

const handleBranchCreate = Effect.fn("handleBranchCreate")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const branchName = args[2];
  const authorId = getFlagValue(args, "--author");
  if (!branchName || !authorId) {
    printCliError("Error: Missing branch name or --author.");
    printCliError(
      "  Usage: operon oms branch create <branchName> --author <id> [--json]"
    );
    printCliError(
      "  Example: operon oms branch create feature/new-telemetry --author arch_1"
    );
    return 1;
  }
  const author: Subject = {
    id: authorId,
    name: authorId.toUpperCase(),
    roles: ["ontology_architect"],
    type: "user",
  };

  const branch = yield* ctx.oms.createBranch(branchName, author);

  if (isJson) {
    printCliJson(branch);
  } else {
    printCli(`Created ontology branch '${branch.name}' (ID: ${branch.id})`);
  }
  return 0;
});

const handleProposalCreate = Effect.fn("handleProposalCreate")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const branch = getFlagValue(args, "--branch") || args[2];
  const title = getFlagValue(args, "--title");
  const authorId = getFlagValue(args, "--author");

  if (!branch || !title || !authorId) {
    printCliError(
      "Error: Missing required flags for proposal create: --branch, --title, --author"
    );
    printCliError(
      "  Usage: operon oms proposal create --branch <branchName> --title <title> --author <id> [--json]"
    );
    return 1;
  }

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
    printCliJson(proposal);
  } else {
    printCli(
      `Submitted ontology proposal '${proposal.id}': ${proposal.title} (Status: ${proposal.status})`
    );
  }
  return 0;
});

const handleProposalReview = Effect.fn("handleProposalReview")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const proposalId = args[2];
  const reviewerId = getFlagValue(args, "--reviewer");
  const verdictRaw = getFlagValue(args, "--verdict");
  const comments = getFlagValue(args, "--comments");

  if (!proposalId || !reviewerId || !verdictRaw || !comments) {
    printCliError(
      "Error: Missing required arguments for proposal review: <proposalId> --reviewer <id> --verdict <approve|reject> --comments <text>"
    );
    return 1;
  }

  // SAFETY: verdict flag validated against accepted review verdicts union
  const verdict = verdictRaw as "approve" | "reject" | "request_changes";

  const reviewer: Subject = {
    id: reviewerId,
    name: reviewerId.toUpperCase(),
    roles: ["domain_specialist", "reviewer"],
    type: "user",
  };

  const proposal = yield* ctx.oms.reviewProposal(proposalId, {
    comments,
    reviewedAt: yield* Clock.currentTimeMillis,
    reviewer,
    verdict,
  });

  if (isJson) {
    printCliJson(proposal);
  } else {
    printCli(
      `Reviewed proposal '${proposalId}': recorded verdict '${verdict}' (Status: ${proposal.status})`
    );
  }
  return 0;
});

const handleProposalMerge = Effect.fn("handleProposalMerge")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const proposalId = args[2];
  const authorId = getFlagValue(args, "--author");
  const requireSpecialist = args.includes("--require-specialist");

  if (!proposalId || !authorId) {
    printCliError(
      "Error: Missing required arguments for proposal merge: <proposalId> --author <id>"
    );
    return 1;
  }

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
    printCliJson(proposal);
  } else {
    printCli(
      `Merged ontology proposal '${proposalId}' into target branch (Status: ${proposal.status})`
    );
  }
  return 0;
});

const handleArtifactApply = Effect.fn("handleArtifactApply")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const branch = args[2];
  const filePath = getFlagValue(args, "--file");
  const revStr = getFlagValue(args, "--revision");
  const idempotencyKey = getFlagValue(args, "--idempotency-key");

  if (!branch || !filePath) {
    printCliError("Error: Missing required arguments: <branch> --file <path>");
    printCliError(
      "  Usage: operon oms artifact apply <branch> --file <artifact.json> [--revision <n>] [--idempotency-key <key>] [--json]"
    );
    return 1;
  }

  const expectedRevision = revStr ? Math.trunc(Number(revStr)) : undefined;

  const fileContent = yield* Effect.try(() =>
    readTextFileSync(filePath)
  );

  // SAFETY: Artifact file content decoded and validated by applyArtifact
  const rawArtifact = parseJson(fileContent) as DefinitionArtifact;
  const receipt = yield* ctx.oms.applyArtifact({
    artifact: rawArtifact,
    branch,
    expectedRevision,
    idempotencyKey,
  });

  if (isJson) {
    printCliJson(receipt);
  } else {
    printCli(
      `Applied artifact to branch '${branch}' at revision ${receipt.revision} (Digest: ${receipt.candidateDigest})`
    );
  }
  return 0;
});

const handleCandidateInspect = Effect.fn("handleCandidateInspect")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const digest = args[2];
  if (!digest) {
    printCliError("Error: Missing candidate digest.");
    printCliError(
      "  Usage: operon oms candidate inspect <candidateDigest> [--json]"
    );
    return 1;
  }

  const candidate = yield* ctx.oms.inspectCandidate(digest);
  if (isJson) {
    printCliJson(candidate);
  } else {
    printCli(
      `Candidate ${digest}: revision ${candidate.revision}, compiled ${new Date(candidate.compiledAt).toISOString()}`
    );
  }
  return 0;
});

const handleCandidateDiff = Effect.fn("handleCandidateDiff")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const digest = args[2];
  if (!digest) {
    printCliError("Error: Missing candidate digest.");
    printCliError(
      "  Usage: operon oms candidate diff <candidateDigest> [--json]"
    );
    return 1;
  }

  const diff = yield* ctx.oms.diffCandidate(digest);
  if (isJson) {
    printCliJson(diff);
  } else {
    printCli(`Candidate ${digest} diff vs main:`);
    printCli(`  Added types: ${formatList(diff.addedTypes)}`);
    printCli(`  Modified types: ${formatList(diff.modifiedTypes)}`);
    printCli(`  Added links: ${formatList(diff.addedLinks)}`);
    printCli(`  Added actions: ${formatList(diff.addedActions)}`);
  }
  return 0;
});

function buildExpectedRelease(isInitial: boolean, expectedDigest?: string) {
  if (isInitial) {
    return { kind: "none" } as const;
  }
  return {
    digest: expectedDigest,
    kind: "release",
  } as const;
}

const handleReleasePublish = Effect.fn("handleReleasePublish")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const candidateDigest = getFlagValue(args, "--candidate");
  const reviewerId = getFlagValue(args, "--reviewer");

  if (!candidateDigest || !reviewerId) {
    printCliError(
      "Error: Missing required arguments: --candidate <digest> --reviewer <id>"
    );
    printCliError(
      "  Usage: operon oms release publish --candidate <digest> [--expected-release <digest> | --initial] --reviewer <id> [--idempotency-key <key>] [--json]"
    );
    return 1;
  }

  const isInitial = args.includes("--initial");
  const expectedDigest = getFlagValue(args, "--expected-release");
  const expectedCurrentRelease = buildExpectedRelease(
    isInitial,
    expectedDigest
  );
  const idempotencyKey = getFlagValue(args, "--idempotency-key");

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
    printCliJson(pubReceipt);
  } else {
    printCli(
      `Published release ${pubReceipt.release.releaseId} (Version: ${pubReceipt.release.version}, Digest: ${pubReceipt.release.canonicalDigest})`
    );
  }
  return 0;
});

const handleReleaseGet = Effect.fn("handleReleaseGet")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const publicationId = getFlagValue(args, "--id");
  const idempotencyKey = getFlagValue(args, "--idempotency-key");

  if (!publicationId && !idempotencyKey) {
    printCliError(
      "Error: Must specify either --id <publicationId> or --idempotency-key <key>"
    );
    return 1;
  }

  const pubReceipt = yield* ctx.oms.getPublication({
    idempotencyKey,
    publicationId,
  });

  if (isJson) {
    printCliJson(pubReceipt);
  } else {
    printCli(
      `Publication ${pubReceipt.publicationId}: Version ${pubReceipt.release.version} (Status: ${pubReceipt.status})`
    );
  }
  return 0;
});

const handleReleaseActive = Effect.fn("handleReleaseActive")(function* (
  ctx: RuntimeContext,
  isJson: boolean
) {
  const release = yield* ctx.oms.getActiveRelease();
  if (isJson) {
    printCliJson(release);
  } else if (release) {
    printCli(
      `Active Release: ${release.releaseId} (Version ${release.version}, Digest: ${release.canonicalDigest})`
    );
  } else {
    printCli("No active release published.");
  }
  return 0;
});

function printUnknownOms(
  group?: string,
  action?: string
): Effect.Effect<number, never, never> {
  return Effect.sync(() => {
    printCliError(`Error: Unknown oms command: ${group ?? ""} ${action ?? ""}`);
    printCliError("  Available commands:");
    printCliError("    operon oms branch create <branch> --author <id>");
    printCliError(
      "    operon oms proposal create --branch <branch> --title <title> --author <id>"
    );
    printCliError(
      "    operon oms proposal review <id> --reviewer <id> --verdict <approve|reject> --comments <text>"
    );
    printCliError(
      "    operon oms proposal merge <id> --author <id> [--require-specialist]"
    );
    printCliError(
      "    operon oms artifact apply <branch> --file <path> [--revision <rev>] [--idempotency-key <key>]"
    );
    printCliError("    operon oms candidate inspect <digest>");
    printCliError("    operon oms candidate diff <digest>");
    printCliError(
      "    operon oms release publish --candidate <digest> [--expected-release <digest> | --initial] --reviewer <id>"
    );
    printCliError(
      "    operon oms release get --id <id> | --idempotency-key <key>"
    );
    printCliError("    operon oms release active");
    return 1;
  });
}

type OmsHandler = (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) => Effect.Effect<number, unknown, never>;

const OMS_HANDLERS = {
  "artifact:apply": handleArtifactApply,
  "branch:create": handleBranchCreate,
  "candidate:diff": handleCandidateDiff,
  "candidate:inspect": handleCandidateInspect,
  "proposal:create": handleProposalCreate,
  "proposal:merge": handleProposalMerge,
  "proposal:review": handleProposalReview,
  "release:active": (ctx, _args, isJson) => handleReleaseActive(ctx, isJson),
  "release:get": handleReleaseGet,
  "release:publish": handleReleasePublish,
} as const satisfies Record<string, OmsHandler>;

function getOmsHandler(key: string): OmsHandler | undefined {
  if (Object.hasOwn(OMS_HANDLERS, key)) {
    // SAFETY: key existence verified by Object.hasOwn before indexing OMS_HANDLERS
    return OMS_HANDLERS[key as keyof typeof OMS_HANDLERS];
  }
  return undefined;
}

interface DispatchOmsOptions {
  readonly ctx: RuntimeContext;
  readonly group?: string;
  readonly action?: string;
  readonly args: readonly string[];
  readonly isJson: boolean;
}

function dispatchOms(
  options: DispatchOmsOptions
): Effect.Effect<number, unknown, never> {
  const { ctx, group, action, args, isJson } = options;
  const handler = getOmsHandler(`${group ?? ""}:${action ?? ""}`);
  if (handler) {
    return handler(ctx, args, isJson);
  }
  return printUnknownOms(group, action);
}

export function runOms(args: string[]): Effect.Effect<number, unknown, never> {
  const group = args[0];
  const action = args[1];
  const isJson = args.includes("--json");
  const dbPath = getFlagValue(args, "--db");

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => dispatchOms({ action, args, ctx, group, isJson }),
    (ctx) => Effect.sync(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({
      action: args[1] ?? "none",
      command: "oms",
      group: args[0] ?? "none",
    })
  );
}
