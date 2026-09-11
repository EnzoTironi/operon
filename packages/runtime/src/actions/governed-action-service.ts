import { createHash } from "node:crypto";

import type {
  ActionEvaluationContext,
  ActionParameters,
  ActionType,
  ApprovalRecord,
  EvidenceClosureItem,
  ObjectRevisionRef,
  ObjectTypeId,
  PredicateDependency,
  PreparedAction,
  RequestedEffect,
  ReviewerContext,
  Subject,
  WorldView,
} from "@operon/schema";
import {
  computeApprovalRecordHash,
  computePreparedActionDigest,
  createWorldView,
  generatePrefixedId,
  serializeJson,
} from "@operon/schema";
import { Clock, Effect, Schema } from "effect";

import {
  ApprovalDigestMismatchError,
  ApprovalRecordNotFoundError,
  FabricatedApprovalError,
  FreshnessOrPolicyDeniedError,
  PreparedActionNotFoundError,
  SelfApprovalDeniedError,
  StaleApprovalError,
  TenantMismatchError,
  UnauthorizedReviewerError,
} from "../actions-errors.js";
import { ParameterValidationError } from "../errors.js";
import type { ObjectStore } from "../object-store.js";
import type { AuthorityService } from "../policy/authority.js";

export interface GovernedActionSnapshot {
  readonly preparedActions: readonly PreparedAction[];
  readonly approvalRecords: readonly ApprovalRecord[];
}

export interface PrepareActionInput {
  readonly actionId: string;
  readonly rawParameters: unknown;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly proposer: Subject;
  readonly grantId?: string;
  readonly worldView?: WorldView;
  readonly ttlMs?: number;
}

export interface ApprovePreparedActionInput {
  readonly preparedDigest: string;
  readonly viewedDigest: string;
  readonly decision: "approved" | "rejected";
  readonly reviewerContext: ReviewerContext;
  readonly reason?: string;
}

const DEFAULT_APPROVER_ROLES = new Set([
  "academic_adviser",
  "admin",
  "approver",
  "chief_engineer",
  "compliance_officer",
  "department_director",
  "director",
  "lead_engineer",
  "operator",
  "physician",
  "reviewer",
  "specialist",
]);

interface ActionCheckItem {
  readonly checkId: string;
  readonly name: string;
  readonly executed: boolean;
  readonly status: "passed" | "failed" | "needs_execution_revalidation";
  readonly reason?: string;
}

function determineActionVerdict(params: {
  readonly hasDenial: boolean;
  readonly hasReviewRequirement: boolean;
  readonly failedReasonsCount: number;
  readonly defaultExecutionMode: string;
  readonly proposer: Subject;
}): "allow" | "review" | "deny" | "evidence_insufficient" {
  if (params.hasDenial) {
    return "deny";
  }
  if (params.hasReviewRequirement) {
    return "review";
  }
  if (params.failedReasonsCount > 0) {
    return "evidence_insufficient";
  }
  if (
    params.defaultExecutionMode === "proposal" ||
    params.proposer.agentTier === 2 ||
    (params.proposer.agentTier === 3 && params.proposer.type === "agent")
  ) {
    return "review";
  }
  return "allow";
}

function collectRequestedEffects(
  action: ActionType<ActionParameters>
): RequestedEffect[] {
  const effects: RequestedEffect[] = [];
  if (action.mutation) {
    effects.push({
      description: `State mutation on ${action.targetObjectTypeId ?? "target"}`,
      effectId: `${action.id}_mutation`,
      isLiveExternal: false,
      mutationTypes: ["put"],
    });
  }
  if (action.sideEffects) {
    for (const se of action.sideEffects) {
      effects.push({
        description: se.description,
        effectId: se.id,
        isLiveExternal: true,
      });
    }
  }
  return effects;
}

