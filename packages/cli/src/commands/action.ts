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

export function runAction(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const isDryRun = args.includes("--dry-run");
    const useStdin = args.includes("--stdin");

    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));

    try {
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
          try {
            const stdinBuffer = yield* Effect.promise(() => readStdin());
            rawParameters = JSON.parse(String(stdinBuffer).trim() || "{}");
          } catch (error: unknown) {
            console.error("Error: Failed to parse JSON from stdin.", error);
            return 1;
          }
        } else {
          const paramsIndex = args.indexOf("--params");
          if (paramsIndex !== -1 && args[paramsIndex + 1]) {
            try {
              rawParameters = JSON.parse(args[paramsIndex + 1]);
            } catch (error: unknown) {
              console.error("Error: --params must be valid JSON.", error);
              return 1;
            }
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
          roleIndex === -1 ? ["operator", "clinician"] : [args[roleIndex + 1]];

        const subject = createSubject(subjectId, subjectType, roles, agentTier);

        // Dry run preview
        if (isDryRun) {
          // Validate parameters schema
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
      console.error("  Available subcommands: list, submit");
      console.error("  Run 'operon action --help' for details.");
      return 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "action", subcommand: args[0] ?? "none" })
  );
}
