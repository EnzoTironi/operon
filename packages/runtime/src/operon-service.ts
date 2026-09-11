import {
  F1EvaluatorService,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import { generateDisposableAppView } from "@operon/generated-ui";
import type { ViewLifecycleState, ViewRecord } from "@operon/generated-ui";
import type {
  ApprovalRecord,
  ConsentScope,
  DiagnosticBundle,
  DiagnosticDetails,
  DiagnosticEntry,
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
import {
  computeDiagnosticBundleHash,
  generatePrefixedId,
} from "@operon/schema";
import { Clock, Effect, Exit, Match } from "effect";

import { DiagnosticNotFoundError } from "./actions-errors.js";
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
    readonly details?: DiagnosticDetails;
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
  readonly diagnose: (
    runId: string
  ) => Effect.Effect<DiagnosticBundle, DiagnosticNotFoundError, never>;
}

const SENSITIVE_KEY_PATTERNS = [
  /password/iu,
  /secret/iu,
  /token/iu,
  /key/iu,
  /auth/iu,
  /credential/iu,
  /ssn/iu,
  /creditcard/iu,
];

export function redactSensitiveData<T>(val: T): T {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(redactSensitiveData) as T;
  }
  const obj = val as Record<string, unknown>;
  const scrubbed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.some((pat) => pat.test(k))) {
      scrubbed[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      scrubbed[k] = redactSensitiveData(v);
    } else {
      scrubbed[k] = v;
    }
  }
  return scrubbed as T;
}

function extractError(cause: unknown): { code: string; message: string } {
  const errObj =
    typeof cause === "object" && cause !== null ? cause : undefined;
  const inner =
    errObj && "error" in errObj ? (errObj as { error: unknown }).error : cause;
  const innerObj =
    typeof inner === "object" && inner !== null ? inner : undefined;
  const code =
    innerObj &&
    "_tag" in innerObj &&
    typeof (innerObj as { _tag: unknown })._tag === "string"
      ? (innerObj as { _tag: string })._tag
      : "OperonServiceError";
  const message =
    innerObj &&
    "message" in innerObj &&
    typeof (innerObj as { message: unknown }).message === "string"
      ? (innerObj as { message: string }).message
      : String(inner);
  return { code, message };
}

/**
 * OperonServiceImpl (S18 / V0-CH-09):
 * Unified kernel entrypoint across CLI, MCP, and SDK.
 * Exposes wire protocol with ResultEnvelope, status codes, and exact error telemetry.
 */
export interface OperonServiceOptions {
  readonly governedActionService: GovernedActionService;
  readonly atomicCommitService: AtomicCommitService;
  readonly authorityService: AuthorityService;
  readonly reconciliationService: ReconciliationService;
  readonly objectStore: ObjectStore;
  readonly f1Evaluator?: F1EvaluatorService;
  readonly f2Mirror?: F2MirrorService;
  readonly publicationBoundary?: PublicationBoundaryService;
}

type WrapSuccess = <T>(
  res: T,
  status?: ResultStatus,
  observations?: readonly string[]
) => ResultEnvelope<T>;

type WrapError = (
  code: string,
  message: string,
  status?: ResultStatus,
  details?: DiagnosticDetails
) => ResultEnvelope;

