import type { ActionExecutionResult } from "@operon/runtime";
import { executeWritePipeline } from "@operon/runtime";
import type {
  ActionParameters,
  ActionType,
  ApprovalRecord,
  OperationReceipt,
  OutboxItem,
} from "@operon/schema";
import { parseJson } from "@operon/schema";
import { Effect, Exit, Schema } from "effect";

import { readStdinSync } from "../fs-io.js";
import { printCli, printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext, createSubject } from "../state.js";

function getFlagValue(
  args: readonly string[],
  flag: string
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function extractErrorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

const VALID_AGENT_TIERS = new Set([1, 2, 3, 4]);

function parseAgentTier(
  rawTier?: string,
  fallback: 1 | 2 | 3 | 4 = 2
): 1 | 2 | 3 | 4 {
  if (!rawTier) {
    return fallback;
  }
  const num = Math.trunc(Number(rawTier));
  if (VALID_AGENT_TIERS.has(num)) {
    // SAFETY: VALID_AGENT_TIERS strictly guarantees num is 1, 2, 3, or 4
    return num as 1 | 2 | 3 | 4;
  }
  return fallback;
}

function parseSubjectType(rawType?: string): "user" | "agent" {
  if (rawType === "user") {
    return "user";
  }
  return "agent";
}

function extractSubjectFromArgs(
  args: readonly string[],
  defaultTier: 1 | 2 | 3 | 4 = 2
) {
  const subjectId = getFlagValue(args, "--subject-id") ?? "cli_agent";
  const subjectType = parseSubjectType(getFlagValue(args, "--subject-type"));
  const role = getFlagValue(args, "--role");
  const roles = role ? [role] : ["operator", "clinician"];
  const agentTier = parseAgentTier(
    getFlagValue(args, "--agent-tier"),
    defaultTier
  );
  return createSubject(subjectId, subjectType, roles, agentTier);
}

function readRawParameters(
  useStdin: boolean,
  args: readonly string[]
): Effect.Effect<ActionParameters, Error> {
  if (useStdin) {
    return Effect.try({
      catch: (cause) =>
        new Error(`Failed to parse JSON from stdin: ${String(cause)}`),
      // SAFETY: parsed JSON from stdin as ActionParameters
      try: () => parseJson(readStdinSync()) as ActionParameters,
    });
  }
  const paramsStr = getFlagValue(args, "--params");
  if (!paramsStr) {
    return Effect.succeed({});
  }
  return Effect.try({
    catch: (cause) =>
      new Error(`--params must be valid JSON: ${String(cause)}`),
    // SAFETY: parsed JSON from --params flag as ActionParameters
    try: () => JSON.parse(paramsStr) as ActionParameters,
  });
}

function handleActionList(ctx: RuntimeContext, isJson: boolean) {
  return Effect.sync(() => {
    const actions = ctx.actionTypes.map((a) => ({
      defaultExecutionMode: a.defaultExecutionMode,
      description: a.description,
      id: a.id,
      minimumAgentTier: a.minimumAgentTier,
      name: a.name,
      riskTier: a.riskTier,
      targetObjectTypeId: a.targetObjectTypeId,
    }));

    if (isJson) {
      printCliJson(actions);
    } else {
      printCli("=== OPERON REGISTERED ACTION TYPES ===");
      for (const a of actions) {
        printCli(
          `• ${a.id} (${a.name}) | Risk: ${a.riskTier} | Min Tier: ${a.minimumAgentTier} | Mode: ${a.defaultExecutionMode}`
        );
        printCli(`  ${a.description}`);
      }
    }
    return 0;
  });
}

function printPreparedResult(prepared: {
  readonly actionId: string;
  readonly canonicalDigest: string;
  readonly expiresAt: number;
  readonly id: string;
  readonly objectRevisions: readonly unknown[];
  readonly predicateDependencies: readonly unknown[];
  readonly verdict: string;
}): void {
  printCli("=== ACTION PREPARED (ZERO BUSINESS SIDE EFFECTS) ===");
  printCli("Status: PREPARED");
  printCli(`Prepared ID: ${prepared.id}`);
  printCli(`Canonical Digest: ${prepared.canonicalDigest}`);
  printCli(`Action ID: ${prepared.actionId}`);
  printCli(`Verdict: ${prepared.verdict}`);
  printCli(`Object Revisions: ${prepared.objectRevisions.length}`);
  printCli(`Predicate Dependencies: ${prepared.predicateDependencies.length}`);
  printCli(`Expires At: ${new Date(prepared.expiresAt).toISOString()}`);
}

function extractPrepareOptions(args: readonly string[]) {
  const grantId = getFlagValue(args, "--grant-id");
  const tenantId = getFlagValue(args, "--tenant") ?? "default";
  const environmentId = getFlagValue(args, "--env") ?? "default";
  const ttlStr = getFlagValue(args, "--ttl");
  const ttlMs = ttlStr ? Number(ttlStr) : undefined;
  const proposer = extractSubjectFromArgs(args, 2);
  return { environmentId, grantId, proposer, tenantId, ttlMs };
}

interface PreparedActionOutput {
  readonly actionId: string;
  readonly actionRelease: string;
  readonly canonicalDigest: string;
  readonly environmentId: string;
  readonly expiresAt: number;
  readonly grantId?: string;
  readonly id: string;
  readonly normalizedParameters: ActionParameters;
  readonly objectRevisions: readonly unknown[];
  readonly predicateDependencies: readonly unknown[];
  readonly preparedAt: number;
  readonly proposer: { readonly id: string };
  readonly requestedEffects: readonly unknown[];
  readonly reviewReasons?: readonly string[];
  readonly tenantId: string;
  readonly verdict: string;
}

function outputPrepared(prepared: PreparedActionOutput, isJson: boolean): void {
  if (isJson) {
    printCli(
      JSON.stringify(
        {
          actionId: prepared.actionId,
          actionRelease: prepared.actionRelease,
          canonicalDigest: prepared.canonicalDigest,
          environmentId: prepared.environmentId,
          expiresAt: prepared.expiresAt,
          grantId: prepared.grantId,
          id: prepared.id,
          normalizedParameters: prepared.normalizedParameters,
          objectRevisionsCount: prepared.objectRevisions.length,
          predicateDependenciesCount: prepared.predicateDependencies.length,
          preparedAt: prepared.preparedAt,
          proposerId: prepared.proposer.id,
          requestedEffectsCount: prepared.requestedEffects.length,
          reviewReasons: prepared.reviewReasons ?? [],
          status: "PREPARED",
          tenantId: prepared.tenantId,
          verdict: prepared.verdict,
        },
        null,
        2
      )
    );
  } else {
    printPreparedResult(prepared);
  }
}

function isInvalidActionId(id?: string): boolean {
  return !id || id.startsWith("-");
}

const handleActionPrepare = Effect.fn("handleActionPrepare")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean,
  useStdin: boolean
) {
  const actionId = args[1];
  if (isInvalidActionId(actionId)) {
    printCliError("Error: Missing action ID for prepare.");
    printCliError(
      "  Usage: operon action prepare <actionId> [--params '<json>' | --stdin] [--grant-id <id>] [--agent-tier <1-4>] [--json]"
    );
    return 1;
  }

  // SAFETY: isInvalidActionId guarantees actionId is a non-empty string
  const targetActionId = actionId as string;
  const action = ctx.actionTypes.find((a) => a.id === targetActionId);
  if (!action) {
    printCliError(`Error: ActionType '${targetActionId}' not found.`);
    return 1;
  }

  const paramsExit = yield* readRawParameters(useStdin, args).pipe(Effect.exit);
  if (Exit.isFailure(paramsExit)) {
    printCliError(paramsExit.cause);
    return 1;
  }

  const opts = extractPrepareOptions(args);
  const preparedRes = yield* Effect.exit(
    ctx.governedActions.prepareAction({
      actionId: targetActionId,
      environmentId: opts.environmentId,
      grantId: opts.grantId,
      proposer: opts.proposer,
      rawParameters: paramsExit.value,
      tenantId: opts.tenantId,
      ttlMs: opts.ttlMs,
    })
  );

  if (Exit.isFailure(preparedRes)) {
    printCliError(
      `Error: Action preparation failed: ${extractErrorMessage(preparedRes.cause)}`
    );
    return 1;
  }

  outputPrepared(preparedRes.value, isJson);
  return 0;
});

