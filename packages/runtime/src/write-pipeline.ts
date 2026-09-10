import type {
  ActionEvaluationContext,
  ActionType,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
  SecurityContext,
  Subject,
} from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Effect, Schema } from "effect";

import type { AuditStore, DecisionRecord } from "./audit.js";
import {
  FreshnessBudgetExceededError,
  ParameterValidationError,
  PermissionDeniedError,
  SideEffectExecutionError,
  StorageError,
  SubmissionCriteriaFailedError,
} from "./errors.js";
import type { ObjectStore } from "./object-store.js";

export interface ApprovalToken {
  readonly proposalId: string;
  readonly approver: Subject;
  readonly evidenceHash: string;
  readonly approvedAt: number;
}

export interface ActionSubmission<Params = unknown> {
  readonly actionType: ActionType<Params>;
  readonly rawParameters: unknown;
  readonly security: SecurityContext;
  readonly ruleVersion?: string;
  readonly isApprovedProposal?: boolean;
  readonly approvalToken?: ApprovalToken;
  readonly stagedLogic?: (
    params: Params,
    context: ActionEvaluationContext
  ) => Effect.Effect<readonly ObjectInstance[], unknown>;
}

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

/**
 * The 7-Step Governed Write Pipeline (Chapter 3 & 9)
 */
