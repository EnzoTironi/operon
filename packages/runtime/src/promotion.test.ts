import type {
  MigrationTrial,
  PromotionEvidenceSet,
  PromotionPlan,
} from "@operon/schema";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { PromotionEvidenceMismatchError } from "./actions-errors.js";
import { InMemoryAuditStore } from "./audit.js";
import { PromotionService } from "./promotion.js";

describe("Gate G1 / Ticket V1-07: Governed Promotion, Phased Rollout and Rollback Ledger (S11)", () => {
  let auditStore: InMemoryAuditStore;
  let service: PromotionService;

  const validPlan: PromotionPlan = {
    candidateDigest:
      "cand_alpha_111111111111111111111111111111111111111111111111111111111111",
    cohorts: [
      {
        cohortId: "canary_10",
        description: "10% Canary rollout",
        targetPercentage: 10,
      },
      {
        cohortId: "cohort_50",
        description: "50% Phase 1 rollout",
        targetPercentage: 50,
      },
      {
        cohortId: "cohort_100",
        description: "100% Full deployment",
        targetPercentage: 100,
      },
    ],
    irreversibleEffects: [
      "external_pharmacy_dispense_order_rx99",
      "dispatched_telecom_sms_notification",
    ],
    planId: "plan_clinical_dose_v1",
    profile: "production",
    reversibleEffects: [
      "patient_vital_baseline_v2",
      "config_dosage_thresholds",
    ],
    selectedActionIds: ["adjust_dosage", "notify_physician"],
    targetEnvironment: "prod_clinical_metro",
    timestamp: Date.now(),
  };

  const validEvidence: PromotionEvidenceSet = {
    candidateDigest: validPlan.candidateDigest,
    evaluatedAt: Date.now(),
    evidenceReferences: [
      "evidence://audit/sentinel_review_01",
      "evidence://sandbox/scenario_clean_receipt_101",
    ],
    profile: "production",
    reviewReceiptHash:
      "rev_hash_111111111111111111111111111111111111111111111111111111111111",
    scenarioReceiptHash:
      "scen_hash_222222222222222222222222222222222222222222222222222222222222",
  };

  beforeEach(() => {
    auditStore = new InMemoryAuditStore();
    service = new PromotionService(auditStore);
  });

  describe("S11 Invariant 1: Candidate and Profile Evidence Binding", () => {
    it("does reject promotion evidence from another candidate or profile (S11)", async () => {
      // 1. Evidence with foreign candidateDigest
      const foreignCandidateEvidence: PromotionEvidenceSet = {
        ...validEvidence,
        candidateDigest:
          "cand_foreign_999999999999999999999999999999999999999999999999999999999999",
      };

      const candErr = await Effect.runPromise(
        Effect.flip(service.promote(validPlan, foreignCandidateEvidence))
      );
      expect(candErr).toBeInstanceOf(PromotionEvidenceMismatchError);
      expect(candErr.expectedCandidateDigest).toBe(validPlan.candidateDigest);
      expect(candErr.actualCandidateDigest).toBe(
        foreignCandidateEvidence.candidateDigest
      );

      // 2. Evidence with mismatched execution profile (e.g. synthetic scenario vs production)
      const foreignProfileEvidence: PromotionEvidenceSet = {
        ...validEvidence,
        profile: "scenario", // Prohibited: Scenario evidence cannot directly satisfy production profile!
      };

      const profErr = await Effect.runPromise(
        Effect.flip(service.promote(validPlan, foreignProfileEvidence))
      );
      expect(profErr).toBeInstanceOf(PromotionEvidenceMismatchError);
      expect(profErr.expectedProfile).toBe("production");
      expect(profErr.actualProfile).toBe("scenario");

      // 3. Matched evidence succeeds
      const receipt = await Effect.runPromise(
        service.promote(validPlan, validEvidence)
      );
      expect(receipt.status).toBe("promoted");
      expect(receipt.completedCohorts).toEqual([
        "canary_10",
        "cohort_50",
        "cohort_100",
      ]);
      expect(receipt.receiptHash).toBeDefined();
      expect(receipt.receiptHash).toHaveLength(64);
    });
  });

  describe("S11 Invariant 2: Phased Rollout and Early Halt", () => {
    it("does stop rollout before next cohort when stop condition is breached (S11)", async () => {
      let cohortEvaluatedCount = 0;

      const receipt = await Effect.runPromise(
        service.promote(validPlan, validEvidence, (cohort) =>
          Effect.sync(() => {
            cohortEvaluatedCount++;
            if (cohort.cohortId === "cohort_50") {
              // Simulate stop condition breached (e.g. latency spike or error rate threshold exceeded)
              return {
                passed: false,
                reason:
                  "Error budget breached: p99 latency > 250ms in cohort_50",
              };
            }
            return { passed: true };
          })
        )
      );

      // Invariant: Failed rollout stops before next cohort!
      expect(receipt.status).toBe("halted");
      expect(receipt.completedCohorts).toEqual(["canary_10"]);
      expect(receipt.haltedAtCohort).toBe("cohort_50");
      expect(receipt.haltReason).toContain("Error budget breached");

      // cohort_100 was NEVER evaluated or rolled out to
      expect(cohortEvaluatedCount).toBe(2);
      expect(receipt.completedCohorts).not.toContain("cohort_100");

      // Audit store recorded the halted outcome truthfully
      const decisions = await Effect.runPromise(auditStore.listDecisions());
      const lastDecision = decisions.at(-1)!;
      expect(lastDecision.outcome).toBe("rejected");
      expect(lastDecision.verdict).toBe("deny");
      expect(lastDecision.reason).toContain("Governed promotion halted");
    });

    it("does complete rollout across all cohorts when all health checks pass (S11)", async () => {
      const evaluatedCohorts: string[] = [];

      const receipt = await Effect.runPromise(
        service.promote(validPlan, validEvidence, (cohort) =>
          Effect.sync(() => {
            evaluatedCohorts.push(cohort.cohortId);
            return { passed: true };
          })
        )
      );

      expect(receipt.status).toBe("promoted");
      expect(receipt.completedCohorts).toEqual([
        "canary_10",
        "cohort_50",
        "cohort_100",
      ]);
      expect(evaluatedCohorts).toEqual([
        "canary_10",
        "cohort_50",
        "cohort_100",
      ]);

      const decisions = await Effect.runPromise(auditStore.listDecisions());
      const lastDecision = decisions.at(-1)!;
      expect(lastDecision.outcome).toBe("executed");
      expect(lastDecision.verdict).toBe("allow");
    });
  });

  describe("S11 Invariant 3: Rollback Preserves History and Reports Uncompensated Effects", () => {
    it("does preserve history and honestly report uncompensated effects on rollback (S11)", async () => {
      // 1. First promote
      const promoReceipt = await Effect.runPromise(
        service.promote(validPlan, validEvidence)
      );
      expect(promoReceipt.status).toBe("promoted");

      const initialDecisions = await Effect.runPromise(
        auditStore.listDecisions()
      );
      expect(initialDecisions).toHaveLength(1);
      const promoDecisionHash = initialDecisions[0].recordHash;

      // 2. Perform rollback
      const targetCandidate =
        "cand_safe_baseline_000000000000000000000000000000000000000000";
      const rollbackReceipt = await Effect.runPromise(
        service.rollback(
          promoReceipt,
          "Critical clinical anomaly detected in cohort 100",
          targetCandidate
        )
      );

      // Invariant: Rollback preserves history without rewriting past records
      const updatedDecisions = await Effect.runPromise(
        auditStore.listDecisions()
      );
      expect(updatedDecisions).toHaveLength(2);
      expect(updatedDecisions[0].recordHash).toBe(promoDecisionHash); // Prior record completely untouched
      expect(updatedDecisions[1].actionTypeId).toBe("governed_rollback");
      expect(updatedDecisions[1].outcome).toBe("compensated");

      // Verify SHA-256 Merkle chain integrity across promotion and rollback
      const chainValid = await Effect.runPromise(auditStore.verifyAuditChain());
      expect(chainValid).toBe(true);

      // Invariant: Restoring code cannot undo a delivery or payment; uncompensated external effects are reported honestly
      expect(rollbackReceipt.rollbackId).toBeDefined();
      expect(rollbackReceipt.promotionId).toBe(promoReceipt.promotionId);
      expect(rollbackReceipt.revertedCandidateDigest).toBe(
        validPlan.candidateDigest
      );
      expect(rollbackReceipt.targetCandidateDigest).toBe(targetCandidate);
      expect(rollbackReceipt.uncompensatedEffects).toEqual([
        "external_pharmacy_dispense_order_rx99",
        "dispatched_telecom_sms_notification",
      ]);
      expect(rollbackReceipt.compensatedMutationsCount).toBe(2);
      expect(rollbackReceipt.receiptHash).toBeDefined();
      expect(rollbackReceipt.receiptHash).toHaveLength(64);
    });
  });

  describe("S11 Migration Trial Verification", () => {
    it("does verify migration trial and detect schema divergences prior to promotion (S11)", async () => {
      const trial: MigrationTrial = {
        sourceSchemaVersion: "1.0.0",
        targetSchemaVersion: "1.1.0",
        trialId: "trial_patient_schema_upgrade_01",
        trialRecordsCount: 500,
      };

      // 1. Clean migration trial
      const cleanReceipt = await Effect.runPromise(
        service.verifyMigrationTrial(trial, () => [])
      );
      expect(cleanReceipt.passed).toBe(true);
      expect(cleanReceipt.rehearsedRecords).toBe(500);
      expect(cleanReceipt.schemaDivergences).toHaveLength(0);
      expect(cleanReceipt.trialReceiptHash).toHaveLength(64);

      // 2. Migration trial with breaking divergence
      const divergingReceipt = await Effect.runPromise(
        service.verifyMigrationTrial(trial, () => [
          "Field 'dosage_units' deleted without backward translation adapter",
        ])
      );
      expect(divergingReceipt.passed).toBe(false);
      expect(divergingReceipt.schemaDivergences).toContain(
        "Field 'dosage_units' deleted without backward translation adapter"
      );
      expect(divergingReceipt.trialReceiptHash).toHaveLength(64);
    });
  });
});
