import type {
  AuthorityResult,
  IntentGrant,
  PrincipalContext,
  UseGrant,
} from "@operon/schema";
import { Effect } from "effect";

export interface EvaluateAuthorityInput {
  readonly principal: PrincipalContext;
  readonly intent: IntentGrant;
  readonly uses: readonly UseGrant[];
  readonly now?: number;
}

/**
 * Pure evaluator implementing S05/S06/V1-03:
 * Server-bound principal context, aggregate budget reservation,
 * audience/purpose attenuation, and canonical 4-valued verdict algebra:
 * ALLOW | DENY | REVIEW_REQUIRED | EVIDENCE_INSUFFICIENT.
 */
interface EvaluationContext {
  readonly diagnostics: string[];
  readonly now: number;
  readonly principalId: string;
}

function checkPrincipalElevation(principal: PrincipalContext): string[] {
  const diagnostics: string[] = [];
  if (
    principal.clientAssertedTenantId &&
    principal.clientAssertedTenantId !== principal.authenticatedTenantId
  ) {
    diagnostics.push(
      `Client attempted tenant elevation: asserted '${principal.clientAssertedTenantId}', authenticated '${principal.authenticatedTenantId}'`
    );
  }

  if (
    principal.clientAssertedRoles &&
    principal.clientAssertedRoles.some(
      (r) => !principal.serverAssignedRoles.includes(r)
    )
  ) {
    diagnostics.push(
      `Client attempted role elevation: asserted [${principal.clientAssertedRoles.join(", ")}], server assigned [${principal.serverAssignedRoles.join(", ")}]`
    );
  }
  return diagnostics;
}

function validateIsolationAndGrant(
  principal: PrincipalContext,
  intent: IntentGrant,
  ctx: EvaluationContext
): AuthorityResult | null {
  const { diagnostics, now, principalId } = ctx;
  if (intent.tenantId !== principal.authenticatedTenantId) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Tenant access denied: authenticated tenant '${principal.authenticatedTenantId}' does not match grant tenant '${intent.tenantId}'`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  if (intent.environmentId !== principal.authenticatedEnvironmentId) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Environment mismatch: authenticated environment '${principal.authenticatedEnvironmentId}' does not match grant environment '${intent.environmentId}'`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  if (intent.actorId !== principal.principalId && intent.actorId !== "*") {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Principal mismatch: principal '${principal.principalId}' does not match grant actor '${intent.actorId}'`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  if (now > intent.expiresAt) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Intent grant '${intent.id}' expired at ${intent.expiresAt} (current time: ${now})`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  return null;
}

function isResourcePatternMatch(pattern: string, resourceId: string): boolean {
  if (pattern === "*" || pattern === resourceId) {
    return true;
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return resourceId.startsWith(`${prefix}/`) || resourceId === prefix;
  }
  return false;
}

function validateSingleUse(
  use: UseGrant,
  intent: IntentGrant,
  ctx: EvaluationContext
): AuthorityResult | null {
  const { diagnostics, now, principalId } = ctx;
  if (
    intent.eligibleActions.length > 0 &&
    !intent.eligibleActions.includes(use.actionId) &&
    !intent.eligibleActions.includes("*")
  ) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Action '${use.actionId}' is not authorized under intent eligible actions [${intent.eligibleActions.join(", ")}]`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  const isResourceEligible =
    intent.eligibleResources.length === 0 ||
    intent.eligibleResources.some((pat) =>
      isResourcePatternMatch(pat, use.resourceId)
    );

  if (!isResourceEligible) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Resource '${use.resourceId}' is not authorized under intent eligible resources [${intent.eligibleResources.join(", ")}]`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  if (
    intent.destinationAudiences.length > 0 &&
    !intent.destinationAudiences.includes(use.audience) &&
    !intent.destinationAudiences.includes("*")
  ) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Audience '${use.audience}' is attenuated: not permitted under destination audiences [${intent.destinationAudiences.join(", ")}]`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  const remainingBudget =
    intent.budget.maxReservations - intent.budget.committedReservations;

  if (
    intent.purpose !== "*" &&
    use.purpose.toLowerCase() !== intent.purpose.toLowerCase()
  ) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Purpose divergence: requested purpose '${use.purpose}' differs from authorized grant purpose '${intent.purpose}'; specialist review required`,
      remainingBudget,
      verdict: "REVIEW_REQUIRED",
    };
  }

  if (use.requiredEvidenceFreshnessMs !== undefined) {
    if (use.availableEvidenceAgeMs === undefined) {
      return {
        diagnostics,
        evaluatedAt: now,
        intentId: intent.id,
        principalId,
        reason: `Evidence insufficient: required freshness window ${use.requiredEvidenceFreshnessMs}ms but evidence age is unknown or missing`,
        remainingBudget,
        verdict: "EVIDENCE_INSUFFICIENT",
      };
    }

    if (use.availableEvidenceAgeMs > use.requiredEvidenceFreshnessMs) {
      return {
        diagnostics,
        evaluatedAt: now,
        intentId: intent.id,
        principalId,
        reason: `Evidence insufficient: available evidence age ${use.availableEvidenceAgeMs}ms exceeds freshness budget ${use.requiredEvidenceFreshnessMs}ms`,
        remainingBudget,
        verdict: "EVIDENCE_INSUFFICIENT",
      };
    }
  }

  return null;
}

