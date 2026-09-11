import { createHash } from "node:crypto";

import type {
  ActionEvaluationContext,
  ActionParameters,
  ActionSideEffect,
  ActionType,
  ActionTypeId,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
  RiskTier,
  SecurityContext,
  Subject,
} from "@operon/schema";
import { generatePrefixedId, serializeJson } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Clock, Effect, Exit, Schema } from "effect";

import type { AuditStore, DecisionRecord } from "./audit.js";
import {
  FreshnessBudgetExceededError,
  IdempotencyConflictError,
  ParameterValidationError,
  PermissionDeniedError,
  SideEffectExecutionError,
  StorageError,
  SubmissionCriteriaFailedError,
} from "./errors.js";
import type { ObjectStore } from "./object-store.js";

const decodeSchemaExit = Schema.decodeUnknownExit;

interface ActionTypeMetadata {
  readonly id: ActionTypeId;
  readonly minimumAgentTier: number;
  readonly mutation?: unknown;
  readonly sideEffects?: readonly unknown[];
  readonly riskTier: RiskTier;
  readonly defaultExecutionMode?: string;
  readonly requiredFreshnessProperties?: readonly {
    readonly objectTypeId: ObjectTypeId;
    readonly propertyName: string;
    readonly maxStalenessMs: number;
  }[];
}

export interface ApprovalToken {
  readonly proposalId: string;
  readonly approver: Subject;
  readonly evidenceHash: string;
  readonly approvedAt: number;
}

export interface StandardActionSubmission<Params = ActionParameters> {
  readonly kind?: "standard";
  readonly actionType: ActionType<Params>;
  readonly rawParameters: unknown;
  readonly security: SecurityContext;
  readonly ruleVersion?: string;
  readonly isApprovedProposal?: false;
  readonly approvalToken?: never;
  readonly idempotencyKey?: string;
  readonly stagedLogic?: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<readonly ObjectInstance[], unknown>;
}

export interface ApprovedProposalSubmission<Params = ActionParameters> {
  readonly kind?: "approved_proposal";
  readonly actionType: ActionType<Params>;
  readonly rawParameters: unknown;
  readonly security: SecurityContext;
  readonly ruleVersion?: string;
  readonly isApprovedProposal: true;
  readonly approvalToken: ApprovalToken;
  readonly idempotencyKey?: string;
  readonly stagedLogic?: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<readonly ObjectInstance[], unknown>;
}

export type ActionSubmission<Params = ActionParameters> =
  | StandardActionSubmission<Params>
  | ApprovedProposalSubmission<Params>;

export type ActionExecutionResult =
  | {
      readonly status: "executed";
      readonly decisionRecord: DecisionRecord;
      readonly updatedObjects: readonly ObjectInstance[];
    }
  | {
      readonly status: "proposed";
      readonly proposalId: string;
      readonly decisionRecord: DecisionRecord;
    };

interface IdempotencyRecord {
  readonly actionTypeId: string;
  readonly paramsHash: string;
  readonly result: ActionExecutionResult;
}

const idempotencyRegistry = new Map<string, IdempotencyRecord>();

export function clearIdempotencyRegistry(): void {
  idempotencyRegistry.clear();
}

function validateActionPermissions(
  actionType: ActionTypeMetadata,
  security: SecurityContext
): Effect.Effect<void, PermissionDeniedError> {
  if (security.subject.type !== "agent") {
    return Effect.void;
  }
  const agentTier = security.subject.agentTier ?? 1;
  if (agentTier < actionType.minimumAgentTier) {
    return new PermissionDeniedError({
      actionTypeId: actionType.id,
      reason: `Agent tier ${agentTier} is below required minimum tier ${actionType.minimumAgentTier} for action ${actionType.id}`,
      subjectId: security.subject.id,
    });
  }
  if (
    agentTier === 1 &&
    (actionType.mutation !== undefined ||
      (actionType.sideEffects && actionType.sideEffects.length > 0))
  ) {
    return new PermissionDeniedError({
      actionTypeId: actionType.id,
      reason:
        "Tier 1 (Observe) agents cannot execute mutating actions or side-effects",
      subjectId: security.subject.id,
    });
  }
  return Effect.void;
}

