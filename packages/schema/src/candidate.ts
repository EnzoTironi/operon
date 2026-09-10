import { Schema } from "effect";

import { computeCanonicalDigest, DefinitionArtifact } from "./definition.js";

/**
 * Supported execution profiles per ADR-02 and D-CONS-04
 */
export const Profile = Schema.Literals([
  "local",
  "production",
  "external-agent",
]);
export type Profile = Schema.Schema.Type<typeof Profile>;

/**
 * Pinned runtime versions per S01 baseline
 */
export const RuntimeVersions = Schema.Struct({
  effect: Schema.String,
  node: Schema.String,
  pnpm: Schema.String,
});
export type RuntimeVersions = Schema.Schema.Type<typeof RuntimeVersions>;

/**
 * Candidate: Immutable, reproducible candidate identity per S01 and V1-01
 */
export const Candidate = Schema.Struct({
  candidateDigest: Schema.String,
  candidateId: Schema.String,
  config: Schema.String,
  contracts: Schema.String,
  lock: Schema.String,
  profile: Profile,
  runtimeVersions: RuntimeVersions,
  timestamp: Schema.Number,
  tree: Schema.String,
});
export type Candidate = Schema.Schema.Type<typeof Candidate>;

/**
 * Source precedence layers in canonical order per S01
 */
export const SourcePrecedenceLayer = Schema.Literals([
  "system",
  "contract",
  "tenant",
  "environment",
]);
export type SourcePrecedenceLayer = Schema.Schema.Type<
  typeof SourcePrecedenceLayer
>;

/**
 * Normative source precedence order: System -> Contract -> Tenant -> Environment.
 * Changing or reordering this order fails closed.
 */
export const CANONICAL_SOURCE_PRECEDENCE: readonly SourcePrecedenceLayer[] = [
  "system",
  "contract",
  "tenant",
  "environment",
] as const;

/**
 * SourceSet: Source definitions, digests, and precedence configuration for candidate compilation
 */
export const SourceSet = Schema.Struct({
  config: Schema.String,
  definitions: DefinitionArtifact,
  lock: Schema.String,
  precedence: Schema.optional(Schema.Array(SourcePrecedenceLayer)),
  profile: Schema.optional(Profile),
  runtimeVersions: Schema.optional(RuntimeVersions),
  schemaVersion: Schema.String,
  tree: Schema.String,
});
export type SourceSet = Schema.Schema.Type<typeof SourceSet>;

/**
 * Computes deterministic RFC 8785 canonical digest over Candidate coordinates
 */
export function computeCandidateDigest(candidate: {
  readonly tree: string;
  readonly lock: string;
  readonly config: string;
  readonly contracts: string;
  readonly profile: string;
  readonly runtimeVersions: {
    readonly effect: string;
    readonly node: string;
    readonly pnpm: string;
  };
}): string {
  return computeCanonicalDigest({
    config: candidate.config,
    contracts: candidate.contracts,
    lock: candidate.lock,
    profile: candidate.profile,
    runtimeVersions: candidate.runtimeVersions,
    tree: candidate.tree,
  });
}
