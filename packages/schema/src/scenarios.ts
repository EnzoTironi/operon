import { Schema } from "effect";

import { computeCanonicalDigest } from "./definition.js";

/**
 * ScenarioManifest (S10 / V1-06):
 * Immutable manifest pinning scenario profile, baseline candidate,
 * boundaries, and egress policy.
 */
export const ScenarioManifestSchema = Schema.Struct({
  baselineCandidateDigest: Schema.String,
  egressPolicy: Schema.Literals([
    "deny_all",
    "loopback_only",
    "allow_synthetic",
  ]),
  environmentId: Schema.String,
  executionProfile: Schema.Literals([
    "synthetic_laboratory",
    "authorized_data_scenario",
    "builder_workspace",
  ]),
  permittedBroker: Schema.String,
  scenarioId: Schema.String,
  seed: Schema.optional(Schema.Number),
  tenantId: Schema.String,
  ttlMs: Schema.optional(Schema.Number),
});
export type ScenarioManifest = Schema.Schema.Type<
  typeof ScenarioManifestSchema
>;

export function computeScenarioManifestDigest(
  manifest: ScenarioManifest
): string {
  return computeCanonicalDigest(manifest);
}

/**
 * ScenarioReceipt (S10 / V1-06):
 * Verifiable receipt of scenario execution with containment proofs
 */
export const ScenarioReceiptSchema = Schema.Struct({
  candidateDigest: Schema.String,
  containmentViolations: Schema.Array(Schema.String),
  egressAttemptsBlocked: Schema.Number,
  executedActionsCount: Schema.Number,
  executedAt: Schema.Number,
  manifestDigest: Schema.String,
  productionEffectsEmitted: Schema.Literal(0),
  receiptHash: Schema.String,
  scenarioId: Schema.String,
  status: Schema.Literals(["completed", "failed", "contained"]),
});
export type ScenarioReceipt = Schema.Schema.Type<typeof ScenarioReceiptSchema>;

export function computeScenarioReceiptHash(
  receiptWithoutHash: Omit<ScenarioReceipt, "receiptHash">
): string {
  return computeCanonicalDigest(receiptWithoutHash);
}