function buildDiagnosticBundle(
  runId: string,
  operation: string,
  envelope: ResultEnvelope
): DiagnosticBundle {
  const entries: DiagnosticEntry[] = [];
  let businessOutcome:
    | {
        readonly reason?: string;
        readonly status: "success" | "violation" | "inconclusive";
      }
    | undefined;
  let policyOutcome:
    | {
        readonly reason?: string;
        readonly verdict:
          | "ALLOW"
          | "DENY"
          | "REVIEW_REQUIRED"
          | "EVIDENCE_INSUFFICIENT";
      }
    | undefined;
  let infrastructureOutcome:
    | {
        readonly error?: string;
        readonly status: "healthy" | "degraded" | "failed";
      }
    | undefined;

  if (envelope.status === "SUCCESS") {
    businessOutcome = { status: "success" };
    policyOutcome = { verdict: "ALLOW" };
    infrastructureOutcome = { status: "healthy" };
    entries.push({
      channel: "business",
      code: "EXEC_SUCCESS",
      message: `Operation '${operation}' completed successfully`,
      severity: "info",
      timestamp: envelope.executedAt,
    });
  } else if (envelope.status === "DENIED") {
    const msg = envelope.error?.message ?? "Access denied by policy";
    businessOutcome = { reason: msg, status: "violation" };
    policyOutcome = { reason: msg, verdict: "DENY" };
    infrastructureOutcome = { status: "healthy" };
    entries.push({
      channel: "policy",
      code: envelope.error?.code ?? "POLICY_DENIED",
      details: envelope.error?.details
        ? (redactSensitiveData(envelope.error.details) as DiagnosticDetails)
        : undefined,
      message: msg,
      severity: "error",
      timestamp: envelope.executedAt,
    });
  } else if (envelope.status === "REVIEW_REQUIRED") {
    const msg =
      envelope.error?.message ?? "Independent review required before execution";
    businessOutcome = { reason: msg, status: "inconclusive" };
    policyOutcome = { reason: msg, verdict: "REVIEW_REQUIRED" };
    infrastructureOutcome = { status: "healthy" };
    entries.push({
      channel: "policy",
      code: envelope.error?.code ?? "REVIEW_REQUIRED",
      message: msg,
      severity: "warning",
      timestamp: envelope.executedAt,
    });
  } else if (envelope.status === "EVIDENCE_INSUFFICIENT") {
    const msg =
      envelope.error?.message ??
      "Evidence insufficient to satisfy policy invariants";
    businessOutcome = { reason: msg, status: "inconclusive" };
    policyOutcome = { reason: msg, verdict: "EVIDENCE_INSUFFICIENT" };
    infrastructureOutcome = { status: "healthy" };
    entries.push({
      channel: "policy",
      code: envelope.error?.code ?? "EVIDENCE_INSUFFICIENT",
      message: msg,
      severity: "warning",
      timestamp: envelope.executedAt,
    });
  } else {
    const msg = envelope.error?.message ?? "Infrastructure error";
    businessOutcome = { status: "inconclusive" };
    infrastructureOutcome = { error: msg, status: "failed" };
    entries.push({
      channel: "infrastructure",
      code: envelope.error?.code ?? "INFRA_ERROR",
      details: envelope.error?.details
        ? (redactSensitiveData(envelope.error.details) as DiagnosticDetails)
        : undefined,
      message: msg,
      severity: "error",
      timestamp: envelope.executedAt,
    });
  }

  const bundleWithoutHash = {
    businessOutcome,
    channelSummary: {
      businessCount: entries.filter((e) => e.channel === "business").length,
      infrastructureCount: entries.filter((e) => e.channel === "infrastructure")
        .length,
      policyCount: entries.filter((e) => e.channel === "policy").length,
    },
    entries,
    generatedAt: envelope.executedAt,
    infrastructureOutcome,
    operation,
    policyOutcome,
    runId,
  };

  return {
    ...bundleWithoutHash,
    bundleHash: computeDiagnosticBundleHash(bundleWithoutHash),
  };
}

interface ActionDispatchOptions {
  readonly operation: string;
  readonly input: unknown;
  readonly ctx: OperonAgentContext;
  readonly governedActionService: GovernedActionService;
  readonly atomicCommitService: AtomicCommitService;
  readonly wrapSuccess: WrapSuccess;
  readonly wrapError: WrapError;
}

interface QueryDispatchOptions {
  readonly operation: string;
  readonly input: unknown;
  readonly reconciliationService: ReconciliationService;
  readonly objectStore: ObjectStore;
  readonly wrapSuccess: WrapSuccess;
  readonly wrapError: WrapError;
}

interface ReconcileDispatchOptions {
  readonly operation: string;
  readonly input: unknown;
  readonly ctx: OperonAgentContext;
  readonly reconciliationService: ReconciliationService;
  readonly wrapSuccess: WrapSuccess;
  readonly wrapError: WrapError;
}