function parseApprovalDecision(rawDecision?: string): "approved" | "rejected" {
  if (rawDecision === "reject" || rawDecision === "rejected") {
    return "rejected";
  }
  return "approved";
}

function parseAssuranceLevel(
  rawAssurance?: string
): "human_verified" | "delegated_service" {
  if (rawAssurance === "delegated_service") {
    return "delegated_service";
  }
  return "human_verified";
}

function printApprovalResult(approval: {
  readonly approvedAt: number;
  readonly decision: string;
  readonly id: string;
  readonly preparedDigest: string;
  readonly recordHash: string;
  readonly reviewerContext: { readonly reviewer: { readonly id: string } };
}): void {
  printCli("=== ACTION PROPOSAL APPROVED ===");
  printCli(`Approval ID: ${approval.id}`);
  printCli(`Decision: ${approval.decision.toUpperCase()}`);
  printCli(`Prepared Digest: ${approval.preparedDigest}`);
  printCli(`Record Hash: ${approval.recordHash}`);
  printCli(`Reviewer: ${approval.reviewerContext.reviewer.id}`);
  printCli(`Approved At: ${new Date(approval.approvedAt).toISOString()}`);
}

function extractReviewerId(args: readonly string[]): string {
  const specific = getFlagValue(args, "--reviewer-id");
  if (specific) {
    return specific;
  }
  return getFlagValue(args, "--reviewer") ?? "operator_human";
}

