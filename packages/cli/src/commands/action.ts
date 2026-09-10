import { executeWritePipeline } from "@operon/runtime";
import { Effect, Schema } from "effect";

import { createRuntimeContext, createSubject } from "../state.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    );
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function extractErrorMessage(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as any).message === "string"
  ) {
    return (err as any).message;
  }
  return String(err);
}

export function runAction(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const isDryRun = args.includes("--dry-run");
  const useStdin = args.includes("--stdin");

  const dbIndex = args.indexOf("--db");
  const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) =>
      Effect.gen(function* () {
        if (sub === "list") {
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
            console.log(JSON.stringify(actions, null, 2));
          } else {
            console.log("=== OPERON REGISTERED ACTION TYPES ===");
            for (const a of actions) {
              console.log(
                `• ${a.id} (${a.name}) | Risk: ${a.riskTier} | Min Tier: ${a.minimumAgentTier} | Mode: ${a.defaultExecutionMode}`
              );
              console.log(`  ${a.description}`);
            }
          }
          return 0;
        }

        if (sub === "prepare") {
          const actionId = args[1];
          if (!actionId || actionId.startsWith("-")) {
            console.error("Error: Missing action ID for prepare.");
            console.error(
              "  Usage: operon action prepare <actionId> [--params '<json>' | --stdin] [--grant-id <id>] [--agent-tier <1-4>] [--json]"
            );
            return 1;
          }

          const action = ctx.actionTypes.find((a) => a.id === actionId);
          if (!action) {
            console.error(`Error: ActionType '${actionId}' not found.`);
            return 1;
          }

          let rawParameters: unknown = {};
          if (useStdin) {
            const stdinBuffer = yield* Effect.promise(() => readStdin());
            const parseResult = yield* Effect.try({
              try: () => JSON.parse(String(stdinBuffer).trim() || "{}"),
              catch: (error) => error,
            }).pipe(Effect.exit);
            if (parseResult._tag === "Failure") {
              console.error(
                "Error: Failed to parse JSON from stdin.",
                parseResult.cause
              );
              return 1;
            }
            rawParameters = parseResult.value;
          } else {
            const paramsIndex = args.indexOf("--params");
            if (paramsIndex !== -1 && args[paramsIndex + 1]) {
              const parseResult = yield* Effect.try({
                try: () => JSON.parse(args[paramsIndex + 1]),
                catch: (error) => error,
              }).pipe(Effect.exit);
              if (parseResult._tag === "Failure") {
                console.error(
                  "Error: --params must be valid JSON.",
                  parseResult.cause
                );
                return 1;
              }
              rawParameters = parseResult.value;
            }
          }

          const grantIndex = args.indexOf("--grant-id");
          const grantId = grantIndex === -1 ? undefined : args[grantIndex + 1];

          const tierIndex = args.indexOf("--agent-tier");
          const agentTier =
            tierIndex === -1
              ? (2 as const)
              : (Math.trunc(Number(args[tierIndex + 1])) as 1 | 2 | 3 | 4);

          const subjectIdIndex = args.indexOf("--subject-id");
          const subjectId =
            subjectIdIndex === -1 ? "cli_agent" : args[subjectIdIndex + 1];

          const subjectTypeIndex = args.indexOf("--subject-type");
          const subjectType = (
            subjectTypeIndex === -1 ? "agent" : args[subjectTypeIndex + 1]
          ) as "user" | "agent";

          const roleIndex = args.indexOf("--role");
          const roles =
            roleIndex === -1
              ? ["operator", "clinician"]
              : [args[roleIndex + 1]];

          const tenantIndex = args.indexOf("--tenant");
          const tenantId =
            tenantIndex === -1 ? "default" : args[tenantIndex + 1];

          const envIndex = args.indexOf("--env");
          const environmentId =
            envIndex === -1 ? "default" : args[envIndex + 1];

          const ttlIndex = args.indexOf("--ttl");
          const ttlMs =
            ttlIndex === -1 ? undefined : Number(args[ttlIndex + 1]);

          const proposer = createSubject(
            subjectId,
            subjectType,
            roles,
            agentTier
          );

          const preparedRes = yield* Effect.exit(
            ctx.governedActions.prepareAction({
              actionId,
              environmentId,
              grantId,
              proposer,
              rawParameters,
              tenantId,
              ttlMs,
            })
          );

          if (preparedRes._tag === "Failure") {
            const err = (preparedRes.cause as any)?.error ?? preparedRes.cause;
            console.error(
              `Error: Action preparation failed: ${extractErrorMessage(err)}`
            );
            return 1;
          }

          const prepared = preparedRes.value;

          if (isJson) {
            console.log(
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
                  predicateDependenciesCount:
                    prepared.predicateDependencies.length,
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
            console.log("=== ACTION PREPARED (ZERO BUSINESS SIDE EFFECTS) ===");
            console.log(`Status: PREPARED`);
            console.log(`Prepared ID: ${prepared.id}`);
            console.log(`Canonical Digest: ${prepared.canonicalDigest}`);
            console.log(`Action ID: ${prepared.actionId}`);
            console.log(`Verdict: ${prepared.verdict}`);
            console.log(`Object Revisions: ${prepared.objectRevisions.length}`);
            console.log(
              `Predicate Dependencies: ${prepared.predicateDependencies.length}`
            );
            console.log(
              `Expires At: ${new Date(prepared.expiresAt).toISOString()}`
            );
          }
          return 0;
        }

        if (sub === "approve") {
          const preparedDigest = args[1];
          const viewedIndex = args.indexOf("--viewed-digest");
          const viewedDigest =
            viewedIndex === -1 ? undefined : args[viewedIndex + 1];

          if (!preparedDigest || !viewedDigest) {
            console.error(
              "Error: Missing preparedDigest or --viewed-digest for approve."
            );
            console.error(
              "  Usage: operon action approve <preparedDigest> --viewed-digest <digest> [--decision approve|reject] [--reason <text>] [--json]"
            );
            return 1;
          }

          const decisionIndex = args.indexOf("--decision");
          const rawDecision =
            decisionIndex === -1 ? "approve" : args[decisionIndex + 1];
          const decision =
            rawDecision === "reject" || rawDecision === "rejected"
              ? "rejected"
              : "approved";

          const reasonIndex = args.indexOf("--reason");
          const reason = reasonIndex === -1 ? undefined : args[reasonIndex + 1];

          const reviewerIndex = args.includes("--reviewer-id")
            ? args.indexOf("--reviewer-id")
            : args.indexOf("--reviewer");
          const reviewerId =
            reviewerIndex === -1 ? "operator_human" : args[reviewerIndex + 1];

          const roleIndex = args.indexOf("--role");
          const role = roleIndex === -1 ? "operator" : args[roleIndex + 1];

          const assuranceIndex = args.indexOf("--assurance");
          const assurance = (
            assuranceIndex === -1 ||
            args[assuranceIndex + 1] !== "delegated_service"
              ? "human_verified"
              : "delegated_service"
          ) as "human_verified" | "delegated_service";

          const tenantIndex = args.indexOf("--tenant");
          const tenantId =
            tenantIndex === -1 ? "default" : args[tenantIndex + 1];

          const envIndex = args.indexOf("--env");
          const environmentId =
            envIndex === -1 ? "default" : args[envIndex + 1];

          const reviewer = createSubject(reviewerId, "user", [role]);

          const approveRes = yield* Effect.exit(
            ctx.governedActions.approvePreparedAction({
              decision,
              preparedDigest,
              reason,
              reviewerContext: {
                assurance,
                environmentId,
                reviewer,
                tenantId,
              },
              viewedDigest,
            })
          );

          if (approveRes._tag === "Failure") {
            const err = (approveRes.cause as any)?.error ?? approveRes.cause;
            console.error(
              `Error: Approval failed: ${extractErrorMessage(err)}`
            );
            return 1;
          }

          const approval = approveRes.value;

          if (isJson) {
            console.log(
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
            console.log("=== ACTION PROPOSAL APPROVED ===");
            console.log(`Approval ID: ${approval.id}`);
            console.log(`Decision: ${approval.decision.toUpperCase()}`);
            console.log(`Prepared Digest: ${approval.preparedDigest}`);
            console.log(`Record Hash: ${approval.recordHash}`);
            console.log(`Reviewer: ${approval.reviewerContext.reviewer.id}`);
            console.log(
              `Approved At: ${new Date(approval.approvedAt).toISOString()}`
            );
          }
          return 0;
        }

        if (sub === "commit") {
          const preparedDigest = args[1];
          const keyIndex = args.indexOf("--idempotency-key");
          const idempotencyKey =
            keyIndex === -1 ? undefined : args[keyIndex + 1];

          if (!preparedDigest || !idempotencyKey) {
            console.error(
              "Error: Missing preparedDigest or --idempotency-key for commit."
            );
            console.error(
              "  Usage: operon action commit <preparedDigest> [--approval-id <id>] --idempotency-key <key> [--json]"
            );
            return 1;
          }

          const approvalIndex = args.indexOf("--approval-id");
          const approvalId =
            approvalIndex === -1 ? undefined : args[approvalIndex + 1];

          const tenantIndex = args.indexOf("--tenant");
          const tenantId =
            tenantIndex === -1 ? "default" : args[tenantIndex + 1];

          const envIndex = args.indexOf("--env");
          const environmentId =
            envIndex === -1 ? "default" : args[envIndex + 1];

          const preparedRes = yield* Effect.exit(
            ctx.governedActions.getPreparedAction(preparedDigest, tenantId)
          );
          if (preparedRes._tag === "Failure") {
            console.error(
              `Error: Prepared action not found for digest '${preparedDigest}'.`
            );
            return 1;
          }
          const prepared = preparedRes.value;

          let approval = undefined;
          if (approvalId) {
            const approvalRes = yield* Effect.exit(
              ctx.governedActions.getApprovalRecord(approvalId, tenantId)
            );
            if (approvalRes._tag === "Failure") {
              console.error(
                `Error: Approval record not found for id '${approvalId}'.`
              );
              return 1;
            }
            approval = approvalRes.value;
          }

          const commitRes = yield* Effect.exit(
            ctx.atomicCommit.commit({
              approval,
              environmentId,
              idempotencyKey,
              prepared,
              tenantId,
            })
          );

          if (commitRes._tag === "Failure") {
            const err = (commitRes.cause as any)?.error ?? commitRes.cause;
            console.error(`Error: Commit failed: ${extractErrorMessage(err)}`);
            return 1;
          }

          const receipt = commitRes.value;

          if (isJson) {
            console.log(
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
            console.log("=== LOCAL ATOMIC COMMIT SUCCESSFUL ===");
            console.log(`Operation ID: ${receipt.operationId}`);
            console.log(`Status: ${receipt.status}`);
            console.log(`Receipt Digest: ${receipt.receiptDigest}`);
            console.log(`Updated Objects: ${receipt.updatedObjects.length}`);
            console.log(`Outbox Items: ${receipt.outboxItems.length}`);
            console.log(
              `Committed At: ${new Date(receipt.committedAt).toISOString()}`
            );
          }
          return 0;
        }

        if (sub === "status") {
          const operationId = args[1];
          if (!operationId) {
            console.error("Error: Missing operation ID for status.");
            console.error(
              "  Usage: operon action status <operationId> [--json]"
            );
            return 1;
          }

          const tenantIndex = args.indexOf("--tenant");
          const tenantId =
            tenantIndex === -1 ? "default" : args[tenantIndex + 1];

          const receiptRes = yield* Effect.exit(
            ctx.atomicCommit.getReceipt(operationId, tenantId)
          );

          if (receiptRes._tag === "Success" && receiptRes.value) {
            const receipt = receiptRes.value;
            if (isJson) {
              console.log(JSON.stringify(receipt, null, 2));
            } else {
              console.log("=== ACTION OPERATION STATUS ===");
              console.log(`Operation ID: ${receipt.operationId}`);
              console.log(`Status: ${receipt.status}`);
              console.log(`Prepared Digest: ${receipt.preparedDigest}`);
              console.log(`Receipt Digest: ${receipt.receiptDigest}`);
              console.log(`Updated Objects: ${receipt.updatedObjects.length}`);
              console.log(`Outbox Items: ${receipt.outboxItems.length}`);
              console.log(
                `Committed At: ${new Date(receipt.committedAt).toISOString()}`
              );
            }
            return 0;
          }

          const outboxRes = yield* Effect.exit(
            ctx.atomicCommit.getOutboxItem(operationId)
          );
          if (outboxRes._tag === "Success" && outboxRes.value) {
            const outbox = outboxRes.value;
            if (isJson) {
              console.log(JSON.stringify(outbox, null, 2));
            } else {
              console.log("=== OUTBOX ITEM STATUS ===");
              console.log(`Outbox ID: ${outbox.id}`);
              console.log(`Status: ${outbox.status}`);
              console.log(`Operation ID: ${outbox.operationId}`);
              console.log(`Attempt Count: ${outbox.attemptCount}`);
              console.log(`Command: ${outbox.command}`);
            }
            return 0;
          }

          console.error(
            `Error: Operation or outbox item not found for ID '${operationId}'.`
          );
          return 1;
        }

        if (sub === "submit") {
          const actionId = args[1];
          if (!actionId) {
            console.error("Error: Missing action ID for submit.");
            console.error(
              "  Usage: operon action submit <actionId> [--params '<json>' | --stdin] [--agent-tier <1-4>] [--dry-run] [--json]"
            );
            console.error(
              '  Example: operon action submit update_vitals --params \'{"patientId":"P001","heartRate":72}\' --agent-tier 4'
            );
            return 1;
          }

          const action = ctx.actionTypes.find((a) => a.id === actionId);
          if (!action) {
            console.error(`Error: ActionType '${actionId}' not found.`);
            console.error(
              `  Available actions: ${ctx.actionTypes.map((a) => a.id).join(", ")}`
            );
            return 1;
          }

          let rawParameters: unknown = {};
          if (useStdin) {
            const stdinBuffer = yield* Effect.promise(() => readStdin());
            const parseResult = yield* Effect.try({
              try: () => JSON.parse(String(stdinBuffer).trim() || "{}"),
              catch: (error) => error,
            }).pipe(Effect.exit);
            if (parseResult._tag === "Failure") {
              console.error(
                "Error: Failed to parse JSON from stdin.",
                parseResult.cause
              );
              return 1;
            }
            rawParameters = parseResult.value;
          } else {
            const paramsIndex = args.indexOf("--params");
            if (paramsIndex !== -1 && args[paramsIndex + 1]) {
              const parseResult = yield* Effect.try({
                try: () => JSON.parse(args[paramsIndex + 1]),
                catch: (error) => error,
              }).pipe(Effect.exit);
              if (parseResult._tag === "Failure") {
                console.error(
                  "Error: --params must be valid JSON.",
                  parseResult.cause
                );
                return 1;
              }
              rawParameters = parseResult.value;
            }
          }

          // Subject extraction
          const tierIndex = args.indexOf("--agent-tier");
          const agentTier =
            tierIndex === -1
              ? (4 as const)
              : (Math.trunc(Number(args[tierIndex + 1])) as 1 | 2 | 3 | 4);

          const subjectIdIndex = args.indexOf("--subject-id");
          const subjectId =
            subjectIdIndex === -1 ? "cli_agent" : args[subjectIdIndex + 1];

          const typeIndex = args.indexOf("--subject-type");
          const subjectType = (
            typeIndex === -1 ? "agent" : args[typeIndex + 1]
          ) as "user" | "agent";

          const roleIndex = args.indexOf("--role");
          const roles =
            roleIndex === -1
              ? ["operator", "clinician"]
              : [args[roleIndex + 1]];

          const subject = createSubject(
            subjectId,
            subjectType,
            roles,
            agentTier
          );

          // Dry run preview
          if (isDryRun) {
            const decoded = yield* Schema.decodeUnknownEffect(
              action.parametersSchema as Schema.Decoder<any>
            )(rawParameters).pipe(Effect.result);
            const parametersValid = decoded._tag === "Success";

            const preview = {
              actionId: action.id,
              agentTier,
              dryRun: true,
              mode:
                agentTier === 2 || action.defaultExecutionMode === "proposal"
                  ? "proposal"
                  : "automated",
              parametersValid,
              riskTier: action.riskTier,
              subject: subject.id,
            };

            if (isJson) {
              console.log(JSON.stringify(preview, null, 2));
            } else {
              console.log("=== DRY RUN ACTION EXECUTION PREVIEW ===");
              console.log(
                `Action: ${preview.actionId} (Risk: ${preview.riskTier})`
              );
              console.log(`Agent Tier: ${preview.agentTier}`);
              console.log(
                `Parameters Valid: ${preview.parametersValid ? "YES" : "NO"}`
              );
              console.log(
                `Pipeline Route: ${preview.mode === "proposal" ? "PROPOSAL_CREATED (Action Inbox)" : "EXECUTED (Governed Write Pipeline)"}`
              );
            }
            return preview.parametersValid ? 0 : 1;
          }

          const submission = {
            actionType: action,
            rawParameters,
            security: {
              correlationId: `cli_${Date.now()}`,
              subject,
              timestamp: Date.now(),
            },
          };

          const result = yield* executeWritePipeline(
            submission,
            ctx.objectStore,
            ctx.auditStore
          );

          if (result.status === "proposed") {
            ctx.inbox.addProposal(submission, result.decisionRecord);

            if (isJson) {
              console.log(
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
              console.log("=== ACTION INTERCEPTED BY GOVERNANCE LADDER ===");
              console.log(`Status: PROPOSAL_CREATED (Routed to Action Inbox)`);
              console.log(`Proposal ID: ${result.proposalId}`);
              console.log(`Decision Hash: ${result.decisionRecord.recordHash}`);
              console.log(
                `Next Step: Review with 'operon inbox approve ${result.proposalId} --reviewer <id> --role <role>'`
              );
            }
            return 0;
          }

          if (isJson) {
            console.log(
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
            console.log("=== GOVERNED ACTION EXECUTED SUCCESSFULLY ===");
            console.log(`Status: EXECUTED`);
            console.log(`Decision Hash: ${result.decisionRecord.recordHash}`);
            console.log(
              `Committed Updates: ${result.updatedObjects.length} object(s)`
            );
          }
          return 0;
        }

        console.error(`Error: Unknown action subcommand '${sub ?? ""}'`);
        console.error(
          "  Available subcommands: list, prepare, approve, commit, status, submit"
        );
        console.error("  Run 'operon action --help' for details.");
        return 1;
      }),
    (ctx) => Effect.sync(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "action", subcommand: args[0] ?? "none" })
  );
}