interface AuthorityDispatchOptions {
  readonly operation: string;
  readonly input: unknown;
  readonly ctx: OperonAgentContext;
  readonly authorityService: AuthorityService;
  readonly wrapSuccess: WrapSuccess;
  readonly wrapError: WrapError;
}

interface AssuranceDispatchOptions {
  readonly operation: string;
  readonly input: unknown;
  readonly ctx: OperonAgentContext;
  readonly f1Evaluator: F1EvaluatorService;
  readonly f2Mirror: F2MirrorService;
  readonly publicationBoundary: PublicationBoundaryService;
  readonly wrapSuccess: WrapSuccess;
  readonly wrapError: WrapError;
}

const handleActionPrepare = Effect.fn("OperonService.handleActionPrepare")(
  function* (opts: ActionDispatchOptions) {
    const pInput = opts.input as {
      actionId: string;
      rawParameters: unknown;
      ttlMs?: number;
    };
    const prepExit = yield* Effect.exit(
      opts.governedActionService.prepareAction({
        actionId: pInput.actionId,
        environmentId: opts.ctx.environmentId,
        grantId: opts.ctx.grantId,
        proposer: opts.ctx.actor,
        rawParameters: pInput.rawParameters,
        tenantId: opts.ctx.tenantId,
        ttlMs: pInput.ttlMs,
      })
    );

    if (Exit.isFailure(prepExit)) {
      const errInfo = extractError(prepExit.cause);
      const errStatus: ResultStatus = Match.value(errInfo.code).pipe(
        Match.when("TenantMismatchError", () => "DENIED" as const),
        Match.when(
          "FreshnessOrPolicyDeniedError",
          () => "EVIDENCE_INSUFFICIENT" as const
        ),
        Match.orElse(() => "ERROR" as const)
      );
      return opts.wrapError(errInfo.code, errInfo.message, errStatus);
    }

    const pAction = prepExit.value as PreparedAction;
    const status: ResultStatus = Match.value(pAction.verdict).pipe(
      Match.when("allow", () => "SUCCESS" as const),
      Match.when("review", () => "REVIEW_REQUIRED" as const),
      Match.when("deny", () => "DENIED" as const),
      Match.orElse(() => "EVIDENCE_INSUFFICIENT" as const)
    );

    return opts.wrapSuccess(
      pAction,
      status,
      pAction.reviewReasons ?? undefined
    );
  }
);

const handleActionApprove = Effect.fn("OperonService.handleActionApprove")(
  function* (opts: ActionDispatchOptions) {
    const aInput = opts.input as {
      preparedDigest: string;
      viewedDigest: string;
      decision?: "approved" | "rejected";
      reason?: string;
      assurance?: "human_verified" | "delegated_service";
    };
    const appExit = yield* Effect.exit(
      opts.governedActionService.approvePreparedAction({
        decision: aInput.decision ?? "approved",
        preparedDigest: aInput.preparedDigest,
        reason: aInput.reason,
        reviewerContext: {
          assurance: aInput.assurance ?? "human_verified",
          environmentId: opts.ctx.environmentId,
          reviewer: opts.ctx.actor,
          tenantId: opts.ctx.tenantId,
        },
        viewedDigest: aInput.viewedDigest,
      })
    );

    if (Exit.isFailure(appExit)) {
      const errInfo = extractError(appExit.cause);
      return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
    }

    return opts.wrapSuccess(appExit.value);
  }
);