export function executeWritePipeline<Params = any>(
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
> {
  const telemetry = OperonTelemetryService.getInstance();
  const startTime = Date.now();

  return telemetry.withSpan(
    "operon.pipeline.execute",
    {
      actionId: submission.actionType.id,
      agentTier: submission.security.subject.agentTier,
      correlationId: submission.security.correlationId,
      riskTier: submission.actionType.riskTier,
      subjectId: submission.security.subject.id,
      subjectType: submission.security.subject.type,
    },
    Effect.gen(function* () {
      const {
        actionType,
        rawParameters,
        security,
        ruleVersion = "1.0.0",
      } = submission;
      const now = security.timestamp;

      // STEP 1: Validate Parameters
      const params = yield* Schema.decodeUnknownEffect(
        actionType.parametersSchema as Schema.Decoder<Params>
      )(rawParameters).pipe(
        Effect.mapError(
          (err) =>
            new ParameterValidationError({
              actionTypeId: actionType.id,
              details: err,
              message: `Parameter validation failed: ${String((err as any)?.message ?? err)}`,
            })
        )
      );
      telemetry.addBreadcrumb(
        "pipeline.step1",
        `Parameters validated for action '${actionType.id}'`
      );

      // STEP 2: Verify Permissions and Agent Authorization Ladder (4 Tiers)
      if (security.subject.type === "agent") {
        const agentTier = security.subject.agentTier ?? 1;
        if (agentTier < actionType.minimumAgentTier) {
          return yield* Effect.fail(
            new PermissionDeniedError({
              actionTypeId: actionType.id,
              reason: `Agent tier ${agentTier} is below required minimum tier ${actionType.minimumAgentTier} for action ${actionType.id}`,
              subjectId: security.subject.id,
            })
          );
        }

        // Tier 1 is Observe only: cannot execute actions with side effects or mutations
        if (
          agentTier === 1 &&
          (actionType.mutation !== undefined ||
            (actionType.sideEffects && actionType.sideEffects.length > 0))
        ) {
          return yield* Effect.fail(
            new PermissionDeniedError({
              actionTypeId: actionType.id,
              reason:
                "Tier 1 (Observe) agents cannot execute mutating actions or side-effects",
              subjectId: security.subject.id,
            })
          );
        }
      }

      const evalContext: ActionEvaluationContext = {
        getObject: (typeId: ObjectTypeId, id: string) =>
          objectStore.getObject(typeId, id),
        now,
        security,
      };

      // STEP 3: Evaluate Submission Criteria & Freshness Budgets (Fail-Closed)
      // 3a. Check required freshness properties
      if (actionType.requiredFreshnessProperties) {
        for (const req of actionType.requiredFreshnessProperties) {
          const pRecord = params as Record<string, unknown>;
          const typeKey = `${req.objectTypeId.toLowerCase()}Id`;
          const targetId =
            (pRecord.targetId as string | undefined) ??
            (pRecord[typeKey] as string | undefined) ??
            (pRecord.patientId as string | undefined) ??
            (pRecord.id as string | undefined) ??
            (pRecord.targetObjectId as string | undefined);

          if (!targetId) {
            return yield* Effect.fail(
              new FreshnessBudgetExceededError({
                currentAgeMs: 0,
                maxAllowedStalenessMs: req.maxStalenessMs,
                objectId: "unresolved",
                propertyName: req.propertyName,
              })
            );
          }

          const obj = yield* objectStore.getObject(req.objectTypeId, targetId);
          if (!obj) {
            return yield* Effect.fail(
              new FreshnessBudgetExceededError({
                currentAgeMs: 0,
                maxAllowedStalenessMs: req.maxStalenessMs,
                objectId: targetId,
                propertyName: req.propertyName,
              })
            );
          }

          const propVal = (obj.properties as Record<string, unknown>)[
            req.propertyName
          ];
          if (
            !(
              req.propertyName in (obj.properties as Record<string, unknown>)
            ) ||
            propVal === undefined ||
            propVal === null
          ) {
            return yield* Effect.fail(
              new FreshnessBudgetExceededError({
                currentAgeMs: 0,
                maxAllowedStalenessMs: req.maxStalenessMs,
                objectId: targetId,
                propertyName: req.propertyName,
              })
            );
          }

          const propTimestamps = (obj.provenance as any)?.propertyTimestamps as
            | Record<string, number>
            | undefined;
          const recordedAt =
            propTimestamps?.[req.propertyName] ??
            obj.provenance?.recordedAt ??
            obj.lastModifiedAt;
          const ageMs = now - recordedAt;
          if (ageMs > req.maxStalenessMs) {
            return yield* Effect.fail(
              new FreshnessBudgetExceededError({
                currentAgeMs: ageMs,
                maxAllowedStalenessMs: req.maxStalenessMs,
                objectId: targetId,
                propertyName: req.propertyName,
              })
            );
          }
        }
      }

      // 3b. Evaluate each Submission Criterion guard & collect decision dossier
      let needsHumanReview = false;
      let reviewReason: string | undefined;
      const guardResults: {
        criterionId: string;
        description: string;
        passed: boolean;
        verdict?: string;
        failureReason?: string;
      }[] = [];

      for (const criterion of actionType.submissionCriteria) {
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
            return yield* Effect.fail(
              new SubmissionCriteriaFailedError({
                actionTypeId: actionType.id,
                criterionId: criterion.id,
                reason: result.failureReason ?? "Criterion validation denied",
                verdict: "deny",
              })
            );
          }
          // Verdict is "review": degrade to human approval
          needsHumanReview = true;
          reviewReason = result.failureReason ?? criterion.description;
        }
      }

      // Check if routed to proposal mode
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

      const isProposal =
        !submission.isApprovedProposal &&
        !hasValidApprovalToken &&
        (needsHumanReview ||
          (actionType.defaultExecutionMode === "proposal" && !isHumanDirect) ||
          tierRequiresApproval);

      const snapshot: Record<string, unknown> = {
        agentTier: security.subject.agentTier,
        evaluatedParams: params as Record<string, unknown>,
        guardResults,
        riskTier: actionType.riskTier,
        ruleVersion,
        timestamp: now,
      };

      if (isProposal) {
        // Record as proposal in audit
        const proposalRecord = yield* Effect.promise(() =>
          auditStore.appendDecision({
            actionTypeId: actionType.id,
            correlationId: security.correlationId,
            id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            outcome: "proposed",
            parameters: params as Record<string, unknown>,
            reason: reviewReason,
            ruleVersion,
            stateSnapshot: snapshot,
            subject: security.subject,
            timestamp: now,
            verdict: needsHumanReview ? "review" : "allow",
          })
        );

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

        return {
          decisionRecord: proposalRecord,
          proposalId: proposalRecord.id,
          status: "proposed" as const,
        };
      }

      // STEP 4: Execute Staged Logic or Action Mutation Handler
      const stagedEdits: readonly ObjectInstance[] = submission.stagedLogic
        ? yield* submission.stagedLogic(params, evalContext).pipe(
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
          )
        : actionType.mutation
          ? yield* actionType.mutation(params, evalContext).pipe(
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
            )
          : [];

      // STEP 5: Apply Edits & Funnel Merge (Atomic Transaction)
      // Snapshot original objects before applying edits for atomic rollback on audit failure
      const originalSnapshots = new Map<string, ObjectInstance | undefined>();
      for (const edit of stagedEdits) {
        const existing = yield* objectStore.getObject(edit.typeId, edit.id);
        originalSnapshots.set(
          `${edit.typeId}:${edit.id}`,
          existing ? structuredClone(existing) : undefined
        );
      }

      const updatedObjects: ObjectInstance[] = [];
      if (stagedEdits.length > 0) {
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
          for (const edit of stagedEdits) {
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
          }
        }
      }

      const rollbackEdits = () =>
        Effect.gen(function* () {
          for (const edit of stagedEdits) {
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
          }
        });

      // STEP 6: Persist DecisionRecord (Atomic with Rollback on Audit Failure)
      const maybeDecision = yield* Effect.promise(async () => {
        try {
          const record = await auditStore.appendDecision({
            actionTypeId: actionType.id,
            correlationId: security.correlationId,
            id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            outcome: "executed",
            parameters: params as Record<string, unknown>,
            ruleVersion,
            stateSnapshot: snapshot,
            subject: security.subject,
            timestamp: now,
            verdict: "allow",
          });
          return { ok: true as const, record };
        } catch (error) {
          return { error, ok: false as const };
        }
      });

      if (!maybeDecision.ok) {
        yield* rollbackEdits();
        return yield* Effect.fail(
          new StorageError({
            message: `Audit append failed: ${String((maybeDecision.error as any)?.message ?? maybeDecision.error)}`,
            cause: maybeDecision.error,
          })
        );
      }
      const decisionRecord = maybeDecision.record;

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
          parameters: params as Record<string, unknown>,
          recordHash: decisionRecord.recordHash,
          status: "executed",
          targetObjectId: targetObj?.id,
          targetObjectTypeId: targetObj?.typeId,
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
      if (actionType.sideEffects && actionType.sideEffects.length > 0) {
        const executedSideEffects: (typeof actionType.sideEffects)[number][] =
          [];

        for (const se of actionType.sideEffects) {
          const sideEffectResult = yield* se
            .execute(params, evalContext)
            .pipe(Effect.result);

          if (sideEffectResult._tag === "Failure") {
            // Compensate all previously executed side effects in reverse order
            let compensationSucceeded = true;
            const reversed = executedSideEffects.toReversed();
            for (const compSe of reversed) {
              if (compSe.compensate) {
                const compRes = yield* compSe
                  .compensate(params, evalContext)
                  .pipe(Effect.result);
                if (compRes._tag === "Failure") {
                  compensationSucceeded = false;
                }
              }
            }

            const failureReason = String(
              (sideEffectResult.failure as any)?.message ??
                sideEffectResult.failure
            );

            // Record compensation in audit
            yield* Effect.promise(() =>
              auditStore.appendDecision({
                actionTypeId: actionType.id,
                compensation: compensationSucceeded
                  ? {
                      compensatedAt: Date.now(),
                      error: failureReason,
                    }
                  : undefined,
                correlationId: security.correlationId,
                id: `compensation_${Date.now()}`,
                outcome: compensationSucceeded ? "compensated" : "rejected",
                parameters: params as Record<string, unknown>,
                reason: `Side effect '${se.id}' failed: ${failureReason}${compensationSucceeded ? "" : " (compensation failed)"}`,
                ruleVersion,
                stateSnapshot: snapshot,
                subject: security.subject,
                timestamp: Date.now(),
                verdict: "deny",
              })
            );

            return yield* Effect.fail(
              new SideEffectExecutionError({
                cause: sideEffectResult.failure,
                sideEffectId: se.id,
              })
            );
          }

          executedSideEffects.push(se);
        }
      }

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
          durationMs: Date.now() - startTime,
          recordHash: decisionRecord.recordHash,
          subjectId: security.subject.id,
          updatedObjectsCount: updatedObjects.length,
        },
        subject: security.subject,
      });

      return {
        decisionRecord,
        status: "executed" as const,
        updatedObjects,
      };
    })
  );
}