const checkFreshnessBudgets = Effect.fn("checkFreshnessBudgets")(function* (
  actionType: ActionTypeMetadata,
  params: Record<string, unknown>,
  objectStore: ObjectStore,
  now: number
): Effect.fn.Return<void, FreshnessBudgetExceededError> {
  if (!actionType.requiredFreshnessProperties) {
    return;
  }
  yield* Effect.forEach(
    actionType.requiredFreshnessProperties,
    Effect.fn("WritePipeline.checkFreshness")(function* (req) {
      const targetId = params.targetId as string | undefined;
      if (!targetId) {
        return yield* new FreshnessBudgetExceededError({
          currentAgeMs: 0,
          maxAllowedStalenessMs: req.maxStalenessMs,
          objectId: "unresolved",
          propertyName: req.propertyName,
        });
      }

      const obj = yield* objectStore.getObject(req.objectTypeId, targetId);
      if (!obj) {
        return yield* new FreshnessBudgetExceededError({
          currentAgeMs: 0,
          maxAllowedStalenessMs: req.maxStalenessMs,
          objectId: targetId,
          propertyName: req.propertyName,
        });
      }

      const propVal = (obj.properties as Record<string, unknown>)[
        req.propertyName
      ];
      if (
        !(req.propertyName in (obj.properties as Record<string, unknown>)) ||
        propVal === undefined ||
        propVal === null
      ) {
        return yield* new FreshnessBudgetExceededError({
          currentAgeMs: 0,
          maxAllowedStalenessMs: req.maxStalenessMs,
          objectId: targetId,
          propertyName: req.propertyName,
        });
      }

      const propTimestamps = obj.provenance?.propertyTimestamps;
      const recordedAt =
        propTimestamps?.[req.propertyName] ??
        obj.provenance?.recordedAt ??
        obj.lastModifiedAt;
      const ageMs = now - recordedAt;
      if (ageMs > req.maxStalenessMs) {
        return yield* new FreshnessBudgetExceededError({
          currentAgeMs: ageMs,
          maxAllowedStalenessMs: req.maxStalenessMs,
          objectId: targetId,
          propertyName: req.propertyName,
        });
      }
    }),
    { concurrency: 1 }
  );
});

export interface SubmissionCriteriaResult {
  readonly guardResults: readonly {
    readonly criterionId: string;
    readonly description: string;
    readonly passed: boolean;
    readonly verdict?: string;
    readonly failureReason?: string;
  }[];
  readonly needsHumanReview: boolean;
  readonly reviewReason?: string;
}

const evaluateSubmissionCriteria = Effect.fn("evaluateSubmissionCriteria")(
  function* <Params = ActionParameters>(
    actionType: ActionType<Params>,
    params: Params,
    evalContext: ActionEvaluationContext
  ): Effect.fn.Return<
    SubmissionCriteriaResult,
    SubmissionCriteriaFailedError
  > {
    if (!actionType.submissionCriteria) {
      return { guardResults: [], needsHumanReview: false };
    }
    let needsHumanReview = false;
    let reviewReason: string | undefined;
    const guardResults: {
      criterionId: string;
      description: string;
      passed: boolean;
      verdict?: string;
      failureReason?: string;
    }[] = [];

    yield* Effect.forEach(
      actionType.submissionCriteria,
      Effect.fn("WritePipeline.evaluateCriterion")(function* (criterion) {
        const result = yield* criterion.evaluate(params, evalContext);
        guardResults.push({
          criterionId: criterion.id,
          description: criterion.description,
          failureReason: result.failureReason,
          passed: result.passed,
          verdict: result.verdict,
        });

        if (!result.passed) {
          if (result.verdict === "deny") {
            return yield* new SubmissionCriteriaFailedError({
              actionTypeId: actionType.id,
              criterionId: criterion.id,
              reason: result.failureReason ?? "Criterion validation denied",
              verdict: "deny",
            });
          }
          needsHumanReview = true;
          reviewReason = result.failureReason ?? criterion.description;
        }
      }),
      { concurrency: 1 }
    );

    return { guardResults, needsHumanReview, reviewReason };
  }
);