const handleActionCommit = Effect.fn("OperonService.handleActionCommit")(
  function* (opts: ActionDispatchOptions) {
    const cInput = opts.input as {
      preparedDigest: string;
      approvalId?: string;
      idempotencyKey: string;
    };

    const prepExit = yield* Effect.exit(
      opts.governedActionService.getPreparedAction(
        cInput.preparedDigest,
        opts.ctx.tenantId
      )
    );
    if (Exit.isFailure(prepExit)) {
      const errInfo = extractError(prepExit.cause);
      return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
    }
    const prepared = prepExit.value as PreparedAction;

    let approval: ApprovalRecord | undefined;
    if (cInput.approvalId) {
      const appExit = yield* Effect.exit(
        opts.governedActionService.getApprovalRecord(
          cInput.approvalId,
          opts.ctx.tenantId
        )
      );
      if (Exit.isFailure(appExit)) {
        const errInfo = extractError(appExit.cause);
        return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
      }
      approval = appExit.value as ApprovalRecord;
    }

    const commitExit = yield* Effect.exit(
      opts.atomicCommitService.commit({
        approval,
        environmentId: opts.ctx.environmentId,
        idempotencyKey: cInput.idempotencyKey,
        prepared,
        tenantId: opts.ctx.tenantId,
      })
    );

    if (Exit.isFailure(commitExit)) {
      const errInfo = extractError(commitExit.cause);
      return opts.wrapError(errInfo.code, errInfo.message, "ERROR");
    }

    return opts.wrapSuccess(commitExit.value);
  }
);

const handleActionStatus = Effect.fn("OperonService.handleActionStatus")(
  function* (opts: ActionDispatchOptions) {
    const sInput = opts.input as { operationId: string };
    const opExit = yield* Effect.exit(
      opts.atomicCommitService.getOperation(
        sInput.operationId,
        opts.ctx.tenantId
      )
    );
    if (Exit.isFailure(opExit)) {
      const errInfo = extractError(opExit.cause);
      return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
    }
    const op = opExit.value;
    if (!op) {
      return opts.wrapError(
        "OperationNotFoundError",
        `Operation '${sInput.operationId}' not found`,
        "DENIED"
      );
    }
    return opts.wrapSuccess(op);
  }
);

const handleActionGet = Effect.fn("OperonService.handleActionGet")(function* (
  opts: ActionDispatchOptions
) {
  const gInput = opts.input as { preparedDigest: string };
  const pExit = yield* Effect.exit(
    opts.governedActionService.getPreparedAction(
      gInput.preparedDigest,
      opts.ctx.tenantId
    )
  );
  if (Exit.isFailure(pExit)) {
    const errInfo = extractError(pExit.cause);
    return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
  }
  return opts.wrapSuccess(pExit.value);
});

const dispatchActionOperation = Effect.fn(
  "OperonService.dispatchActionOperation"
)(function* (opts: ActionDispatchOptions) {
  switch (opts.operation) {
    case "action.prepare": {
      return yield* handleActionPrepare(opts);
    }
    case "action.approve": {
      return yield* handleActionApprove(opts);
    }
    case "action.commit": {
      return yield* handleActionCommit(opts);
    }
    case "action.get": {
      return yield* handleActionGet(opts);
    }
    case "action.list": {
      const list = yield* opts.governedActionService.listPreparedActions(
        opts.ctx.tenantId
      );
      return opts.wrapSuccess(list);
    }
    case "action.status": {
      return yield* handleActionStatus(opts);
    }
    default: {
      return opts.wrapError(
        "UnsupportedOperationError",
        `Operation '${opts.operation}' is not supported by OperonService`,
        "ERROR"
      );
    }
  }
});

const dispatchQueryOperation = Effect.fn(
  "OperonService.dispatchQueryOperation"
)(function* (opts: QueryDispatchOptions) {
  switch (opts.operation) {
    case "query.exact": {
      const qInput = opts.input as ExactQueryRequest;
      const qExit = yield* Effect.exit(
        opts.reconciliationService.query(qInput, opts.objectStore)
      );
      if (Exit.isFailure(qExit)) {
        const errInfo = extractError(qExit.cause);
        return opts.wrapError(errInfo.code, errInfo.message, "ERROR");
      }
      return opts.wrapSuccess(qExit.value);
    }

    case "query.explain": {
      const eInput = opts.input as ExactQueryRequest;
      const typeId = eInput.queryId;
      const paramsRecord = eInput.params as
        | Record<string, string | number>
        | undefined;
      const id =
        paramsRecord && "id" in paramsRecord
          ? String(paramsRecord["id"])
          : "sample";
      const plan = opts.reconciliationService.explainQuery({
        dialect: "sqlite",
        id,
        txTime: eInput.worldView.pinnedAt,
        typeId,
        validTime: eInput.worldView.validTime,
      });
      return opts.wrapSuccess(plan);
    }

    default: {
      return opts.wrapError(
        "UnsupportedOperationError",
        `Operation '${opts.operation}' is not supported by OperonService`,
        "ERROR"
      );
    }
  }
});

