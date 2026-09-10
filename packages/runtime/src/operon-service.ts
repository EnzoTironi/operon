import {
  F1EvaluatorService,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import { generateDisposableAppView } from "@operon/generated-ui";
import type {
  ApprovalRecord,
  ConsentScope,
  ExactQueryRequest,
  F1TestCase,
  F2Claim,
  F2Receipt,
  IdentityResolutionProposal,
  IntentGrant,
  PreparedAction,
  PublicF1Receipt,
  Subject,
  TaskMandate,
  TraceableCorrection,
} from "@operon/schema";
import { Effect } from "effect";

import type { GovernedActionService } from "./actions/governed-action-service.js";
import type { ObjectStore } from "./object-store.js";
import type { AuthorityService } from "./policy/authority.js";
import type { ReconciliationService } from "./reconciliation.js";
import type { AtomicCommitService } from "./transactions/atomic-commit-service.js";

export interface OperonAgentContext {
  readonly tenantId: string;
  readonly environmentId: string;
  readonly actor: Subject;
  readonly correlationId?: string;
  readonly grantId?: string;
}

export type ResultStatus =
  | "SUCCESS"
  | "DENIED"
  | "REVIEW_REQUIRED"
  | "EVIDENCE_INSUFFICIENT"
  | "ERROR";

export interface ResultEnvelope<T = unknown> {
  readonly schemaVersion: string;
  readonly operation: string;
  readonly status: ResultStatus;
  readonly result?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly observations?: readonly string[];
  readonly evidenceReferences?: readonly string[];
  readonly executedAt: number;
}

export interface OperonService {
  readonly invoke: (
    ctx: OperonAgentContext,
    operation: string,
    input: unknown
  ) => Promise<ResultEnvelope>;
  readonly invokeEffect: (
    ctx: OperonAgentContext,
    operation: string,
    input: unknown
  ) => Effect.Effect<ResultEnvelope>;
}

function extractError(cause: unknown): { code: string; message: string } {
  const err = (cause as any)?.error ?? cause;
  const code = (err as any)?._tag ?? "OperonServiceError";
  const message = (err as any)?.message ?? String(err);
  return { code, message };
}

/**
 * OperonServiceImpl (S18 / V0-CH-09):
 * Unified kernel entrypoint across CLI, MCP, and SDK.
 * Exposes wire protocol with ResultEnvelope, status codes, and exact error telemetry.
 */
export class OperonServiceImpl implements OperonService {
  constructor(
    private readonly governedActionService: GovernedActionService,
    private readonly atomicCommitService: AtomicCommitService,
    private readonly authorityService: AuthorityService,
    private readonly reconciliationService: ReconciliationService,
    private readonly objectStore: ObjectStore,
    private readonly f1Evaluator: F1EvaluatorService = new F1EvaluatorService(),
    private readonly f2Mirror: F2MirrorService = new F2MirrorService(),
    private readonly publicationBoundary: PublicationBoundaryService = new PublicationBoundaryService()
  ) {}

  invokeEffect(
    ctx: OperonAgentContext,
    operation: string,
    input: unknown
  ): Effect.Effect<ResultEnvelope> {
    const {
      atomicCommitService,
      authorityService,
      f1Evaluator,
      f2Mirror,
      governedActionService,
      objectStore,
      publicationBoundary,
      reconciliationService,
    } = this;

    const wrapSuccess = <T>(
      res: T,
      status: ResultStatus = "SUCCESS",
      observations?: readonly string[]
    ): ResultEnvelope<T> => ({
      executedAt: Date.now(),
      observations,
      operation,
      result: res,
      schemaVersion: "operon.v0",
      status,
    });

    const wrapError = (
      code: string,
      message: string,
      status: ResultStatus = "ERROR",
      details?: unknown
    ): ResultEnvelope => ({
      error: { code, details, message },
      executedAt: Date.now(),
      operation,
      schemaVersion: "operon.v0",
      status,
    });

    return Effect.gen(function* () {
      switch (operation) {
        case "action.prepare": {
          const pInput = input as {
            actionId: string;
            rawParameters: unknown;
            ttlMs?: number;
          };
          const prepExit = yield* Effect.exit(
            governedActionService.prepareAction({
              actionId: pInput.actionId,
              environmentId: ctx.environmentId,
              grantId: ctx.grantId,
              proposer: ctx.actor,
              rawParameters: pInput.rawParameters,
              tenantId: ctx.tenantId,
              ttlMs: pInput.ttlMs,
            })
          );

          if (prepExit._tag === "Failure") {
            const errInfo = extractError(prepExit.cause);
            return wrapError(
              errInfo.code,
              errInfo.message,
              errInfo.code === "TenantMismatchError"
                ? "DENIED"
                : errInfo.code === "FreshnessOrPolicyDeniedError"
                  ? "EVIDENCE_INSUFFICIENT"
                  : "ERROR"
            );
          }

          const pAction = prepExit.value as PreparedAction;
          const status: ResultStatus =
            pAction.verdict === "allow"
              ? "SUCCESS"
              : pAction.verdict === "review"
                ? "REVIEW_REQUIRED"
                : pAction.verdict === "deny"
                  ? "DENIED"
                  : "EVIDENCE_INSUFFICIENT";

          return wrapSuccess(
            pAction,
            status,
            pAction.reviewReasons ?? undefined
          );
        }

        case "action.approve": {
          const aInput = input as {
            preparedDigest: string;
            viewedDigest: string;
            decision?: "approved" | "rejected";
            reason?: string;
            assurance?: "human_verified" | "delegated_service";
          };
          const appExit = yield* Effect.exit(
            governedActionService.approvePreparedAction({
              decision: aInput.decision ?? "approved",
              preparedDigest: aInput.preparedDigest,
              reason: aInput.reason,
              reviewerContext: {
                assurance: aInput.assurance ?? "human_verified",
                environmentId: ctx.environmentId,
                reviewer: ctx.actor,
                tenantId: ctx.tenantId,
              },
              viewedDigest: aInput.viewedDigest,
            })
          );

          if (appExit._tag === "Failure") {
            const errInfo = extractError(appExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }

          return wrapSuccess(appExit.value);
        }

        case "action.commit": {
          const cInput = input as {
            preparedDigest: string;
            approvalId?: string;
            idempotencyKey: string;
          };

          const prepExit = yield* Effect.exit(
            governedActionService.getPreparedAction(
              cInput.preparedDigest,
              ctx.tenantId
            )
          );
          if (prepExit._tag === "Failure") {
            const errInfo = extractError(prepExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }
          const prepared = prepExit.value as PreparedAction;

          let approval: ApprovalRecord | undefined;
          if (cInput.approvalId) {
            const appExit = yield* Effect.exit(
              governedActionService.getApprovalRecord(
                cInput.approvalId,
                ctx.tenantId
              )
            );
            if (appExit._tag === "Failure") {
              const errInfo = extractError(appExit.cause);
              return wrapError(errInfo.code, errInfo.message, "DENIED");
            }
            approval = appExit.value as ApprovalRecord;
          }

          const commitExit = yield* Effect.exit(
            atomicCommitService.commit({
              approval,
              environmentId: ctx.environmentId,
              idempotencyKey: cInput.idempotencyKey,
              prepared,
              tenantId: ctx.tenantId,
            })
          );

          if (commitExit._tag === "Failure") {
            const errInfo = extractError(commitExit.cause);
            return wrapError(errInfo.code, errInfo.message, "ERROR");
          }

          return wrapSuccess(commitExit.value);
        }

        case "action.get": {
          const gInput = input as { preparedDigest: string };
          const pExit = yield* Effect.exit(
            governedActionService.getPreparedAction(
              gInput.preparedDigest,
              ctx.tenantId
            )
          );
          if (pExit._tag === "Failure") {
            const errInfo = extractError(pExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }
          return wrapSuccess(pExit.value);
        }

        case "action.list": {
          const list = yield* governedActionService.listPreparedActions(
            ctx.tenantId
          );
          return wrapSuccess(list);
        }

        case "action.status": {
          const sInput = input as { operationId: string };
          const opExit = yield* Effect.exit(
            atomicCommitService.getOperation(sInput.operationId, ctx.tenantId)
          );
          if (opExit._tag === "Failure") {
            const errInfo = extractError(opExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }
          const op = opExit.value;
          if (!op) {
            return wrapError(
              "OperationNotFoundError",
              `Operation '${sInput.operationId}' not found`,
              "DENIED"
            );
          }
          return wrapSuccess(op);
        }

        case "query.exact": {
          const qInput = input as ExactQueryRequest;
          const qExit = yield* Effect.exit(
            reconciliationService.query(qInput, objectStore)
          );
          if (qExit._tag === "Failure") {
            const errInfo = extractError(qExit.cause);
            return wrapError(errInfo.code, errInfo.message, "ERROR");
          }
          return wrapSuccess(qExit.value);
        }

        case "query.explain": {
          const eInput = input as ExactQueryRequest;
          const typeId = eInput.queryId;
          const id = (eInput.params as any)?.id ?? "sample";
          const plan = reconciliationService.explainQuery(
            typeId,
            id,
            eInput.worldView.validTime,
            eInput.worldView.pinnedAt,
            "sqlite"
          );
          return wrapSuccess(plan);
        }

        case "reconcile.propose": {
          const rInput = input as IdentityResolutionProposal;
          const propExit = yield* Effect.exit(
            reconciliationService.proposeIdentityResolution(rInput)
          );
          if (propExit._tag === "Failure") {
            const errInfo = extractError(propExit.cause);
            return wrapError(errInfo.code, errInfo.message, "ERROR");
          }
          return wrapSuccess(propExit.value);
        }

        case "reconcile.resolve": {
          const resInput = input as {
            proposalId: string;
            decisionRef?: string;
            forceOverride?: boolean;
            idempotencyKey?: string;
          };
          const resExit = yield* Effect.exit(
            reconciliationService.resolveIdentity(
              resInput.proposalId,
              resInput.decisionRef ?? `dec_${Date.now()}`,
              {
                environmentId: ctx.environmentId,
                forceOverride: resInput.forceOverride,
                idempotencyKey: resInput.idempotencyKey,
                tenantId: ctx.tenantId,
              }
            )
          );
          if (resExit._tag === "Failure") {
            const errInfo = extractError(resExit.cause);
            return wrapError(errInfo.code, errInfo.message, "ERROR");
          }
          return wrapSuccess(resExit.value);
        }

        case "reconcile.list": {
          const proposals = yield* reconciliationService.listProposals(
            ctx.tenantId
          );
          return wrapSuccess(proposals);
        }

        case "grant.register": {
          const g = yield* authorityService.registerGrant(input as IntentGrant);
          return wrapSuccess(g);
        }

        case "mandate.register": {
          const m = yield* authorityService.registerMandate(
            input as TaskMandate
          );
          return wrapSuccess(m);
        }

        case "grant.list": {
          const gInput = (input as { actorId?: string }) ?? {};
          const grants = yield* authorityService.listGrants(
            ctx.tenantId,
            gInput.actorId
          );
          return wrapSuccess(grants);
        }

        case "view.generate": {
          const vInput = input as any;
          const view = generateDisposableAppView({
            audience: vInput.audience,
            data: vInput.data ?? {},
            format: vInput.format,
            grant: vInput.grant,
            state: vInput.state ?? "CONFIRMED",
            title: vInput.title ?? "Operon View",
          });
          return wrapSuccess(view);
        }

        case "assurance.evaluateF1": {
          const fInput = input as {
            candidateId: string;
            candidateDigest: string;
            profile: "local" | "production" | "external-agent";
            catalogId: string;
            catalogDigest: string;
            testCases: readonly F1TestCase[];
            candidateAttemptedOracleOverride?: boolean;
            idempotencyKey?: string;
          };
          const evalExit = yield* Effect.exit(
            f1Evaluator.evaluate({
              ...fInput,
              environmentId: ctx.environmentId,
              tenantId: ctx.tenantId,
            })
          );
          if (evalExit._tag === "Failure") {
            const errInfo = extractError(evalExit.cause);
            return wrapError(
              errInfo.code,
              errInfo.message,
              errInfo.code === "NonDisclosureError" ? "DENIED" : "ERROR"
            );
          }
          const receipt = evalExit.value;
          return wrapSuccess(
            receipt,
            receipt.outcome === "PASS"
              ? "SUCCESS"
              : receipt.outcome === "FAIL"
                ? "DENIED"
                : "EVIDENCE_INSUFFICIENT"
          );
        }

        case "assurance.verifyF1Receipt": {
          const receipt = input as PublicF1Receipt;
          const vExit = yield* Effect.exit(f1Evaluator.verifyReceipt(receipt));
          if (vExit._tag === "Failure") {
            const errInfo = extractError(vExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }
          return wrapSuccess(vExit.value);
        }

        case "assurance.mirrorF2": {
          const mInput = input as {
            candidateDigest: string;
            profileDigest: string;
            rubricDigest: string;
            companyEvidenceRef: string;
            participantId: string;
            consentScope: ConsentScope;
            corrections: readonly TraceableCorrection[];
            claim: F2Claim;
            attemptedKernelBypass?: boolean;
            attemptedBypassPath?: string;
            idempotencyKey?: string;
          };
          const mExit = yield* Effect.exit(
            f2Mirror.evaluateMirror({
              ...mInput,
              actorId: ctx.actor.id,
              environmentId: ctx.environmentId,
              tenantId: ctx.tenantId,
            })
          );
          if (mExit._tag === "Failure") {
            const errInfo = extractError(mExit.cause);
            return wrapError(
              errInfo.code,
              errInfo.message,
              errInfo.code === "F2InternalBypassError" ||
                errInfo.code === "NonDisclosureError"
                ? "DENIED"
                : "ERROR"
            );
          }
          return wrapSuccess(mExit.value);
        }

        case "assurance.verifyF2Receipt": {
          const receipt = input as F2Receipt;
          const vExit = yield* Effect.exit(f2Mirror.verifyReceipt(receipt));
          if (vExit._tag === "Failure") {
            const errInfo = extractError(vExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }
          return wrapSuccess(vExit.value);
        }

        case "assurance.scanPublication": {
          const sInput =
            (input as {
              targetDirectory?: string;
              allowedPublicOnly?: boolean;
            }) ?? {};
          const targetDir = sInput.targetDirectory ?? process.cwd();
          const scanExit = yield* Effect.exit(
            publicationBoundary.scanDirectory(targetDir, {
              allowedPublicOnly: sInput.allowedPublicOnly ?? true,
            })
          );
          if (scanExit._tag === "Failure") {
            const errInfo = extractError(scanExit.cause);
            return wrapError(errInfo.code, errInfo.message, "DENIED");
          }
          const res = scanExit.value;
          return wrapSuccess(res, res.isClean ? "SUCCESS" : "DENIED");
        }

        default: {
          return wrapError(
            "UnsupportedOperationError",
            `Operation '${operation}' is not supported by OperonService`,
            "ERROR"
          );
        }
      }
    });
  }

  invoke(
    ctx: OperonAgentContext,
    operation: string,
    input: unknown
  ): Promise<ResultEnvelope> {
    return Effect.runPromise(this.invokeEffect(ctx, operation, input));
  }
}