const applyStagedEdits = Effect.fn("applyStagedEdits")(function* (
  stagedEdits: readonly ObjectInstance[],
  objectStore: ObjectStore,
  now: number,
  actionType: { readonly id: ActionTypeId }
): Effect.fn.Return<readonly ObjectInstance[], SubmissionCriteriaFailedError> {
  const updatedObjects: ObjectInstance[] = [];
  if (stagedEdits.length === 0) {
    return updatedObjects;
  }
  if (objectStore.commitAtomicTransaction) {
    yield* objectStore
      .commitAtomicTransaction({
        mutations: stagedEdits.map((edit) => ({
          instance: edit,
          type: "put",
        })),
      })
      .pipe(
        Effect.mapError(
          (err) =>
            new SubmissionCriteriaFailedError({
              actionTypeId: actionType.id,
              criterionId: "optimistic_concurrency",
              reason: `Funnel merge conflict: object ${err.objectId} expected version ${err.expectedVersion} but store has version ${err.actualVersion}`,
              verdict: "deny",
            })
        )
      );
    for (const edit of stagedEdits) {
      updatedObjects.push({
        ...edit,
        lastModifiedAt: now,
      });
    }
  } else {
    yield* Effect.forEach(
      stagedEdits,
      Effect.fn("WritePipeline.applyStagedEdit")(function* (edit) {
        const updated = yield* objectStore.putObject(edit).pipe(
          Effect.mapError(
            (err) =>
              new SubmissionCriteriaFailedError({
                actionTypeId: actionType.id,
                criterionId: "optimistic_concurrency",
                reason: `Funnel merge conflict: object ${err.objectId} expected version ${err.expectedVersion} but store has version ${err.actualVersion}`,
                verdict: "deny",
              })
          )
        );
        updatedObjects.push(updated);
      }),
      { concurrency: 1 }
    );
  }
  return updatedObjects;
});

const rollbackStagedEdits = Effect.fn("rollbackStagedEdits")(function* (
  stagedEdits: readonly ObjectInstance[],
  originalSnapshots: Map<string, ObjectInstance | undefined>,
  objectStore: ObjectStore
): Effect.fn.Return<void> {
  yield* Effect.forEach(
    stagedEdits,
    Effect.fn("WritePipeline.revertStagedEdit")(function* (edit) {
      const original = originalSnapshots.get(`${edit.typeId}:${edit.id}`);
      if (objectStore.revertObject) {
        yield* objectStore.revertObject(edit.typeId, edit.id, original);
      } else if (original) {
        yield* objectStore.putObject(original).pipe(Effect.ignore);
      } else {
        yield* objectStore
          .deleteObject(edit.typeId, edit.id)
          .pipe(Effect.ignore);
      }
    }),
    { concurrency: 1 }
  );
});

const compensateExecutedSideEffects = Effect.fn(
  "compensateExecutedSideEffects"
)(function* <Params = ActionParameters>(
  reversed: readonly ActionSideEffect<Params>[],
  params: Params,
  evalContext: ActionEvaluationContext
): Effect.fn.Return<boolean> {
  let compensationSucceeded = true;
  yield* Effect.forEach(
    reversed,
    Effect.fn("WritePipeline.compensateSideEffect")(function* (compSe) {
      if (compSe.compensate) {
        const compRes = yield* Effect.exit(
          compSe.compensate(params, evalContext)
        );
        if (Exit.isFailure(compRes)) {
          compensationSucceeded = false;
        }
      }
    }),
    { concurrency: 1 }
  );
  return compensationSucceeded;
});