function extractApproveOptions(args: readonly string[]) {
  const decision = parseApprovalDecision(getFlagValue(args, "--decision"));
  const reason = getFlagValue(args, "--reason");
  const reviewerId = extractReviewerId(args);
  const role = getFlagValue(args, "--role") ?? "operator";
  const assurance = parseAssuranceLevel(getFlagValue(args, "--assurance"));
  const tenantId = getFlagValue(args, "--tenant") ?? "default";
  const environmentId = getFlagValue(args, "--env") ?? "default";
  const reviewer = createSubject(reviewerId, "user", [role]);
  return { assurance, decision, environmentId, reason, reviewer, tenantId };
}

function outputApproval(approval: ApprovalRecord, isJson: boolean): void {
  if (isJson) {
    printCli(
      JSON.stringify(
        {
          approvalId: approval.id,
          approvedAt: approval.approvedAt,
          decision: approval.decision,
          expiresAt: approval.expiresAt,
          preparedDigest: approval.preparedDigest,
          recordHash: approval.recordHash,
          reviewerId: approval.reviewerContext.reviewer.id,
          status: "APPROVED",
          viewedDigest: approval.viewedDigest,
        },
        null,
        2
      )
    );
  } else {
    printApprovalResult(approval);
  }
}

const handleActionApprove = Effect.fn("handleActionApprove")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const preparedDigest = args[1];
  const viewedDigest = getFlagValue(args, "--viewed-digest");

  if (!preparedDigest || !viewedDigest) {
    printCliError(
      "Error: Missing preparedDigest or --viewed-digest for approve."
    );
    printCliError(
      "  Usage: operon action approve <preparedDigest> --viewed-digest <digest> [--decision approve|reject] [--reason <text>] [--json]"
    );
    return 1;
  }

  const opts = extractApproveOptions(args);
  const approveRes = yield* Effect.exit(
    ctx.governedActions.approvePreparedAction({
      decision: opts.decision,
      preparedDigest,
      reason: opts.reason,
      reviewerContext: {
        assurance: opts.assurance,
        environmentId: opts.environmentId,
        reviewer: opts.reviewer,
        tenantId: opts.tenantId,
      },
      viewedDigest,
    })
  );

  if (Exit.isFailure(approveRes)) {
    printCliError(
      `Error: Approval failed: ${extractErrorMessage(approveRes.cause)}`
    );
    return 1;
  }

  outputApproval(approveRes.value, isJson);
  return 0;
});