const collectObjectRevisions = Effect.fn(
  "GovernedActionService.collectObjectRevisions"
)(function* (
  action: ActionType<ActionParameters>,
  pRecord: Record<string, unknown>,
  objectStore: ObjectStore
) {
  const objectRevisions: ObjectRevisionRef[] = [];
  const candidateTargetIds = [
    pRecord.targetId,
    pRecord.patientId,
    pRecord.claimId,
    pRecord.objectId,
    pRecord.userId,
  ].filter((val): val is string => typeof val === "string" && val.length > 0);

  yield* Effect.forEach(
    candidateTargetIds,
    Effect.fn("GovernedActionService.resolveTargetObject")(
      function* (targetId) {
        const targetType =
          action.targetObjectTypeId ?? ("Object" as ObjectTypeId);
        const existingObj = yield* objectStore.getObject(
          targetType as ObjectTypeId,
          targetId
        );
        if (existingObj) {
          objectRevisions.push({
            objectId: existingObj.id,
            propertyRevisions: {},
            revision: existingObj.version,
            typeId: existingObj.typeId,
          });
        }
      }
    ),
    { concurrency: 1 }
  );
  return objectRevisions;
});

const evaluateFreshnessChecks = Effect.fn(
  "GovernedActionService.evaluateFreshnessChecks"
)(function* (
  action: ActionType<ActionParameters>,
  pRecord: Record<string, unknown>,
  objectStore: ObjectStore,
  worldView: WorldView
) {
  const failedReasons: string[] = [];
  const checks: ActionCheckItem[] = [];

  if (!action.requiredFreshnessProperties) {
    return { checks, failedReasons };
  }

  yield* Effect.forEach(
    action.requiredFreshnessProperties,
    Effect.fn("GovernedActionService.checkFreshnessReq")(function* (req) {
      const targetId = pRecord.targetId as string | undefined;
      if (!targetId) {
        failedReasons.push(
          `Missing targetId for freshness check '${req.propertyName}'`
        );
        checks.push({
          checkId: `freshness_${req.propertyName}`,
          executed: true,
          name: `Freshness check for ${req.propertyName}`,
          reason: "Missing targetId",
          status: "failed",
        });
        return;
      }

      const obj = yield* objectStore.getObject(req.objectTypeId, targetId);
      if (!obj) {
        failedReasons.push(
          `Target object '${targetId}' not found for freshness check '${req.propertyName}'`
        );
        checks.push({
          checkId: `freshness_${req.propertyName}`,
          executed: true,
          name: `Freshness check for ${req.propertyName}`,
          reason: `Target object '${targetId}' not found`,
          status: "failed",
        });
        return;
      }

      const propTimestamps = obj.provenance?.propertyTimestamps;
      const recordedAt =
        propTimestamps?.[req.propertyName] ??
        obj.provenance?.recordedAt ??
        obj.lastModifiedAt;
      const ageMs = worldView.validTime - recordedAt;
      if (ageMs > req.maxStalenessMs) {
        const reason = `Property '${req.propertyName}' staleness ${ageMs}ms exceeds budget ${req.maxStalenessMs}ms`;
        failedReasons.push(reason);
        checks.push({
          checkId: `freshness_${req.propertyName}`,
          executed: true,
          name: `Freshness check for ${req.propertyName}`,
          reason,
          status: "failed",
        });
      } else {
        checks.push({
          checkId: `freshness_${req.propertyName}`,
          executed: true,
          name: `Freshness check for ${req.propertyName}`,
          status: "passed",
        });
      }
    }),
    { concurrency: 1 }
  );

  return { checks, failedReasons };
});

