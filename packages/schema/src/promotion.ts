import { createHash } from "node:crypto";

import { canonicalJson } from "./definition.js";

/**
 * RolloutCohort: Phase in a canary or progressive deployment
 */
export interface RolloutCohort {
  readonly cohortId: string;
  readonly targetPercentage: number;
  readonly description?: string;
}

/**
 * PromotionPlan: Governed release specification binding candidate, profile, cohorts, and effects
 */
export interface PromotionPlan {
  readonly planId: string;
  readonly candidateDigest: string;
  readonly profile: string;
  readonly targetEnvironment: string;
  readonly selectedActionIds: readonly string[];
  readonly cohorts: readonly RolloutCohort[];
  readonly reversibleEffects: readonly string[];
  readonly irreversibleEffects: readonly string[];
  readonly timestamp: number;
  readonly migrationTrialId?: string;
}

/**
 * PromotionEvidenceSet: Candidate/profile-bound evidence submitted to authorize promotion
 */
export interface PromotionEvidenceSet {
  readonly candidateDigest: string;
  readonly profile: string;
  readonly evidenceReferences: readonly string[];
  readonly scenarioReceiptHash?: string;
  readonly reviewReceiptHash?: string;
  readonly evaluatedAt: number;
}

/**
 * PromotionReceipt: Truthful outcome receipt documenting promotion execution or halting
 */
export interface PromotionReceipt {
  readonly promotionId: string;
  readonly planId: string;
  readonly candidateDigest: string;
  readonly profile: string;
  readonly targetEnvironment: string;
  readonly status: "promoted" | "halted" | "failed";
  readonly completedCohorts: readonly string[];
  readonly activeCohort?: string;
  readonly haltedAtCohort?: string;
  readonly haltReason?: string;
  readonly promotedAt: number;
  readonly receiptHash: string;
}

/**
 * RollbackReceipt: Cryptographic ledger entry documenting rollback and uncompensated effects
 */
export interface RollbackReceipt {
  readonly rollbackId: string;
  readonly promotionId: string;
  readonly revertedCandidateDigest: string;
  readonly targetCandidateDigest: string;
  readonly reason: string;
  readonly uncompensatedEffects: readonly string[];
  readonly compensatedMutationsCount: number;
  readonly rolledBackAt: number;
  readonly receiptHash: string;
}

/**
 * MigrationTrial: Rehearsal specification for verifying backward/forward schema compatibility
 */
export interface MigrationTrial {
  readonly trialId: string;
  readonly sourceSchemaVersion: string;
  readonly targetSchemaVersion: string;
  readonly trialRecordsCount: number;
}

/**
 * MigrationTrialReceipt: Cryptographic verification of migration rehearsal outcome
 */
export interface MigrationTrialReceipt {
  readonly trialId: string;
  readonly passed: boolean;
  readonly rehearsedRecords: number;
  readonly schemaDivergences: readonly string[];
  readonly verifiedAt: number;
  readonly trialReceiptHash: string;
}

/**
 * Computes canonical SHA-256 hash of a promotion receipt
 */
export function computePromotionReceiptHash(
  receipt: Omit<PromotionReceipt, "receiptHash">
): string {
  const json = canonicalJson(receipt);
  return createHash("sha256").update(Buffer.from(json, "utf-8")).digest("hex");
}

/**
 * Computes canonical SHA-256 hash of a rollback receipt
 */
export function computeRollbackReceiptHash(
  receipt: Omit<RollbackReceipt, "receiptHash">
): string {
  const json = canonicalJson(receipt);
  return createHash("sha256").update(Buffer.from(json, "utf-8")).digest("hex");
}

/**
 * Computes canonical SHA-256 hash of a migration trial receipt
 */
export function computeMigrationTrialReceiptHash(
  receipt: Omit<MigrationTrialReceipt, "trialReceiptHash">
): string {
  const json = canonicalJson(receipt);
  return createHash("sha256").update(Buffer.from(json, "utf-8")).digest("hex");
}