const dispatchReconcileOperation = Effect.fn(
  "OperonService.dispatchReconcileOperation"
)(function* (opts: ReconcileDispatchOptions) {
  switch (opts.operation) {
    case "reconcile.propose": {
      const rInput = opts.input as IdentityResolutionProposal;
      const propExit = yield* Effect.exit(
        opts.reconciliationService.proposeIdentityResolution(rInput)
      );
      if (Exit.isFailure(propExit)) {
        const errInfo = extractError(propExit.cause);
        return opts.wrapError(errInfo.code, errInfo.message, "ERROR");
      }
      return opts.wrapSuccess(propExit.value);
    }

    case "reconcile.resolve": {
      const resInput = opts.input as {
        proposalId: string;
        decisionRef?: string;
        forceOverride?: boolean;
        idempotencyKey?: string;
      };
      const resExit = yield* Effect.exit(
        opts.reconciliationService.resolveIdentity(
          resInput.proposalId,
          resInput.decisionRef ?? `dec_${yield* Clock.currentTimeMillis}`,
          {
            environmentId: opts.ctx.environmentId,
            forceOverride: resInput.forceOverride,
            idempotencyKey: resInput.idempotencyKey,
            tenantId: opts.ctx.tenantId,
          }
        )
      );
      if (Exit.isFailure(resExit)) {
        const errInfo = extractError(resExit.cause);
        return opts.wrapError(errInfo.code, errInfo.message, "ERROR");
      }
      return opts.wrapSuccess(resExit.value);
    }

    case "reconcile.list": {
      const proposals = yield* opts.reconciliationService.listProposals(
        opts.ctx.tenantId
      );
      return opts.wrapSuccess(proposals);
    }

    default: {
      return opts.wrapError(
        "UnsupportedOperationError",
        `Operation '${opts.operation}' is not supported by OperonService`,
        "ERROR"
      );
    }
  }
});

const dispatchAuthorityOperation = Effect.fn(
  "OperonService.dispatchAuthorityOperation"
)(function* (opts: AuthorityDispatchOptions) {
  switch (opts.operation) {
    case "grant.register": {
      const g = yield* opts.authorityService.registerGrant(
        opts.input as IntentGrant
      );
      return opts.wrapSuccess(g);
    }

    case "mandate.register": {
      const m = yield* opts.authorityService.registerMandate(
        opts.input as TaskMandate
      );
      return opts.wrapSuccess(m);
    }

    case "grant.list": {
      const gInput = (opts.input as { actorId?: string }) ?? {};
      const grants = yield* opts.authorityService.listGrants(
        opts.ctx.tenantId,
        gInput.actorId
      );
      return opts.wrapSuccess(grants);
    }

    default: {
      return opts.wrapError(
        "UnsupportedOperationError",
        `Operation '${opts.operation}' is not supported by OperonService`,
        "ERROR"
      );
    }
  }
});

const handleAssuranceEvaluateF1 = Effect.fn(
  "OperonService.handleAssuranceEvaluateF1"
)(function* (opts: AssuranceDispatchOptions) {
  const fInput = opts.input as {
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
    opts.f1Evaluator.evaluate({
      ...fInput,
      environmentId: opts.ctx.environmentId,
      tenantId: opts.ctx.tenantId,
    })
  );
  if (Exit.isFailure(evalExit)) {
    const errInfo = extractError(evalExit.cause);
    return opts.wrapError(
      errInfo.code,
      errInfo.message,
      errInfo.code === "NonDisclosureError" ? "DENIED" : "ERROR"
    );
  }
  const receipt = evalExit.value;
  const outcomeStatus: ResultStatus = Match.value(receipt.outcome).pipe(
    Match.when("PASS", () => "SUCCESS" as const),
    Match.when("FAIL", () => "DENIED" as const),
    Match.orElse(() => "EVIDENCE_INSUFFICIENT" as const)
  );
  return opts.wrapSuccess(receipt, outcomeStatus);
});