function printCommitReceipt(receipt: {
  readonly committedAt: number;
  readonly operationId: string;
  readonly outboxItems: readonly unknown[];
  readonly receiptDigest: string;
  readonly status: string;
  readonly updatedObjects: readonly unknown[];
}): void {
  printCli("=== LOCAL ATOMIC COMMIT SUCCESSFUL ===");
  printCli(`Operation ID: ${receipt.operationId}`);
  printCli(`Status: ${receipt.status}`);
  printCli(`Receipt Digest: ${receipt.receiptDigest}`);
  printCli(`Updated Objects: ${receipt.updatedObjects.length}`);
  printCli(`Outbox Items: ${receipt.outboxItems.length}`);
  printCli(`Committed At: ${new Date(receipt.committedAt).toISOString()}`);
}

function extractTenantAndEnv(args: readonly string[]) {
  const tenantId = getFlagValue(args, "--tenant") ?? "default";
  const environmentId = getFlagValue(args, "--env") ?? "default";
  return { environmentId, tenantId };
}

function outputCommitReceipt(receipt: OperationReceipt, isJson: boolean): void {
  if (isJson) {
    printCli(
      JSON.stringify(
        {
          actionId: receipt.actionId,
          committedAt: receipt.committedAt,
          decisionRecordId: receipt.decisionRecordId,
          idempotencyKey: receipt.idempotencyKey,
          operationId: receipt.operationId,
          outboxItemsCount: receipt.outboxItems.length,
          preparedDigest: receipt.preparedDigest,
          receiptDigest: receipt.receiptDigest,
          status: receipt.status,
          updatedObjectsCount: receipt.updatedObjects.length,
        },
        null,
        2
      )
    );
  } else {
    printCommitReceipt(receipt);
  }
}

const loadPreparedAndApproval = Effect.fn("loadPreparedAndApproval")(function* (
  ctx: RuntimeContext,
  preparedDigest: string,
  approvalId: string | undefined,
  tenantId: string
) {
  const preparedRes = yield* Effect.exit(
    ctx.governedActions.getPreparedAction(preparedDigest, tenantId)
  );
  if (Exit.isFailure(preparedRes)) {
    printCliError(
      `Error: Prepared action not found for digest '${preparedDigest}'.`
    );
    return null;
  }
  if (!approvalId) {
    return { approval: undefined, prepared: preparedRes.value };
  }
  const approvalRes = yield* Effect.exit(
    ctx.governedActions.getApprovalRecord(approvalId, tenantId)
  );
  if (Exit.isFailure(approvalRes)) {
    printCliError(`Error: Approval record not found for id '${approvalId}'.`);
    return null;
  }
  return { approval: approvalRes.value, prepared: preparedRes.value };
});

const handleActionCommit = Effect.fn("handleActionCommit")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const preparedDigest = args[1];
  const idempotencyKey = getFlagValue(args, "--idempotency-key");
  if (!preparedDigest || !idempotencyKey) {
    printCliError(
      "Error: Missing preparedDigest or --idempotency-key for commit."
    );
    printCliError(
      "  Usage: operon action commit <preparedDigest> [--approval-id <id>] --idempotency-key <key> [--json]"
    );
    return 1;
  }

  const approvalId = getFlagValue(args, "--approval-id");
  const { environmentId, tenantId } = extractTenantAndEnv(args);

  const loaded = yield* loadPreparedAndApproval(
    ctx,
    preparedDigest,
    approvalId,
    tenantId
  );
  if (!loaded) {
    return 1;
  }

  const commitRes = yield* Effect.exit(
    ctx.atomicCommit.commit({
      approval: loaded.approval,
      environmentId,
      idempotencyKey,
      prepared: loaded.prepared,
      tenantId,
    })
  );

  if (Exit.isFailure(commitRes)) {
    printCliError(
      `Error: Commit failed: ${extractErrorMessage(commitRes.cause)}`
    );
    return 1;
  }

  outputCommitReceipt(commitRes.value, isJson);
  return 0;
});

