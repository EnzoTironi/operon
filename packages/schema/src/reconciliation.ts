import { Schema } from "effect";

import { computeCanonicalDigest } from "./definition.js";
import { IdentityKey } from "./identity.js";
import { FieldProvenanceSchema } from "./ingestion.js";

/**
 * WorldView pins tenant, environment, ontology, valid-time interpretation,
 * committed knowledge revision, definition release ref, policy context,
 * and evidence coverage per S04.
 */
export const WorldViewSchema = Schema.Struct({
  tenantId: Schema.String,
  environmentId: Schema.String,
  ontologyId: Schema.String,
  validTime: Schema.Number,
  knowledgeRevision: Schema.Number,
  definitionReleaseRef: Schema.String,
  policyContext: Schema.Record(Schema.String, Schema.Unknown),
  evidenceCoverage: Schema.Array(Schema.String),
  pinnedAt: Schema.Number,
  digest: Schema.String,
});
export type WorldView = Schema.Schema.Type<typeof WorldViewSchema>;

export function computeWorldViewDigest(
  worldViewWithoutDigest: Omit<WorldView, "digest">
): string {
  return computeCanonicalDigest(worldViewWithoutDigest);
}

export function createWorldView(
  params: Omit<WorldView, "digest" | "pinnedAt"> & { pinnedAt?: number }
): WorldView {
  const pinnedAt = params.pinnedAt ?? Date.now();
  const withoutDigest = {
    definitionReleaseRef: params.definitionReleaseRef,
    environmentId: params.environmentId,
    evidenceCoverage: params.evidenceCoverage,
    knowledgeRevision: params.knowledgeRevision,
    ontologyId: params.ontologyId,
    pinnedAt,
    policyContext: params.policyContext,
    tenantId: params.tenantId,
    validTime: params.validTime,
  };
  return {
    ...withoutDigest,
    digest: computeWorldViewDigest(withoutDigest),
  };
}

/**
 * QueryCoverage tracks evidence lineage, staleness, and completeness
 */
export const QueryCoverageSchema = Schema.Struct({
  evidenceDigests: Schema.Array(Schema.String),
  isStale: Schema.Boolean,
  completeness: Schema.Literals(["complete", "incomplete", "stale"]),
  minValidTime: Schema.Number,
  maxValidTime: Schema.Number,
});
export type QueryCoverage = Schema.Schema.Type<typeof QueryCoverageSchema>;

/**
 * ExactQueryRequest defines parameters for point-in-time querying under a WorldView
 */
export const ExactQueryRequestSchema = Schema.Struct({
  releaseRef: Schema.String,
  queryId: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
  worldView: WorldViewSchema,
  cursor: Schema.NullOr(Schema.String),
});
export type ExactQueryRequest = Schema.Schema.Type<
  typeof ExactQueryRequestSchema
>;

/**
 * Identity resolution actions per S03
 */
export const IdentityResolutionAction = Schema.Literals([
  "link",
  "merge",
  "split",
]);
export type IdentityResolutionAction = Schema.Schema.Type<
  typeof IdentityResolutionAction
>;

/**
 * IdentityResolutionProposal for deterministic or language-model matching
 */
export const IdentityResolutionProposalSchema = Schema.Struct({
  proposalId: Schema.String,
  tenantId: Schema.String,
  environmentId: Schema.String,
  key: IdentityKey,
  targetCanonicalId: Schema.String,
  action: IdentityResolutionAction,
  confidence: Schema.Number, // 0.0 to 1.0
  evidence: Schema.Array(FieldProvenanceSchema),
  splitDetails: Schema.NullOr(
    Schema.Struct({
      originalIds: Schema.Array(Schema.String),
      reason: Schema.String,
    })
  ),
  status: Schema.Literals([
    "proposed",
    "resolved",
    "unresolved_ambiguous",
    "rejected",
  ]),
  proposedAt: Schema.Number,
  idempotencyKey: Schema.NullOr(Schema.String),
});
export type IdentityResolutionProposal = Schema.Schema.Type<
  typeof IdentityResolutionProposalSchema
>;

/**
 * ResolutionReceipt emitted upon resolving an identity proposal
 */
export const ResolutionReceiptSchema = Schema.Struct({
  resolutionId: Schema.String,
  proposalId: Schema.String,
  decisionRef: Schema.String,
  action: IdentityResolutionAction,
  canonicalId: Schema.String,
  previousCanonicalId: Schema.NullOr(Schema.String),
  historicalReferences: Schema.Array(Schema.String),
  invalidatedProjections: Schema.Array(Schema.String),
  status: Schema.Literals(["resolved", "unresolved_ambiguous"]),
  appliedAt: Schema.Number,
  idempotencyKey: Schema.NullOr(Schema.String),
});
export type ResolutionReceipt = Schema.Schema.Type<
  typeof ResolutionReceiptSchema
>;