const handleAssuranceMirrorF2 = Effect.fn(
  "OperonService.handleAssuranceMirrorF2"
)(function* (opts: AssuranceDispatchOptions) {
  const mInput = opts.input as {
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
    opts.f2Mirror.evaluateMirror({
      ...mInput,
      actorId: opts.ctx.actor.id,
      environmentId: opts.ctx.environmentId,
      tenantId: opts.ctx.tenantId,
    })
  );
  if (Exit.isFailure(mExit)) {
    const errInfo = extractError(mExit.cause);
    return opts.wrapError(
      errInfo.code,
      errInfo.message,
      errInfo.code === "F2InternalBypassError" ||
        errInfo.code === "NonDisclosureError"
        ? "DENIED"
        : "ERROR"
    );
  }
  return opts.wrapSuccess(mExit.value);
});

const handleAssuranceScan = Effect.fn("OperonService.handleAssuranceScan")(
  function* (opts: AssuranceDispatchOptions) {
    const sInput =
      (opts.input as {
        targetDirectory?: string;
        allowedPublicOnly?: boolean;
      }) ?? {};
    const targetDir = sInput.targetDirectory ?? process.cwd();
    const scanExit = yield* Effect.exit(
      opts.publicationBoundary.scanDirectory(targetDir, {
        allowedPublicOnly: sInput.allowedPublicOnly ?? true,
      })
    );
    if (Exit.isFailure(scanExit)) {
      const errInfo = extractError(scanExit.cause);
      return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
    }
    const res = scanExit.value;
    return opts.wrapSuccess(res, res.isClean ? "SUCCESS" : "DENIED");
  }
);

const dispatchAssuranceOperation = Effect.fn(
  "OperonService.dispatchAssuranceOperation"
)(function* (opts: AssuranceDispatchOptions) {
  switch (opts.operation) {
    case "assurance.evaluateF1": {
      return yield* handleAssuranceEvaluateF1(opts);
    }
    case "assurance.verifyF1Receipt": {
      const receipt = opts.input as PublicF1Receipt;
      const vExit = yield* Effect.exit(opts.f1Evaluator.verifyReceipt(receipt));
      if (Exit.isFailure(vExit)) {
        const errInfo = extractError(vExit.cause);
        return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
      }
      return opts.wrapSuccess(vExit.value);
    }
    case "assurance.mirrorF2": {
      return yield* handleAssuranceMirrorF2(opts);
    }
    case "assurance.verifyF2Receipt": {
      const receipt = opts.input as F2Receipt;
      const vExit = yield* Effect.exit(opts.f2Mirror.verifyReceipt(receipt));
      if (Exit.isFailure(vExit)) {
        const errInfo = extractError(vExit.cause);
        return opts.wrapError(errInfo.code, errInfo.message, "DENIED");
      }
      return opts.wrapSuccess(vExit.value);
    }
    case "assurance.scanPublication": {
      return yield* handleAssuranceScan(opts);
    }
    default: {
      return opts.wrapError(
        "UnsupportedOperationError",
        `Operation '${opts.operation}' is not supported by OperonService`,
        "ERROR"
      );
    }
  }
});

export class OperonServiceImpl implements OperonService {
  private readonly diagnosticRegistry = new Map<string, DiagnosticBundle>();
  private readonly governedActionService: GovernedActionService;
  private readonly atomicCommitService: AtomicCommitService;
  private readonly authorityService: AuthorityService;
  private readonly reconciliationService: ReconciliationService;
  private readonly objectStore: ObjectStore;
  private readonly f1Evaluator: F1EvaluatorService;
  private readonly f2Mirror: F2MirrorService;
  private readonly publicationBoundary: PublicationBoundaryService;

