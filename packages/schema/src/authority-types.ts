import { Schema } from "effect";

/**
 * Canonical 4-valued business decision algebra per ADR-D05 and S06:
 * ALLOW | DENY | REVIEW_REQUIRED | EVIDENCE_INSUFFICIENT.
 * Infrastructure failure resides in a separate error channel.
 */
export const CanonicalVerdict = Schema.Literals([
  "ALLOW",
  "DENY",
  "REVIEW_REQUIRED",
  "EVIDENCE_INSUFFICIENT",
]);
export type CanonicalVerdict = Schema.Schema.Type<typeof CanonicalVerdict>;

/**
 * Server-bound principal context per S05.
 * Client assertions are recorded for attribution but strictly cannot elevate authority.
 */
export const PrincipalContext = Schema.Struct({
  actorType: Schema.Literals(["user", "agent", "system"]),
  agentTier: Schema.optionalKey(Schema.Literals([1, 2, 3, 4])),
  authenticatedEnvironmentId: Schema.String,
  authenticatedTenantId: Schema.String,
  clientAssertedRoles: Schema.optionalKey(Schema.Array(Schema.String)),
  clientAssertedTenantId: Schema.optionalKey(Schema.String),
  principalId: Schema.String,
  serverAssignedRoles: Schema.Array(Schema.String),
});
export type PrincipalContext = Schema.Schema.Type<typeof PrincipalContext>;

/**
 * Information use grant describing a requested invocation under an IntentGrant per S06
 */
export const UseGrant = Schema.Struct({
  actionId: Schema.String,
  audience: Schema.String,
  availableEvidenceAgeMs: Schema.optionalKey(Schema.Number),
  purpose: Schema.String,
  requestedUnits: Schema.Number,
  requiredEvidenceFreshnessMs: Schema.optionalKey(Schema.Number),
  resourceId: Schema.String,
});
export type UseGrant = Schema.Schema.Type<typeof UseGrant>;

/**
 * Authority evaluation outcome returned by the Authority Evaluator per S06 / V1-03
 */
export const AuthorityResult = Schema.Struct({
  diagnostics: Schema.Array(Schema.String),
  evaluatedAt: Schema.Number,
  intentId: Schema.String,
  principalId: Schema.String,
  reason: Schema.String,
  remainingBudget: Schema.Number,
  verdict: CanonicalVerdict,
});
export type AuthorityResult = Schema.Schema.Type<typeof AuthorityResult>;
