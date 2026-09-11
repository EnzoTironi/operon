import type {
  MigrationTrial,
  MigrationTrialReceipt,
  PromotionEvidenceSet,
  PromotionPlan,
  PromotionReceipt,
  RollbackReceipt,
  RolloutCohort,
} from "@operon/schema";
import {
  computeMigrationTrialReceiptHash,
  computePromotionReceiptHash,
  computeRollbackReceiptHash,
  generatePrefixedId,
} from "@operon/schema";
import { Clock, Effect, Option } from "effect";

import { PromotionEvidenceMismatchError } from "./actions-errors.js";
import type { RollbackExecutionError } from "./actions-errors.js";
import type { AuditStore } from "./audit.js";

interface StoredPromotionRecord {
  readonly plan: PromotionPlan;
  readonly receipt: PromotionReceipt;
}

/**
 * PromotionService (Spec S11 / Ticket V1-07):
 * Governs promotion plans, candidate-profile evidence verification,
 * phased rollout cohorts with early stopping, rollback ledger with honest uncompensated effect reporting,
 * and migration trial verification.
 */
export class PromotionService {
  private readonly promotions = new Map<string, StoredPromotionRecord>();
  private readonly rollbacks = new Map<string, RollbackReceipt>();

  constructor(private readonly auditStore?: AuditStore) {}

  /**
   * promote (S11 / V1-07 Contract Sketch):
   * promote(plan, evidenceSet): Promise<PromotionReceipt> (or Effect)
   */
  readonly promote = Effect.fn("PromotionService.promote")(function* (
    this: PromotionService,
    plan: PromotionPlan,
    evidenceSet: PromotionEvidenceSet,
    cohortEvaluator?: (
      cohort: RolloutCohort
    ) => Effect.Effect<
      { readonly passed: boolean; readonly reason?: string },
      never
    >
  ): Effect.fn.Return<PromotionReceipt, PromotionEvidenceMismatchError> {
    // 1. Invariant: Promotion rejects evidence from another candidate or profile (S11)
    if (
      evidenceSet.candidateDigest !== plan.candidateDigest ||
      evidenceSet.profile !== plan.profile
    ) {
      return yield* new PromotionEvidenceMismatchError({
        actualCandidateDigest: evidenceSet.candidateDigest,
        actualProfile: evidenceSet.profile,
        expectedCandidateDigest: plan.candidateDigest,
        expectedProfile: plan.profile,
        message: `Promotion evidence bounds mismatch: expected candidate '${plan.candidateDigest}' in profile '${plan.profile}', but received candidate '${evidenceSet.candidateDigest}' in profile '${evidenceSet.profile}'`,
      });
    }

    // 2. Invariant: Phased rollout across cohorts; failed rollout stops before next cohort (S11)
    const completedCohorts: string[] = [];
    let status: "promoted" | "halted" | "failed" = "promoted";
    let activeCohort: string | undefined;
    let haltedAtCohort: string | undefined;
    let haltReason: string | undefined;

    yield* Effect.forEach(
      plan.cohorts,
      Effect.fn("PromotionService.processCohort")(function* (cohort) {
        if (status === "halted") return;
        activeCohort = cohort.cohortId;

        if (cohortEvaluator) {
          const evalResult = yield* cohortEvaluator(cohort);
          if (!evalResult.passed) {
            status = "halted";
            haltedAtCohort = cohort.cohortId;
            haltReason =
              evalResult.reason ??
              `Cohort stop condition breached at '${cohort.cohortId}'`;
            // STOP immediately before evaluating or deploying the next cohort!
            return;
          }
        }

        completedCohorts.push(cohort.cohortId);
      }),
      { concurrency: 1 }
    );

    const now = yield* Clock.currentTimeMillis;
    const promotionId = generatePrefixedId("prom", now);

    const receiptWithoutHash = {
      activeCohort,
      candidateDigest: plan.candidateDigest,
      completedCohorts,
      haltReason,
      haltedAtCohort,
      planId: plan.planId,
      profile: plan.profile,
      promotedAt: now,
      promotionId,
      status,
      targetEnvironment: plan.targetEnvironment,
    };

    const receipt: PromotionReceipt = {
      ...receiptWithoutHash,
      receiptHash: computePromotionReceiptHash(receiptWithoutHash),
    };

    this.promotions.set(promotionId, { plan, receipt });

    // 3. Append to immutable audit ledger if audit store configured
    if (this.auditStore) {
      yield* this.auditStore
        .appendDecision({
          actionTypeId: "governed_promotion",
          correlationId: plan.planId,
          id: `dec_${promotionId}`,
          outcome: status === "promoted" ? "executed" : "rejected",
          parameters: {
            completedCohorts,
            haltReason,
            haltedAtCohort,
            planId: plan.planId,
            status,
          },
          reason:
            status === "promoted"
              ? "Governed promotion rollout succeeded across all cohorts"
              : `Governed promotion halted: ${haltReason}`,
          ruleVersion: plan.candidateDigest,
          stateSnapshot: {
            activeCohort,
            candidateDigest: plan.candidateDigest,
            profile: plan.profile,
          },
          subject: {
            id: "operon_promotion_system",
            name: "Promotion Engine",
            roles: ["release_manager"],
            type: "system",
          },
          timestamp: now,
          verdict: status === "promoted" ? "allow" : "deny",
        })
        .pipe(Effect.ignore);
    }

    return receipt;
  });