  constructor(options: OperonServiceOptions) {
    this.governedActionService = options.governedActionService;
    this.atomicCommitService = options.atomicCommitService;
    this.authorityService = options.authorityService;
    this.reconciliationService = options.reconciliationService;
    this.objectStore = options.objectStore;
    this.f1Evaluator = options.f1Evaluator ?? new F1EvaluatorService();
    this.f2Mirror = options.f2Mirror ?? new F2MirrorService();
    this.publicationBoundary =
      options.publicationBoundary ?? new PublicationBoundaryService();
  }

  invokeEffect(
    ctx: OperonAgentContext,
    operation: string,
    input: unknown
  ): Effect.Effect<ResultEnvelope> {
    const {
      atomicCommitService,
      authorityService,
      diagnosticRegistry,
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
      details?: DiagnosticDetails
    ): ResultEnvelope => ({
      error: { code, details, message },
      executedAt: Date.now(),
      operation,
      schemaVersion: "operon.v0",
      status,
    });

    const executeOperation = Effect.fn("OperonService.executeOperation")(
      function* () {
        if (operation.startsWith("action.")) {
          return yield* dispatchActionOperation({
            atomicCommitService,
            ctx,
            governedActionService,
            input,
            operation,
            wrapError,
            wrapSuccess,
          });
        }
        if (operation.startsWith("query.")) {
          return yield* dispatchQueryOperation({
            input,
            objectStore,
            operation,
            reconciliationService,
            wrapError,
            wrapSuccess,
          });
        }
        if (operation.startsWith("reconcile.")) {
          return yield* dispatchReconcileOperation({
            ctx,
            input,
            operation,
            reconciliationService,
            wrapError,
            wrapSuccess,
          });
        }
        if (
          operation.startsWith("grant.") ||
          operation.startsWith("mandate.")
        ) {
          return yield* dispatchAuthorityOperation({
            authorityService,
            ctx,
            input,
            operation,
            wrapError,
            wrapSuccess,
          });
        }
        if (operation.startsWith("assurance.")) {
          return yield* dispatchAssuranceOperation({
            ctx,
            f1Evaluator,
            f2Mirror,
            input,
            operation,
            publicationBoundary,
            wrapError,
            wrapSuccess,
          });
        }
        if (operation === "view.generate") {
          const vInput =
            (input as {
              audience?: string;
              data?: ViewRecord | readonly ViewRecord[];
              format?: "json" | "markdown" | "table" | "card";
              grant?: IntentGrant;
              state?: ViewLifecycleState;
              title?: string;
            }) ?? {};
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
        if (operation === "diagnostics.diagnose") {
          const dInput = input as { runId: string };
          const bundle = diagnosticRegistry.get(dInput.runId);
          if (!bundle) {
            return wrapError(
              "DiagnosticNotFoundError",
              `Diagnostic bundle for run '${dInput.runId}' not found`,
              "ERROR"
            );
          }
          return wrapSuccess(bundle);
        }
        return wrapError(
          "UnsupportedOperationError",
          `Operation '${operation}' is not supported by OperonService`,
          "ERROR"
        );
      }
    );

    return Effect.gen({ self: this }, function* () {
      const envelope = yield* executeOperation();
      const runId =
        ctx.correlationId ?? generatePrefixedId("run", envelope.executedAt);

      if (operation !== "diagnostics.diagnose") {
        diagnosticRegistry.set(
          runId,
          buildDiagnosticBundle(runId, operation, envelope)
        );
      }

      return envelope;
    });
  }

  diagnose(
    runId: string
  ): Effect.Effect<DiagnosticBundle, DiagnosticNotFoundError> {
    const bundle = this.diagnosticRegistry.get(runId);
    if (!bundle) {
      return Effect.fail(
        new DiagnosticNotFoundError({
          message: `Diagnostic bundle for run '${runId}' not found`,
          runId,
        })
      );
    }
    return Effect.succeed(bundle);
  }

  invoke(
    ctx: OperonAgentContext,
    operation: string,
    input: unknown
  ): Promise<ResultEnvelope> {
    return Effect.runPromise(this.invokeEffect(ctx, operation, input));
  }
}