function printReceiptStatus(receipt: {
  readonly committedAt: number;
  readonly operationId: string;
  readonly outboxItems: readonly unknown[];
  readonly preparedDigest: string;
  readonly receiptDigest: string;
  readonly status: string;
  readonly updatedObjects: readonly unknown[];
}): void {
  printCli("=== ACTION OPERATION STATUS ===");
  printCli(`Operation ID: ${receipt.operationId}`);
  printCli(`Status: ${receipt.status}`);
  printCli(`Prepared Digest: ${receipt.preparedDigest}`);
  printCli(`Receipt Digest: ${receipt.receiptDigest}`);
  printCli(`Updated Objects: ${receipt.updatedObjects.length}`);
  printCli(`Outbox Items: ${receipt.outboxItems.length}`);
  printCli(`Committed At: ${new Date(receipt.committedAt).toISOString()}`);
}

function printOutboxStatus(outbox: {
  readonly attemptCount: number;
  readonly command: string;
  readonly id: string;
  readonly operationId: string;
  readonly status: string;
}): void {
  printCli("=== OUTBOX ITEM STATUS ===");
  printCli(`Outbox ID: ${outbox.id}`);
  printCli(`Status: ${outbox.status}`);
  printCli(`Operation ID: ${outbox.operationId}`);
  printCli(`Attempt Count: ${outbox.attemptCount}`);
  printCli(`Command: ${outbox.command}`);
}

function outputReceiptStatus(receipt: OperationReceipt, isJson: boolean): void {
  if (isJson) {
    printCli(JSON.stringify(receipt, null, 2));
  } else {
    printReceiptStatus(receipt);
  }
}

function outputOutboxStatus(outbox: OutboxItem, isJson: boolean): void {
  if (isJson) {
    printCli(JSON.stringify(outbox, null, 2));
  } else {
    printOutboxStatus(outbox);
  }
}

const tryPrintReceiptStatus = Effect.fn("tryPrintReceiptStatus")(function* (
  ctx: RuntimeContext,
  operationId: string,
  tenantId: string,
  isJson: boolean
) {
  const receiptRes = yield* Effect.exit(
    ctx.atomicCommit.getReceipt(operationId, tenantId)
  );
  if (Exit.isSuccess(receiptRes) && receiptRes.value) {
    outputReceiptStatus(receiptRes.value, isJson);
    return true;
  }
  return false;
});

const tryPrintOutboxStatus = Effect.fn("tryPrintOutboxStatus")(function* (
  ctx: RuntimeContext,
  operationId: string,
  isJson: boolean
) {
  const outboxRes = yield* Effect.exit(
    ctx.atomicCommit.getOutboxItem(operationId)
  );
  if (Exit.isSuccess(outboxRes) && outboxRes.value) {
    outputOutboxStatus(outboxRes.value, isJson);
    return true;
  }
  return false;
});

const handleActionStatus = Effect.fn("handleActionStatus")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const operationId = args[1];
  if (!operationId) {
    printCliError("Error: Missing operation ID for status.");
    printCliError("  Usage: operon action status <operationId> [--json]");
    return 1;
  }

  const tenantId = getFlagValue(args, "--tenant") ?? "default";
  const foundReceipt = yield* tryPrintReceiptStatus(
    ctx,
    operationId,
    tenantId,
    isJson
  );
  if (foundReceipt) {
    return 0;
  }

  const foundOutbox = yield* tryPrintOutboxStatus(ctx, operationId, isJson);
  if (foundOutbox) {
    return 0;
  }

  printCliError(
    `Error: Operation or outbox item not found for ID '${operationId}'.`
  );
  return 1;
});

interface DryRunPreview {
  readonly actionId: string;
  readonly agentTier: 1 | 2 | 3 | 4;
  readonly dryRun: true;
  readonly mode: "proposal" | "automated";
  readonly parametersValid: boolean;
  readonly riskTier: string;
  readonly subject: string;
}

function determineExecutionMode(
  agentTier: 1 | 2 | 3 | 4,
  defaultMode: string
): "proposal" | "automated" {
  if (agentTier === 2 || defaultMode === "proposal") {
    return "proposal";
  }
  return "automated";
}