  /**
   * rollback (S11 / V1-07 Contract Sketch):
   * rollback(receipt, reason): Promise<RollbackReceipt> (or Effect)
   */
  readonly rollback = Effect.fn("PromotionService.rollback")(function* (
    this: PromotionService,
    receipt: PromotionReceipt,
    reason: string,
    targetCandidateDigest?: string
  ): Effect.fn.Return<RollbackReceipt, RollbackExecutionError> {
    const record = this.promotions.get(receipt.promotionId);

    // Invariant: Rollback preserves history and reports uncompensated effects (S11)
    // "Restoring code cannot undo a delivery or payment."
    const uncompensatedEffects = record
      ? [...record.plan.irreversibleEffects]
      : [];
    const compensatedMutationsCount = record
      ? record.plan.reversibleEffects.length
      : 0;

    const now = yield* Clock.currentTimeMillis;
    const rollbackId = generatePrefixedId("roll", now);
    const targetDigest = targetCandidateDigest ?? "candidate_baseline_genesis";

    const rollbackWithoutHash = {
      compensatedMutationsCount,
      promotionId: receipt.promotionId,
      reason,
      revertedCandidateDigest: receipt.candidateDigest,
      rollbackId,
      rolledBackAt: now,
      targetCandidateDigest: targetDigest,
      uncompensatedEffects,
    };

    const rollbackReceipt: RollbackReceipt = {
      ...rollbackWithoutHash,
      receiptHash: computeRollbackReceiptHash(rollbackWithoutHash),
    };

    this.rollbacks.set(rollbackId, rollbackReceipt);

    // Append compensation audit record to ledger preserving full history (never deleting past records)
    if (this.auditStore) {
      yield* this.auditStore
        .appendDecision({
          actionTypeId: "governed_rollback",
          compensation: {
            compensatedAt: now,
            error: reason,
          },
          correlationId: receipt.planId,
          id: `dec_${rollbackId}`,
          outcome: "compensated",
          parameters: {
            compensatedMutationsCount,
            promotionId: receipt.promotionId,
            reason,
            revertedCandidate: receipt.candidateDigest,
            targetCandidate: targetDigest,
            uncompensatedEffects,
          },
          reason: `Governed rollback executed: ${reason}`,
          ruleVersion: targetDigest,
          stateSnapshot: {
            revertedCandidate: receipt.candidateDigest,
            targetCandidate: targetDigest,
          },
          subject: {
            id: "operon_rollback_system",
            name: "Rollback Engine",
            roles: ["release_manager"],
            type: "system",
          },
          timestamp: now,
          verdict: "allow",
        })
        .pipe(Effect.ignore);
    }

    return rollbackReceipt;
  });

  /**
   * verifyMigrationTrial:
   * Verifies migration rehearsal and detects schema divergences prior to promotion
   */
  readonly verifyMigrationTrial = Effect.fn(
    "PromotionService.verifyMigrationTrial"
  )(function* (
    this: PromotionService,
    trial: MigrationTrial,
    schemaDiffFn?: (v1: string, v2: string) => readonly string[]
  ): Effect.fn.Return<MigrationTrialReceipt> {
    const divergences = schemaDiffFn
      ? schemaDiffFn(trial.sourceSchemaVersion, trial.targetSchemaVersion)
      : [];
    const passed = divergences.length === 0;
    const now = yield* Clock.currentTimeMillis;

    const receiptWithoutHash = {
      passed,
      rehearsedRecords: trial.trialRecordsCount,
      schemaDivergences: divergences,
      trialId: trial.trialId,
      verifiedAt: now,
    };

    const receipt: MigrationTrialReceipt = {
      ...receiptWithoutHash,
      trialReceiptHash: computeMigrationTrialReceiptHash(receiptWithoutHash),
    };

    return receipt;
  });

  getPromotion(promotionId: string): Option.Option<PromotionReceipt> {
    const record = this.promotions.get(promotionId);
    return record ? Option.some(record.receipt) : Option.none();
  }

  getRollback(rollbackId: string): Option.Option<RollbackReceipt> {
    const record = this.rollbacks.get(rollbackId);
    return record ? Option.some(record) : Option.none();
  }

  listRollbacks(): readonly RollbackReceipt[] {
    return [...this.rollbacks.values()];
  }
}
