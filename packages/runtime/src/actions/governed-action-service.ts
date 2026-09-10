import { createHash } from "node:crypto";

import type {
  ActionEvaluationContext,
  ActionType,
  ApprovalRecord,
  EvidenceClosureItem,
  ObjectRevisionRef,
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
} from "@operon/schema";
import { Effect, Schema } from "effect";

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

/**
 * GovernedActionService (S06, S07 / V0-CH-07):
 * Manages action preparation (dry-run, zero business mutation) and exact proposal approval.
 */
export class GovernedActionService {
  private readonly actionTypes = new Map<string, ActionType<any>>();
  private readonly preparedActions = new Map<string, PreparedAction>(); // keyed by canonicalDigest
  private readonly preparedById = new Map<string, PreparedAction>();
  private readonly approvals = new Map<string, ApprovalRecord>(); // keyed by id
  private readonly approvalsByPreparedDigest = new Map<
    string,
    ApprovalRecord
  >();

  constructor(
    registeredActions: readonly ActionType<any>[],
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

  registerActionType(action: ActionType<any>): void {
    this.actionTypes.set(action.id, action);
  }

  getActionType(actionId: string): ActionType<any> | undefined {
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
      const now = Date.now();

      const action = actionTypes.get(actionId);
      if (!action) {
        return yield* Effect.fail(
          new FreshnessOrPolicyDeniedError({
            actionId,
            message: `ActionType '${actionId}' is not registered`,
            reasons: [`ActionType '${actionId}' not found`],
          })
        );
      }

      // 1. Parameter decoding & validation
      const normalizedParameters = yield* Schema.decodeUnknownEffect(
        action.parametersSchema as Schema.Decoder<any>
      )(rawParameters).pipe(
        Effect.mapError(
          (err) =>
            new ParameterValidationError({
              actionTypeId: action.id,
              details: err,
              message: `Parameter validation failed: ${String((err as any)?.message ?? err)}`,
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

      // 4. Object revisions inspection (pins target object state for CAS revalidation at commit)
      const objectRevisions: ObjectRevisionRef[] = [];
      const pRecord = normalizedParameters as Record<string, unknown>;
      const candidateTargetIds = [
        pRecord.targetId,
        pRecord.patientId,
        pRecord.claimId,
        pRecord.objectId,
        pRecord.userId,
      ].filter(
        (val): val is string => typeof val === "string" && val.length > 0
      );

      for (const targetId of candidateTargetIds) {
        const targetType = action.targetObjectTypeId ?? ("Object" as const);
        const existingObj = yield* objectStore.getObject(
          targetType as any,
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

      // 5. Freshness check against pinned WorldView
      const failedReasons: string[] = [];
      const checks: {
        checkId: string;
        name: string;
        executed: boolean;
        status: "passed" | "failed" | "needs_execution_revalidation";
        reason?: string;
      }[] = [];

      if (action.requiredFreshnessProperties) {
        for (const req of action.requiredFreshnessProperties) {
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
            continue;
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
            continue;
          }

          const propTimestamps = (obj.provenance as any)?.propertyTimestamps as
            | Record<string, number>
            | undefined;
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
        }
      }

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

      const predicateDependencies: PredicateDependency[] = [];
      let hasReviewRequirement = false;
      let hasDenial = false;

      for (const criterion of action.submissionCriteria) {
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
      }

      // Execution revalidation checks
      checks.push({
        checkId: "cas_revision_lock",
        executed: false,
        name: "Optimistic concurrency version check",
        status: "needs_execution_revalidation",
      });
      if (grantId) {
        checks.push({
          checkId: "grant_reservation_commit",
          executed: false,
          name: "Grant budget reservation check",
          status: "needs_execution_revalidation",
        });
      }

      // Determine canonical verdict
      let verdict: "allow" | "review" | "deny" | "evidence_insufficient" =
        "allow";
      if (hasDenial) {
        verdict = "deny";
      } else if (hasReviewRequirement) {
        verdict = "review";
      } else if (failedReasons.length > 0) {
        verdict = "evidence_insufficient";
      } else if (
        action.defaultExecutionMode === "proposal" ||
        proposer.agentTier === 2 ||
        (proposer.agentTier === 3 && proposer.type === "agent")
      ) {
        verdict = "review";
      }

      // 7. Evidence closure
      const evidenceDigest = createHash("sha256")
        .update(
          JSON.stringify({
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
      const requestedEffects: RequestedEffect[] = [];
      if (action.mutation) {
        requestedEffects.push({
          description: `State mutation on ${action.targetObjectTypeId ?? "target"}`,
          effectId: `${action.id}_mutation`,
          isLiveExternal: false,
          mutationTypes: ["put"],
        });
      }
      if (action.sideEffects) {
        for (const se of action.sideEffects) {
          requestedEffects.push({
            description: se.description,
            effectId: se.id,
            isLiveExternal: true,
          });
        }
      }

      const id = `prep_${now}_${Math.random().toString(36).slice(2, 7)}`;
      const preparedWithoutDigest = {
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
        predicateDependencies,
        preparedAt: now,
        proposer,
        requestedEffects,
        reviewReasons: failedReasons.length > 0 ? failedReasons : undefined,
        tenantId,
        usageReservations: [{ amount: 1, resource: action.id }],
        verdict,
        worldView,
      };

      const canonicalDigest = computePreparedActionDigest(
        preparedWithoutDigest as any
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
      const now = Date.now();

      // 1. Lookup prepared action by preparedDigest
      const prepared = preparedActions.get(preparedDigest);
      if (!prepared) {
        return yield* Effect.fail(
          new PreparedActionNotFoundError({
            message: `Prepared action with digest '${preparedDigest}' not found`,
            preparedDigest,
          })
        );
      }

      // 2. Tenant non-disclosure check
      if (prepared.tenantId !== reviewerContext.tenantId) {
        return yield* Effect.fail(
          new TenantMismatchError({
            message: `Prepared action does not exist for tenant`,
            tenantId: reviewerContext.tenantId,
          })
        );
      }

      // 3. Exact Proposal Digest Match (S07 Invariant)
      if (preparedDigest !== viewedDigest) {
        return yield* Effect.fail(
          new ApprovalDigestMismatchError({
            message: `Viewed proposal digest '${viewedDigest}' does not match prepared digest '${preparedDigest}'`,
            preparedDigest,
            viewedDigest,
          })
        );
      }

      // 4. Stale approval check (Proposal expiration)
      if (now > prepared.expiresAt) {
        return yield* Effect.fail(
          new StaleApprovalError({
            message: `Prepared action proposal '${prepared.id}' expired at ${prepared.expiresAt}`,
            preparedDigest,
            reason: "proposal_expired",
          })
        );
      }

      // 5. Self-Approval Invariant: Proposer cannot self-approve
      if (reviewerContext.reviewer.id === prepared.proposer.id) {
        return yield* Effect.fail(
          new SelfApprovalDeniedError({
            message: `Independent review required: proposer '${prepared.proposer.id}' cannot approve own proposal`,
            proposerId: prepared.proposer.id,
            reviewerId: reviewerContext.reviewer.id,
          })
        );
      }

      // 6. Fabricated Approval Invariant: Sentinel or AI agent cannot satisfy human approval requirement
      if (
        reviewerContext.reviewer.type === "agent" &&
        reviewerContext.assurance !== "delegated_service"
      ) {
        return yield* Effect.fail(
          new FabricatedApprovalError({
            message: `Approval requires an authenticated human reviewer, but got agent '${reviewerContext.reviewer.id}'`,
            reason: "agent_cannot_approve_human_proposal",
          })
        );
      }

      // 7. Role / Authorization check
      const hasAllowedRole = reviewerContext.reviewer.roles.some((r) =>
        DEFAULT_APPROVER_ROLES.has(r.toLowerCase())
      );
      if (!hasAllowedRole) {
        return yield* Effect.fail(
          new UnauthorizedReviewerError({
            message: `Reviewer '${reviewerContext.reviewer.id}' lacks authorized approver role`,
            requiredRole: "approver",
            reviewerId: reviewerContext.reviewer.id,
          })
        );
      }

      // 8. Create ApprovalRecord
      const approvalId = `appr_${now}_${Math.random().toString(36).slice(2, 7)}`;
      const approvalWithoutHash = {
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

      const recordHash = computeApprovalRecordHash(approvalWithoutHash as any);
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
        return yield* Effect.fail(
          new PreparedActionNotFoundError({
            message: `Prepared action with digest '${preparedDigest}' not found`,
            preparedDigest,
          })
        );
      }
      if (p.tenantId !== tenantId) {
        return yield* Effect.fail(
          new TenantMismatchError({
            message: "Prepared action does not exist for tenant",
            tenantId,
          })
        );
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
        return yield* Effect.fail(
          new ApprovalRecordNotFoundError({
            approvalId,
            message: `Approval record '${approvalId}' not found`,
          })
        );
      }
      if (a.reviewerContext.tenantId !== tenantId) {
        return yield* Effect.fail(
          new TenantMismatchError({
            message: "Approval record does not exist for tenant",
            tenantId,
          })
        );
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
      if (!a) return undefined;
      if (a.reviewerContext.tenantId !== tenantId) {
        return yield* Effect.fail(
          new TenantMismatchError({
            message: "Approval record does not exist for tenant",
            tenantId,
          })
        );
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