function validateAggregateBudget(
  uses: readonly UseGrant[],
  intent: IntentGrant,
  ctx: EvaluationContext
): AuthorityResult {
  const { diagnostics, now, principalId } = ctx;
  const requestedTotal = uses.reduce((acc, u) => acc + u.requestedUnits, 0);
  const remainingBudget =
    intent.budget.maxReservations - intent.budget.committedReservations;

  if (remainingBudget <= 0 && requestedTotal > 0) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Aggregate-use budget exhausted: requested ${requestedTotal} units, but remaining budget is 0 (max ${intent.budget.maxReservations}, committed ${intent.budget.committedReservations})`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  if (requestedTotal > remainingBudget) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId,
      reason: `Aggregate-use budget exceeded: requested ${requestedTotal} units exceeds remaining budget ${remainingBudget}; supervisory review required`,
      remainingBudget,
      verdict: "REVIEW_REQUIRED",
    };
  }

  return {
    diagnostics,
    evaluatedAt: now,
    intentId: intent.id,
    principalId,
    reason:
      "Authorized: principal, scope, purpose, audiences, evidence sufficiency, and aggregate budget verified",
    remainingBudget: remainingBudget - requestedTotal,
    verdict: "ALLOW",
  };
}

/**
 * Pure evaluator implementing S05/S06/V1-03:
 * Server-bound principal context, aggregate budget reservation,
 * audience/purpose attenuation, and canonical 4-valued verdict algebra:
 * ALLOW | DENY | REVIEW_REQUIRED | EVIDENCE_INSUFFICIENT.
 */
export function evaluateAuthority(
  input: EvaluateAuthorityInput
): AuthorityResult {
  const now = input.now ?? Date.now();
  const { principal, intent, uses } = input;
  const diagnostics = checkPrincipalElevation(principal);
  const ctx: EvaluationContext = {
    diagnostics,
    now,
    principalId: principal.principalId,
  };

  const isolationResult = validateIsolationAndGrant(principal, intent, ctx);
  if (isolationResult) {
    return isolationResult;
  }

  for (const use of uses) {
    const useResult = validateSingleUse(use, intent, ctx);
    if (useResult) {
      return useResult;
    }
  }

  return validateAggregateBudget(uses, intent, ctx);
}

/**
 * Effect-based wrapper for pipeline integration
 */
export const evaluate = Effect.fn("evaluate")((input: EvaluateAuthorityInput) =>
  Effect.sync(() => evaluateAuthority(input))
);