function outputDryRun(preview: DryRunPreview, isJson: boolean): void {
  if (isJson) {
    printCli(JSON.stringify(preview, null, 2));
    return;
  }
  printCli("=== DRY RUN ACTION EXECUTION PREVIEW ===");
  printCli(`Action: ${preview.actionId} (Risk: ${preview.riskTier})`);
  printCli(`Agent Tier: ${preview.agentTier}`);
  printCli(`Parameters Valid: ${preview.parametersValid ? "YES" : "NO"}`);
  const routeText =
    preview.mode === "proposal"
      ? "PROPOSAL_CREATED (Action Inbox)"
      : "EXECUTED (Governed Write Pipeline)";
  printCli(`Pipeline Route: ${routeText}`);
}

interface HandleActionDryRunOptions {
  readonly action: ActionType;
  readonly rawParameters: ActionParameters;
  readonly agentTier: 1 | 2 | 3 | 4;
  readonly subjectId: string;
  readonly isJson: boolean;
}

function handleActionDryRun(options: HandleActionDryRunOptions) {
  const { action, rawParameters, agentTier, subjectId, isJson } = options;
  return Effect.sync(() => {
    const parametersValid = Schema.is(action.parametersSchema)(rawParameters);

    const mode = determineExecutionMode(agentTier, action.defaultExecutionMode);
    const preview: DryRunPreview = {
      actionId: action.id,
      agentTier,
      dryRun: true,
      mode,
      parametersValid,
      riskTier: action.riskTier,
      subject: subjectId,
    };

    outputDryRun(preview, isJson);
    return preview.parametersValid ? 0 : 1;
  });
}

function handleProposedSubmission(
  ctx: RuntimeContext,
  submission: Parameters<typeof ctx.inbox.addProposal>[0],
  result: Extract<ActionExecutionResult, { status: "proposed" }>,
  isJson: boolean
): void {
  ctx.inbox.addProposal(submission, result.decisionRecord);
  if (isJson) {
    printCli(
      JSON.stringify(
        {
          decisionRecordId: result.decisionRecord.id,
          proposalId: result.proposalId,
          recordHash: result.decisionRecord.recordHash,
          status: "PROPOSAL_CREATED",
        },
        null,
        2
      )
    );
  } else {
    printCli("=== ACTION INTERCEPTED BY GOVERNANCE LADDER ===");
    printCli("Status: PROPOSAL_CREATED (Routed to Action Inbox)");
    printCli(`Proposal ID: ${result.proposalId}`);
    printCli(`Decision Hash: ${result.decisionRecord.recordHash}`);
    printCli(
      `Next Step: Review with 'operon inbox approve ${result.proposalId} --reviewer <id> --role <role>'`
    );
  }
}

function handleExecutedSubmission(
  result: Extract<ActionExecutionResult, { status: "executed" }>,
  isJson: boolean
): void {
  if (isJson) {
    printCli(
      JSON.stringify(
        {
          decisionRecordId: result.decisionRecord.id,
          recordHash: result.decisionRecord.recordHash,
          status: "EXECUTED",
          updatedObjectsCount: result.updatedObjects.length,
        },
        null,
        2
      )
    );
  } else {
    printCli("=== GOVERNED ACTION EXECUTED SUCCESSFULLY ===");
    printCli("Status: EXECUTED");
    printCli(`Decision Hash: ${result.decisionRecord.recordHash}`);
    printCli(`Committed Updates: ${result.updatedObjects.length} object(s)`);
  }
}

function getTargetAction(
  ctx: RuntimeContext,
  actionId?: string
): ActionType | undefined {
  if (!actionId) {
    return undefined;
  }
  return ctx.actionTypes.find((a) => a.id === actionId);
}

function printMissingActionError(actionId?: string): void {
  const label = actionId ? `'${actionId}'` : "none provided";
  printCliError(`Error: Missing or invalid action ID for submit: ${label}`);
  printCliError(
    "  Usage: operon action submit <actionId> [--params '<json>' | --stdin] [--agent-tier <1-4>] [--dry-run] [--json]"
  );
}

function extractSubmitSubject(args: readonly string[]) {
  const subject = extractSubjectFromArgs(args, 4);
  // SAFETY: extractSubjectFromArgs with default 4 ensures agentTier is 1 | 2 | 3 | 4
  const agentTier = (subject.agentTier ?? 4) as 1 | 2 | 3 | 4;
  return { agentTier, subject };
}