interface ExecuteSideEffectsOptions<Params = unknown> {
  readonly sideEffects: readonly ActionSideEffect<Params>[];
  readonly params: Params;
  readonly evalContext: ActionEvaluationContext;
  readonly actionType: { readonly id: ActionTypeId };
  readonly security: SecurityContext;
  readonly ruleVersion: string;
  readonly snapshot: Record<string, unknown>;
  readonly auditStore: AuditStore;
}

const executeSideEffectsWithCompensation = Effect.fn(
  "executeSideEffectsWithCompensation"
)(function* <Params = ActionParameters>(
  options: ExecuteSideEffectsOptions<Params>
): Effect.fn.Return<void, SideEffectExecutionError | StorageError> {
  const {
    sideEffects,
    params,
    evalContext,
    actionType,
    security,
    ruleVersion,
    snapshot,
    auditStore,
  } = options;
  const executedSideEffects: ActionSideEffect<Params>[] = [];
  yield* Effect.forEach(
    sideEffects,
    Effect.fn("WritePipeline.executeSideEffect")(function* (se) {
      const sideEffectResult = yield* Effect.exit(
        se.execute(params, evalContext)
      );
      if (Exit.isFailure(sideEffectResult)) {
        const compensationSucceeded = yield* compensateExecutedSideEffects(
          executedSideEffects.toReversed(),
          params,
          evalContext
        );
        const failureReason = String(sideEffectResult.cause);
        const nowMs = yield* Clock.currentTimeMillis;
        yield* auditStore.appendDecision({
          actionTypeId: actionType.id,
          compensation: compensationSucceeded
            ? {
                compensatedAt: nowMs,
                error: failureReason,
              }
            : undefined,
          correlationId: security.correlationId,
          id: generatePrefixedId("compensation", nowMs),
          outcome: compensationSucceeded ? "compensated" : "rejected",
          parameters: params as Record<string, unknown>,
          reason: `Side effect '${se.id}' failed: ${failureReason}${compensationSucceeded ? "" : " (compensation failed)"}`,
          ruleVersion,
            stateSnapshot: snapshot,
            subject: security.subject,
            timestamp: nowMs,
            verdict: "deny",
          });
          return yield* new SideEffectExecutionError({
            cause: sideEffectResult.cause,
            sideEffectId: se.id,
          });
        }
        executedSideEffects.push(se);
      }),
    { concurrency: 1 }
  );
});

const executeStagedLogicOrMutation = Effect.fn("executeStagedLogicOrMutation")(
  function* <Params = ActionParameters>(
    submission: ActionSubmission<Params>,
    actionType: ActionType<Params>,
    params: Params,
    evalContext: ActionEvaluationContext
  ): Effect.fn.Return<readonly ObjectInstance[], SubmissionCriteriaFailedError> {
    if (submission.stagedLogic) {
      return yield* submission.stagedLogic(params, evalContext).pipe(
        Effect.mapError(
          (err) =>
            new SubmissionCriteriaFailedError({
              actionTypeId: actionType.id,
              criterionId: "staged_logic_execution",
              reason: `Staged logic execution failed: ${
                err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err)
              }`,
              verdict: "deny",
            })
        )
      );
    }
    if (actionType.mutation) {
      return yield* actionType.mutation(params, evalContext).pipe(
        Effect.mapError(
          (err) =>
            new SubmissionCriteriaFailedError({
              actionTypeId: actionType.id,
              criterionId: "mutation_execution",
              reason: `Action mutation failed: ${
                err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err)
              }`,
              verdict: "deny",
            })
        )
      );
    }
    return [];
  }
);