const evaluateCriteriaGuards = Effect.fn(
  "GovernedActionService.evaluateCriteriaGuards"
)(function* (
  action: ActionType<ActionParameters>,
  normalizedParameters: ActionParameters,
  evalContext: ActionEvaluationContext
) {
  const predicateDependencies: PredicateDependency[] = [];
  const checks: ActionCheckItem[] = [];
  const failedReasons: string[] = [];
  let hasReviewRequirement = false;
  let hasDenial = false;

  yield* Effect.forEach(
    action.submissionCriteria,
    Effect.fn("GovernedActionService.evalCriterion")(function* (criterion) {
      const result = yield* criterion.evaluate(
        normalizedParameters,
        evalContext
      );
      predicateDependencies.push({
        criterionId: criterion.id,
        description: criterion.description,
        passed: result.passed,
        verdict: result.verdict,
      });

      checks.push({
        checkId: criterion.id,
        executed: true,
        name: criterion.description,
        reason: result.failureReason,
        status: result.passed ? "passed" : "failed",
      });

      if (!result.passed) {
        if (result.verdict === "deny") {
          hasDenial = true;
          failedReasons.push(
            result.failureReason ?? `Criterion '${criterion.id}' denied`
          );
        } else {
          hasReviewRequirement = true;
          failedReasons.push(
            result.failureReason ??
              `Criterion '${criterion.id}' requires review`
          );
        }
      }
    }),
    { concurrency: 1 }
  );

  return {
    checks,
    failedReasons,
    hasDenial,
    hasReviewRequirement,
    predicateDependencies,
  };
});

/**
 * GovernedActionService (S06, S07 / V0-CH-07):
 * Manages action preparation (dry-run, zero business mutation) and exact proposal approval.
 */
export class GovernedActionService {
  private readonly actionTypes = new Map<
    string,
    ActionType<ActionParameters>
  >();
  private readonly preparedActions = new Map<string, PreparedAction>(); // keyed by canonicalDigest
  private readonly preparedById = new Map<string, PreparedAction>();
  private readonly approvals = new Map<string, ApprovalRecord>(); // keyed by id
  private readonly approvalsByPreparedDigest = new Map<
    string,
    ApprovalRecord
  >();

  constructor(
    registeredActions: readonly ActionType<ActionParameters>[],
    private readonly objectStore: ObjectStore,
    private readonly authorityService: AuthorityService,
    initialSnapshot?: GovernedActionSnapshot
  ) {
    for (const a of registeredActions) {
      this.actionTypes.set(a.id, a);
    }
    if (initialSnapshot) {
      for (const p of initialSnapshot.preparedActions) {
        this.preparedActions.set(p.canonicalDigest, p);
        this.preparedById.set(p.id, p);
      }
      for (const a of initialSnapshot.approvalRecords) {
        this.approvals.set(a.id, a);
        this.approvalsByPreparedDigest.set(a.preparedDigest, a);
      }
    }
  }

  registerActionType(action: ActionType<ActionParameters>): void {
    this.actionTypes.set(action.id, action);
  }

  getActionType(actionId: string): ActionType<ActionParameters> | undefined {
    return this.actionTypes.get(actionId);
  }