function createSubmission(
  action: ActionType,
  rawParameters: ActionParameters,
  subject: ReturnType<typeof extractSubjectFromArgs>
) {
  return {
    actionType: action,
    rawParameters,
    security: {
      correlationId: `cli_${Date.now()}`,
      subject,
      timestamp: Date.now(),
    },
  };
}

interface HandleActionSubmitOptions {
  readonly ctx: RuntimeContext;
  readonly args: readonly string[];
  readonly isJson: boolean;
  readonly isDryRun: boolean;
  readonly useStdin: boolean;
}

function handleActionSubmit(options: HandleActionSubmitOptions) {
  const { ctx, args, isJson, isDryRun, useStdin } = options;
  return Effect.gen(function* () {
    const action = getTargetAction(ctx, args[1]);
    if (!action) {
      printMissingActionError(args[1]);
      return 1;
    }

    const paramsExit = yield* readRawParameters(useStdin, args).pipe(
      Effect.exit
    );
    if (Exit.isFailure(paramsExit)) {
      printCliError(paramsExit.cause);
      return 1;
    }

    const { agentTier, subject } = extractSubmitSubject(args);
    if (isDryRun) {
      return yield* handleActionDryRun({
        action,
        agentTier,
        isJson,
        rawParameters: paramsExit.value,
        subjectId: subject.id,
      });
    }

    const submission = createSubmission(action, paramsExit.value, subject);
    const pipelineRes = yield* executeWritePipeline(
      submission,
      ctx.objectStore,
      ctx.auditStore
    ).pipe(Effect.exit);

    if (Exit.isFailure(pipelineRes)) {
      printCliError(
        `Error: Action execution failed: ${extractErrorMessage(pipelineRes.cause)}`
      );
      return 1;
    }
    const result = pipelineRes.value;

    if (result.status === "proposed") {
      handleProposedSubmission(ctx, submission, result, isJson);
      return 0;
    }

    handleExecutedSubmission(result, isJson);
    return 0;
  });
}

export interface ActionCmdOptions {
  readonly ctx: RuntimeContext;
  readonly args: readonly string[];
  readonly isJson: boolean;
  readonly isDryRun: boolean;
  readonly useStdin: boolean;
}

type ActionCmdHandler = (
  options: ActionCmdOptions
) => Effect.Effect<number, unknown, never>;

const ACTION_HANDLERS = {
  approve: (opts) => handleActionApprove(opts.ctx, opts.args, opts.isJson),
  commit: (opts) => handleActionCommit(opts.ctx, opts.args, opts.isJson),
  list: (opts) => handleActionList(opts.ctx, opts.isJson),
  prepare: (opts) =>
    handleActionPrepare(opts.ctx, opts.args, opts.isJson, opts.useStdin),
  status: (opts) => handleActionStatus(opts.ctx, opts.args, opts.isJson),
  submit: (opts) => handleActionSubmit(opts),
} as const satisfies Record<string, ActionCmdHandler>;

function getActionHandler(sub?: string): ActionCmdHandler | undefined {
  if (sub && Object.hasOwn(ACTION_HANDLERS, sub)) {
    // SAFETY: sub existence verified by Object.hasOwn
    return ACTION_HANDLERS[sub as keyof typeof ACTION_HANDLERS];
  }
  return undefined;
}

export function runAction(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const isDryRun = args.includes("--dry-run");
  const useStdin = args.includes("--stdin");
  const dbPath = getFlagValue(args, "--db");

  const handler = getActionHandler(sub);

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => {
      if (handler) {
        return handler({ args, ctx, isDryRun, isJson, useStdin });
      }
      printCliError(`Error: Unknown action subcommand '${sub ?? ""}'`);
      printCliError(
        "  Available subcommands: list, prepare, approve, commit, status, submit"
      );
      printCliError("  Run 'operon action --help' for details.");
      return Effect.succeed(1);
    },
    (ctx) => Effect.sync(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "action", subcommand: args[0] ?? "none" })
  );
}