function checkIfProposalMode(
  security: SecurityContext,
  submission: {
    readonly isApprovedProposal?: boolean;
    readonly approvalToken?: ApprovalToken;
  },
  actionType: ActionTypeMetadata,
  needsHumanReview: boolean
): boolean {
  const isHuman = security.subject.type !== "agent";
  const hasValidApprovalToken =
    Boolean(submission.approvalToken) &&
    submission.approvalToken?.approver.type !== "agent" &&
    submission.approvalToken?.approver.id !== security.subject.id;

  const isHumanDirect =
    isHuman &&
    (submission.isApprovedProposal ||
      hasValidApprovalToken ||
      security.subject.roles.includes("admin") ||
      security.subject.roles.includes("chief_engineer") ||
      security.subject.roles.includes("physician"));

  const tierRequiresApproval =
    security.subject.agentTier === 2 ||
    (security.subject.agentTier === 3 &&
      !hasValidApprovalToken &&
      !submission.isApprovedProposal);

  return (
    !submission.isApprovedProposal &&
    !hasValidApprovalToken &&
    (needsHumanReview ||
      (actionType.defaultExecutionMode === "proposal" && !isHumanDirect) ||
      tierRequiresApproval)
  );
}

interface ProposalModeOptions {
  readonly actionType: {
    readonly id: ActionTypeId;
    readonly riskTier: RiskTier;
  };
  readonly security: SecurityContext;
  readonly params: Record<string, unknown>;
  readonly reviewReason?: string;
  readonly ruleVersion: string;
  readonly snapshot: Record<string, unknown>;
  readonly now: number;
  readonly needsHumanReview: boolean;
  readonly auditStore: AuditStore;
  readonly telemetry: OperonTelemetryService;
  readonly idempotencyKey?: string;
  readonly paramsHash: string;
}

const handleProposalMode = Effect.fn("handleProposalMode")(function* (
  options: ProposalModeOptions
): Effect.fn.Return<ActionExecutionResult, StorageError> {
  const {
    actionType,
    security,
    params,
    reviewReason,
    ruleVersion,
    snapshot,
    now,
    needsHumanReview,
    auditStore,
    telemetry,
    idempotencyKey,
    paramsHash,
  } = options;

  const proposalRecord = yield* auditStore.appendDecision({
    actionTypeId: actionType.id,
    correlationId: security.correlationId,
    id: generatePrefixedId("proposal"),
    outcome: "proposed",
    parameters: params,
    reason: reviewReason,
    ruleVersion,
    stateSnapshot: snapshot,
    subject: security.subject,
    timestamp: now,
    verdict: needsHumanReview ? "review" : "allow",
  });

  telemetry.trackEvent({
    event: "operon_action_submitted",
    properties: {
      actionId: actionType.id,
      agentTier: security.subject.agentTier,
      correlationId: security.correlationId,
      executionMode: "proposal",
      riskTier: actionType.riskTier,
      subjectId: security.subject.id,
      subjectType: security.subject.type,
    },
    subject: security.subject,
  });

  telemetry.trackEvent({
    event: "operon_proposal_created",
    properties: {
      actionId: actionType.id,
      evidenceHash: proposalRecord.recordHash,
      proposalId: proposalRecord.id,
      proposerId: security.subject.id,
      reason: reviewReason,
    },
    subject: security.subject,
  });

  const proposalResult: ActionExecutionResult = {
    decisionRecord: proposalRecord,
    proposalId: proposalRecord.id,
    status: "proposed" as const,
  };

  if (idempotencyKey) {
    idempotencyRegistry.set(idempotencyKey, {
      actionTypeId: actionType.id,
      paramsHash,
      result: proposalResult,
    });
  }

  return proposalResult;
});

/**
 * The 7-Step Governed Write Pipeline (Chapter 3 & 9)
 */
export function executeWritePipeline<Params = ActionParameters>(
  submission: ActionSubmission<Params>,
  objectStore: ObjectStore,
  auditStore: AuditStore
): Effect.Effect<
  ActionExecutionResult,
  | ParameterValidationError
  | PermissionDeniedError
  | SubmissionCriteriaFailedError
  | FreshnessBudgetExceededError
  | SideEffectExecutionError
  | StorageError
  | IdempotencyConflictError