  /**
   * Action.prepare (S07):
   * Validates input, resolves immutable release, checks policy/grant, collects WorldView,
   * evaluates submission criteria and freshness budgets, records object revisions,
   * and produces PreparedAction with canonical digest.
   *
   * CAUTION: Causes NO business side effects or mutations. Business state remains untouched.
   */
  prepareAction(
    input: PrepareActionInput
  ): Effect.Effect<
    PreparedAction,
    | ParameterValidationError
    | FreshnessOrPolicyDeniedError
    | TenantMismatchError
    | unknown
  > {
    const {
      actionTypes,
      objectStore,
      authorityService,
      preparedActions,
      preparedById,
    } = this;

    return Effect.gen(function* () {
      const {
        actionId,
        rawParameters,
        tenantId,
        environmentId,
        proposer,
        grantId,
        ttlMs = 24 * 60 * 60 * 1000,
      } = input;
      const now = yield* Clock.currentTimeMillis;

      const action = actionTypes.get(actionId);
      if (!action) {
        return yield* new FreshnessOrPolicyDeniedError({
          actionId,
          message: `ActionType '${actionId}' is not registered`,
          reasons: [`ActionType '${actionId}' not found`],
        });
      }

      // 1. Parameter decoding & validation
      const decodeParameters = Schema.decodeUnknownEffect(
        action.parametersSchema as Schema.Decoder<ActionParameters>
      );
      const normalizedParameters = yield* decodeParameters(rawParameters).pipe(
        Effect.mapError(
          (err) =>
            new ParameterValidationError({
              actionTypeId: action.id,
              details: err,
              message: `Parameter validation failed: ${err instanceof Error ? err.message : String(err)}`,
            })
        )
      );

      // 2. Validate IntentGrant authority if specified (S06)
      if (grantId) {
        yield* authorityService.validateGrantAuthority({
          actionId: action.id,
          actor: proposer,
          environmentId,
          grantId,
          now,
          reservationAmount: 1,
          tenantId,
        });
      }

      // 3. Build or use provided WorldView
      const worldView =
        input.worldView ??
        createWorldView({
          definitionReleaseRef: "1.0.0",
          environmentId,
          evidenceCoverage: [`action:${action.id}`],
          knowledgeRevision: 1,
          ontologyId: "default",
          pinnedAt: now,
          policyContext: { agentTier: proposer.agentTier ?? 4 },
          tenantId,
          validTime: now,
        });

      // 4. Object revisions inspection
      const pRecord = normalizedParameters as Record<string, unknown>;
      const objectRevisions = yield* collectObjectRevisions(
        action,
        pRecord,
        objectStore
      );

      // 5. Freshness check against pinned WorldView
      const freshness = yield* evaluateFreshnessChecks(
        action,
        pRecord,
        objectStore,
        worldView
      );

      // 6. Evaluate Submission Criteria guards
      const evalContext: ActionEvaluationContext = {
        getObject: (typeId, id) => objectStore.getObject(typeId, id),
        now: worldView.validTime,
        security: {
          correlationId: `prep_${now}`,
          subject: proposer,
          timestamp: now,
        },
      };

      const criteria = yield* evaluateCriteriaGuards(
        action,
        normalizedParameters,
        evalContext
      );

      const checks: ActionCheckItem[] = [
        ...freshness.checks,
        ...criteria.checks,
        {
          checkId: "cas_revision_lock",
          executed: false,
          name: "Optimistic concurrency version check",
          status: "needs_execution_revalidation",
        },
      ];
      if (grantId) {
        checks.push({
          checkId: "grant_reservation_commit",
          executed: false,
          name: "Grant budget reservation check",
          status: "needs_execution_revalidation",
        });
      }

      const allFailedReasons = [
        ...freshness.failedReasons,
        ...criteria.failedReasons,
      ];
      const verdict = determineActionVerdict({
        defaultExecutionMode: action.defaultExecutionMode,
        failedReasonsCount: allFailedReasons.length,
        hasDenial: criteria.hasDenial,
        hasReviewRequirement: criteria.hasReviewRequirement,
        proposer,
      });

      // 7. Evidence closure
      const evidenceDigest = createHash("sha256")
        .update(
          serializeJson({
            actionId: action.id,
            objectRevisions,
            params: normalizedParameters,
            worldViewDigest: worldView.digest,
          })
        )
        .digest("hex");

      const evidenceClosure: EvidenceClosureItem[] = [
        {
          description: `Evidence closure for ${action.id} proposal`,
          digest: evidenceDigest,
          evidenceId: `ev_${now}`,
          recordedAt: now,
        },
      ];

      // 8. Requested effects
      const requestedEffects = collectRequestedEffects(action);

      const id = generatePrefixedId("prep", now);
      const preparedWithoutDigest: Omit<PreparedAction, "canonicalDigest"> = {
        actionId: action.id,
        actionRelease: "1.0.0",
        checks,
        environmentId,
        evidenceClosure,
        expiresAt: now + ttlMs,
        grantId,
        id,
        intendedRecipients: [],
        normalizedParameters,
        objectRevisions,
        predicateDependencies: criteria.predicateDependencies,
        preparedAt: now,
        proposer,
        requestedEffects,
        reviewReasons:
          allFailedReasons.length > 0 ? allFailedReasons : undefined,
        tenantId,
        usageReservations: [{ amount: 1, resource: action.id }],
        verdict,
        worldView,
      };

      const canonicalDigest = computePreparedActionDigest(
        preparedWithoutDigest
      );
      const preparedAction: PreparedAction = {
        ...preparedWithoutDigest,
        canonicalDigest,
      };

      // Store in memory
      preparedActions.set(canonicalDigest, preparedAction);
      preparedById.set(id, preparedAction);

      return preparedAction;
    });
  }

