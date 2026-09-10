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
export function evaluateAuthority(
  input: EvaluateAuthorityInput
): AuthorityResult {
  const now = input.now ?? Date.now();
  const { principal, intent, uses } = input;
  const diagnostics: string[] = [];

  // 1. Invariant S05: Client-supplied tenant/role cannot elevate authority.
  // The evaluator binds strictly to serverAssignedRoles and authenticatedTenantId.
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

  // Tenant isolation
  if (intent.tenantId !== principal.authenticatedTenantId) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId: principal.principalId,
      reason: `Tenant access denied: authenticated tenant '${principal.authenticatedTenantId}' does not match grant tenant '${intent.tenantId}'`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  // Environment isolation
  if (intent.environmentId !== principal.authenticatedEnvironmentId) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId: principal.principalId,
      reason: `Environment mismatch: authenticated environment '${principal.authenticatedEnvironmentId}' does not match grant environment '${intent.environmentId}'`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  // Actor binding
  if (intent.actorId !== principal.principalId && intent.actorId !== "*") {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId: principal.principalId,
      reason: `Principal mismatch: principal '${principal.principalId}' does not match grant actor '${intent.actorId}'`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  // Grant expiration
  if (now > intent.expiresAt) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId: principal.principalId,
      reason: `Intent grant '${intent.id}' expired at ${intent.expiresAt} (current time: ${now})`,
      remainingBudget: 0,
      verdict: "DENY",
    };
  }

  // 2. Information Use & Audience Attenuation (S06)
  for (const use of uses) {
    if (
      intent.eligibleActions.length > 0 &&
      !intent.eligibleActions.includes(use.actionId) &&
      !intent.eligibleActions.includes("*")
    ) {
      return {
        diagnostics,
        evaluatedAt: now,
        intentId: intent.id,
        principalId: principal.principalId,
        reason: `Action '${use.actionId}' is not authorized under intent eligible actions [${intent.eligibleActions.join(", ")}]`,
        remainingBudget: 0,
        verdict: "DENY",
      };
    }

    const isResourceEligible =
      intent.eligibleResources.length === 0 ||
      intent.eligibleResources.some((pat) => {
        if (pat === "*" || pat === use.resourceId) return true;
        if (pat.endsWith("/*")) {
          const prefix = pat.slice(0, -2);
          return (
            use.resourceId.startsWith(`${prefix}/`) || use.resourceId === prefix
          );
        }
        return false;
      });

    if (!isResourceEligible) {
      return {
        diagnostics,
        evaluatedAt: now,
        intentId: intent.id,
        principalId: principal.principalId,
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
        principalId: principal.principalId,
        reason: `Audience '${use.audience}' is attenuated: not permitted under destination audiences [${intent.destinationAudiences.join(", ")}]`,
        remainingBudget: 0,
        verdict: "DENY",
      };
    }

    if (
      intent.purpose !== "*" &&
      use.purpose.toLowerCase() !== intent.purpose.toLowerCase()
    ) {
      return {
        diagnostics,
        evaluatedAt: now,
        intentId: intent.id,
        principalId: principal.principalId,
        reason: `Purpose divergence: requested purpose '${use.purpose}' differs from authorized grant purpose '${intent.purpose}'; specialist review required`,
        remainingBudget:
          intent.budget.maxReservations - intent.budget.committedReservations,
        verdict: "REVIEW_REQUIRED",
      };
    }

    // 3. Evidence Freshness & Sufficiency (S06 / D05)
    if (use.requiredEvidenceFreshnessMs !== undefined) {
      if (use.availableEvidenceAgeMs === undefined) {
        return {
          diagnostics,
          evaluatedAt: now,
          intentId: intent.id,
          principalId: principal.principalId,
          reason: `Evidence insufficient: required freshness window ${use.requiredEvidenceFreshnessMs}ms but evidence age is unknown or missing`,
          remainingBudget:
            intent.budget.maxReservations - intent.budget.committedReservations,
          verdict: "EVIDENCE_INSUFFICIENT",
        };
      }

      if (use.availableEvidenceAgeMs > use.requiredEvidenceFreshnessMs) {
        return {
          diagnostics,
          evaluatedAt: now,
          intentId: intent.id,
          principalId: principal.principalId,
          reason: `Evidence insufficient: available evidence age ${use.availableEvidenceAgeMs}ms exceeds freshness budget ${use.requiredEvidenceFreshnessMs}ms`,
          remainingBudget:
            intent.budget.maxReservations - intent.budget.committedReservations,
          verdict: "EVIDENCE_INSUFFICIENT",
        };
      }
    }
  }

  // 4. Aggregate-Use Budget Exhaustion (S06 / V1-03)
  const requestedTotal = uses.reduce((acc, u) => acc + u.requestedUnits, 0);
  const remainingBudget =
    intent.budget.maxReservations - intent.budget.committedReservations;

  if (remainingBudget <= 0 && requestedTotal > 0) {
    return {
      diagnostics,
      evaluatedAt: now,
      intentId: intent.id,
      principalId: principal.principalId,
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
      principalId: principal.principalId,
      reason: `Aggregate-use budget exceeded: requested ${requestedTotal} units exceeds remaining budget ${remainingBudget}; supervisory review required`,
      remainingBudget,
      verdict: "REVIEW_REQUIRED",
    };
  }

  return {
    diagnostics,
    evaluatedAt: now,
    intentId: intent.id,
    principalId: principal.principalId,
    reason:
      "Authorized: principal, scope, purpose, audiences, evidence sufficiency, and aggregate budget verified",
    remainingBudget: remainingBudget - requestedTotal,
    verdict: "ALLOW",
  };
}

/**
 * Effect-based wrapper for pipeline integration
 */
export function evaluate(
  input: EvaluateAuthorityInput
): Effect.Effect<AuthorityResult> {
  return Effect.sync(() => evaluateAuthority(input));
}