> {
  const telemetry = OperonTelemetryService.getInstance();

  const pipelineEffect: Effect.Effect<
    ActionExecutionResult,
    | ParameterValidationError
    | PermissionDeniedError
    | SubmissionCriteriaFailedError
    | FreshnessBudgetExceededError
    | SideEffectExecutionError
    | StorageError
    | IdempotencyConflictError,
    never
  > = Effect.gen(function* () {
      const {
        actionType,
        rawParameters,
        security,
        ruleVersion = "1.0.0",
        idempotencyKey,
      } = submission;
      const now = security.timestamp;
      const startTime = yield* Clock.currentTimeMillis;

      const paramsHash = createHash("sha256")
        .update(serializeJson(rawParameters))
        .digest("hex");

      if (idempotencyKey) {
        const existing = idempotencyRegistry.get(idempotencyKey);
        if (existing) {
          if (
            existing.actionTypeId !== actionType.id ||
            existing.paramsHash !== paramsHash
          ) {
            return yield* new IdempotencyConflictError({
              idempotencyKey,
              message: `Idempotency key '${idempotencyKey}' was already submitted with different parameters or action type`,
            });
          }
          return existing.result;
        }
      }

      // STEP 1: Validate Parameters
      const decodeExit = decodeSchemaExit(
        actionType.parametersSchema as Schema.Decoder<Params>
      )(rawParameters);
      if (Exit.isFailure(decodeExit)) {
        return yield* new ParameterValidationError({
          actionTypeId: actionType.id,
          details: decodeExit.cause,
          message: `Parameter validation failed: ${String(decodeExit.cause)}`,
        });
      }
      const params = decodeExit.value;
      telemetry.addBreadcrumb(
        "pipeline.step1",
        `Parameters validated for action '${actionType.id}'`
      );

      // STEP 2: Verify Permissions and Agent Authorization Ladder (4 Tiers)
      yield* validateActionPermissions(actionType, security);

      const evalContext: ActionEvaluationContext = {
        getObject: (typeId: ObjectTypeId, id: string) =>
          objectStore.getObject(typeId, id),
        now,
        security,
      };

      // STEP 3: Evaluate Submission Criteria & Freshness Budgets (Fail-Closed)
      yield* checkFreshnessBudgets(
        actionType,
        params as Record<string, unknown>,
        objectStore,
        now
      );

      const { guardResults, needsHumanReview, reviewReason } =
        yield* evaluateSubmissionCriteria(actionType, params, evalContext);

      const isProposal = checkIfProposalMode(
        security,
        submission,
        actionType,
        needsHumanReview
      );

      const snapshot: Record<string, unknown> = {
        agentTier: security.subject.agentTier,
        evaluatedParams: params as Record<string, unknown>,
        guardResults,
        riskTier: actionType.riskTier,
        ruleVersion,
        timestamp: now,
      };

      if (isProposal) {
        return yield* handleProposalMode({
          actionType,
          auditStore,
          idempotencyKey,
          needsHumanReview,
          now,
          params: params as Record<string, unknown>,
          paramsHash,
          reviewReason,
          ruleVersion,
          security,
          snapshot,
          telemetry,
        });
      }

      // STEP 4: Execute Staged Logic or Action Mutation Handler
      const stagedEdits = yield* executeStagedLogicOrMutation(
        submission,
        actionType,
        params,
        evalContext
      );

      // STEP 5: Apply Edits & Funnel Merge (Atomic Transaction)
      const originalSnapshots = new Map<string, ObjectInstance | undefined>();
      yield* Effect.forEach(
        stagedEdits,
        Effect.fn("WritePipeline.captureOriginalSnapshot")(function* (edit) {
          const existing = yield* objectStore.getObject(edit.typeId, edit.id);
          originalSnapshots.set(
            `${edit.typeId}:${edit.id}`,
            existing ? structuredClone(existing) : undefined
          );
        }),
        { concurrency: 1 }
      );

      const updatedObjects = yield* applyStagedEdits(
        stagedEdits,
        objectStore,
        now,
        actionType
      );

      // STEP 6: Persist DecisionRecord (Atomic with Rollback on Audit Failure)
      const decisionRecord = yield* auditStore
        .appendDecision({
          actionTypeId: actionType.id,
          correlationId: security.correlationId,
          id: generatePrefixedId("decision"),
          outcome: "executed",
          parameters: params as Record<string, unknown>,
          ruleVersion,
          stateSnapshot: snapshot,
          subject: security.subject,
          timestamp: now,
          verdict: "allow",
        })
        .pipe(
          Effect.catch((error) =>
            rollbackStagedEdits(
              stagedEdits,
              originalSnapshots,
              objectStore
            ).pipe(
              Effect.andThen(
                Effect.fail(
                  new StorageError({
                    cause: error,
                    message: `Audit append failed: ${error.message}`,
                  })
                )
              )
            )
          )
        );

      // Materialize standard 1-to-1 ActionLog object
      const targetObj = updatedObjects[0];
      const actionLogInstance: ObjectInstance = {
        id: `log_${decisionRecord.id}`,
        lastModifiedAt: now,
        properties: {
          actionTypeId: actionType.id,
          callerId: security.subject.id,
          decisionRecordId: decisionRecord.id,
          executionId: decisionRecord.id,
          // SAFETY: Action execution parameters conform to ActionParameters
          parameters: (params ?? {}) as ActionParameters,
          recordHash: decisionRecord.recordHash,
          status: "executed",
          targetObjectId: targetObj?.id ?? null,
          targetObjectTypeId: targetObj?.typeId ?? null,
        },
        typeId: "ActionLog" as ObjectTypeId,
        version: 1,
      };
      yield* objectStore.putObject(actionLogInstance).pipe(Effect.ignore);
      if (targetObj) {
        yield* objectStore
          .linkObjects({
            createdAt: now,
            linkTypeId: "ActionLogTarget" as LinkTypeId,
            sourceId: actionLogInstance.id,
            targetId: targetObj.id,
          })
          .pipe(Effect.ignore);
      }

      // STEP 7: Side Effects and Saga Compensation
      const sideEffectsList: readonly ActionSideEffect<Params>[] =
        actionType.sideEffects ?? [];
      if (sideEffectsList.length > 0) {
        yield* executeSideEffectsWithCompensation({
          actionType,
          auditStore,
          evalContext,
          params,
          ruleVersion,
          security,
          sideEffects: sideEffectsList,
          snapshot,
        });
      }

      const finishTime = yield* Clock.currentTimeMillis;

      telemetry.trackEvent({
        event: "operon_action_submitted",
        properties: {
          actionId: actionType.id,
          agentTier: security.subject.agentTier,
          correlationId: security.correlationId,
          executionMode: "automated",
          riskTier: actionType.riskTier,
          subjectId: security.subject.id,
          subjectType: security.subject.type,
        },
        subject: security.subject,
      });

      telemetry.trackEvent({
        event: "operon_action_executed",
        properties: {
          actionId: actionType.id,
          decisionRecordId: decisionRecord.id,
          durationMs: finishTime - startTime,
          recordHash: decisionRecord.recordHash,
          subjectId: security.subject.id,
          updatedObjectsCount: updatedObjects.length,
        },
        subject: security.subject,
      });

      const executedResult: ActionExecutionResult = {
        decisionRecord,
        status: "executed" as const,
        updatedObjects,
      };

      const finalKey: string = idempotencyKey ?? "";
      if (finalKey !== "") {
        idempotencyRegistry.set(finalKey, {
          actionTypeId: actionType.id,
          paramsHash,
          result: executedResult,
        });
      }

      return executedResult;
    });

  return telemetry.withSpan(
    "operon.pipeline.execute",
    {
      actionId: submission.actionType.id,
      agentTier: submission.security.subject.agentTier ?? null,
      correlationId: submission.security.correlationId,
      riskTier: submission.actionType.riskTier,
      subjectId: submission.security.subject.id,
      subjectType: submission.security.subject.type,
    },
    pipelineEffect
  );
}