  /**
   * approvePreparedAction (S07):
   * Validates exact digest match (preparedDigest === viewedDigest),
   * reviewer authorization, no self-approval, no fabricated agent approvals,
   * non-staleness, and produces an ApprovalRecord.
   */
  approvePreparedAction(
    input: ApprovePreparedActionInput
  ): Effect.Effect<
    ApprovalRecord,
    | PreparedActionNotFoundError
    | ApprovalDigestMismatchError
    | StaleApprovalError
    | SelfApprovalDeniedError
    | FabricatedApprovalError
    | UnauthorizedReviewerError
    | TenantMismatchError
  > {
    const { preparedActions, approvals, approvalsByPreparedDigest } = this;

    return Effect.gen(function* () {
      const {
        preparedDigest,
        viewedDigest,
        decision,
        reviewerContext,
        reason,
      } = input;
      const now = yield* Clock.currentTimeMillis;

      // 1. Lookup prepared action by preparedDigest
      const prepared = preparedActions.get(preparedDigest);
      if (!prepared) {
        return yield* new PreparedActionNotFoundError({
          message: `Prepared action with digest '${preparedDigest}' not found`,
          preparedDigest,
        });
      }

      // 2. Tenant non-disclosure check
      if (prepared.tenantId !== reviewerContext.tenantId) {
        return yield* new TenantMismatchError({
          message: `Prepared action does not exist for tenant`,
          tenantId: reviewerContext.tenantId,
        });
      }

      // 3. Exact Proposal Digest Match (S07 Invariant)
      if (preparedDigest !== viewedDigest) {
        return yield* new ApprovalDigestMismatchError({
          message: `Viewed proposal digest '${viewedDigest}' does not match prepared digest '${preparedDigest}'`,
          preparedDigest,
          viewedDigest,
        });
      }

      // 4. Stale approval check (Proposal expiration)
      if (now > prepared.expiresAt) {
        return yield* new StaleApprovalError({
          message: `Prepared action proposal '${prepared.id}' expired at ${prepared.expiresAt}`,
          preparedDigest,
          reason: "proposal_expired",
        });
      }

      // 5. Self-Approval Invariant: Proposer cannot self-approve
      if (reviewerContext.reviewer.id === prepared.proposer.id) {
        return yield* new SelfApprovalDeniedError({
          message: `Independent review required: proposer '${prepared.proposer.id}' cannot approve own proposal`,
          proposerId: prepared.proposer.id,
          reviewerId: reviewerContext.reviewer.id,
        });
      }

      // 6. Fabricated Approval Invariant: Sentinel or AI agent cannot satisfy human approval requirement
      if (
        reviewerContext.reviewer.type === "agent" &&
        reviewerContext.assurance !== "delegated_service"
      ) {
        return yield* new FabricatedApprovalError({
          message: `Approval requires an authenticated human reviewer, but got agent '${reviewerContext.reviewer.id}'`,
          reason: "agent_cannot_approve_human_proposal",
        });
      }

      // 7. Role / Authorization check
      const hasAllowedRole = reviewerContext.reviewer.roles.some((r) =>
        DEFAULT_APPROVER_ROLES.has(r.toLowerCase())
      );
      if (!hasAllowedRole) {
        return yield* new UnauthorizedReviewerError({
          message: `Reviewer '${reviewerContext.reviewer.id}' lacks authorized approver role`,
          requiredRole: "approver",
          reviewerId: reviewerContext.reviewer.id,
        });
      }

      // 8. Create ApprovalRecord
      const approvalId = generatePrefixedId("appr", now);
      const approvalWithoutHash: Omit<ApprovalRecord, "recordHash"> = {
        actionRelease: prepared.actionRelease,
        approvedAt: now,
        decision,
        expiresAt: prepared.expiresAt,
        id: approvalId,
        policyRelease: "1.0.0",
        preparedDigest,
        preparedId: prepared.id,
        reason,
        reviewerContext,
        viewedDigest,
      };

      const recordHash = computeApprovalRecordHash(approvalWithoutHash);
      const approvalRecord: ApprovalRecord = {
        ...approvalWithoutHash,
        recordHash,
      };

      approvals.set(approvalId, approvalRecord);
      approvalsByPreparedDigest.set(preparedDigest, approvalRecord);

      return approvalRecord;
    });
  }

  getPreparedAction(
    preparedDigest: string,
    tenantId: string
  ): Effect.Effect<
    PreparedAction,
    PreparedActionNotFoundError | TenantMismatchError
  > {
    const { preparedActions } = this;
    return Effect.gen(function* () {
      const p = preparedActions.get(preparedDigest);
      if (!p) {
        return yield* new PreparedActionNotFoundError({
          message: `Prepared action with digest '${preparedDigest}' not found`,
          preparedDigest,
        });
      }
      if (p.tenantId !== tenantId) {
        return yield* new TenantMismatchError({
          message: "Prepared action does not exist for tenant",
          tenantId,
        });
      }
      return p;
    });
  }

  getApprovalRecord(
    approvalId: string,
    tenantId: string
  ): Effect.Effect<
    ApprovalRecord,
    ApprovalRecordNotFoundError | TenantMismatchError
  > {
    const { approvals } = this;
    return Effect.gen(function* () {
      const a = approvals.get(approvalId);
      if (!a) {
        return yield* new ApprovalRecordNotFoundError({
          approvalId,
          message: `Approval record '${approvalId}' not found`,
        });
      }
      if (a.reviewerContext.tenantId !== tenantId) {
        return yield* new TenantMismatchError({
          message: "Approval record does not exist for tenant",
          tenantId,
        });
      }
      return a;
    });
  }

  getApprovalForPreparedDigest(
    preparedDigest: string,
    tenantId: string
  ): Effect.Effect<ApprovalRecord | undefined, TenantMismatchError> {
    const { approvalsByPreparedDigest } = this;
    return Effect.gen(function* () {
      const a = approvalsByPreparedDigest.get(preparedDigest);
      if (!a) {
        return;
      }
      if (a.reviewerContext.tenantId !== tenantId) {
        return yield* new TenantMismatchError({
          message: "Approval record does not exist for tenant",
          tenantId,
        });
      }
      return a;
    });
  }

  listPreparedActions(
    tenantId: string
  ): Effect.Effect<readonly PreparedAction[]> {
    const { preparedActions } = this;
    return Effect.sync(() =>
      [...preparedActions.values()].filter((p) => p.tenantId === tenantId)
    );
  }

  listApprovals(tenantId: string): Effect.Effect<readonly ApprovalRecord[]> {
    const { approvals } = this;
    return Effect.sync(() =>
      [...approvals.values()].filter(
        (a) => a.reviewerContext.tenantId === tenantId
      )
    );
  }

  exportSnapshot(): GovernedActionSnapshot {
    return {
      approvalRecords: [...this.approvals.values()],
      preparedActions: [...this.preparedActions.values()],
    };
  }

  importSnapshot(snapshot: GovernedActionSnapshot): void {
    this.preparedActions.clear();
    this.preparedById.clear();
    this.approvals.clear();
    this.approvalsByPreparedDigest.clear();
    for (const p of snapshot.preparedActions) {
      this.preparedActions.set(p.canonicalDigest, p);
      this.preparedById.set(p.id, p);
    }
    for (const a of snapshot.approvalRecords) {
      this.approvals.set(a.id, a);
      this.approvalsByPreparedDigest.set(a.preparedDigest, a);
    }
  }
}
