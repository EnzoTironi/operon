import type { IntentGrant, Subject, TaskMandate } from "@operon/schema";
import { Effect } from "effect";

import {
  GrantExceededError,
  GrantNotFoundError,
  TenantMismatchError,
} from "../actions-errors.js";

export interface AuthoritySnapshot {
  readonly mandates: readonly TaskMandate[];
  readonly grants: readonly IntentGrant[];
}

/**
 * AuthorityService (S06):
 * Server-evaluated authority with TaskMandate, IntentGrant, purpose,
 * data-use conditions, destination audiences, aggregate reservations,
 * and tenant non-disclosure.
 */
export class AuthorityService {
  private readonly mandates = new Map<string, TaskMandate>();
  private readonly grants = new Map<string, IntentGrant>();

  constructor(initialSnapshot?: AuthoritySnapshot) {
    if (initialSnapshot) {
      for (const m of initialSnapshot.mandates) {
        this.mandates.set(m.id, m);
      }
      for (const g of initialSnapshot.grants) {
        this.grants.set(g.id, g);
      }
    }
  }

  registerMandate(mandate: TaskMandate): Effect.Effect<TaskMandate> {
    const { mandates } = this;
    return Effect.sync(() => {
      mandates.set(mandate.id, mandate);
      return mandate;
    });
  }

  getMandate(
    mandateId: string,
    tenantId: string
  ): Effect.Effect<TaskMandate, GrantNotFoundError | TenantMismatchError> {
    const { mandates } = this;
    return Effect.gen(function* () {
      const mandate = mandates.get(mandateId);
      if (!mandate) {
        return yield* Effect.fail(
          new GrantNotFoundError({
            grantId: mandateId,
            message: `Mandate '${mandateId}' not found`,
          })
        );
      }
      if (mandate.tenantId !== tenantId) {
        // Tenant non-disclosure: fail without disclosing existence
        return yield* Effect.fail(
          new TenantMismatchError({
            message: `Mandate '${mandateId}' does not exist for tenant`,
            tenantId,
          })
        );
      }
      return mandate;
    });
  }

  registerGrant(grant: IntentGrant): Effect.Effect<IntentGrant> {
    const { grants } = this;
    return Effect.sync(() => {
      grants.set(grant.id, grant);
      return grant;
    });
  }

  getGrant(
    grantId: string,
    tenantId: string
  ): Effect.Effect<IntentGrant, GrantNotFoundError | TenantMismatchError> {
    const { grants } = this;
    return Effect.gen(function* () {
      const grant = grants.get(grantId);
      if (!grant) {
        return yield* Effect.fail(
          new GrantNotFoundError({
            grantId,
            message: `Grant '${grantId}' not found`,
          })
        );
      }
      if (grant.tenantId !== tenantId) {
        // Tenant non-disclosure: fail without disclosing existence
        return yield* Effect.fail(
          new TenantMismatchError({
            message: `Grant '${grantId}' does not exist for tenant`,
            tenantId,
          })
        );
      }
      return grant;
    });
  }

  listGrants(
    tenantId: string,
    actorId?: string
  ): Effect.Effect<readonly IntentGrant[]> {
    const { grants } = this;
    return Effect.sync(() =>
      [...grants.values()].filter((g) => {
        if (g.tenantId !== tenantId) return false;
        if (actorId && g.actorId !== actorId) return false;
        return true;
      })
    );
  }

  /**
   * Evaluates grant authority at preparation or commit time (S06)
   */
  validateGrantAuthority(params: {
    readonly grantId: string;
    readonly actor: Subject;
    readonly tenantId: string;
    readonly environmentId: string;
    readonly actionId: string;
    readonly reservationAmount: number;
    readonly now?: number;
  }): Effect.Effect<
    IntentGrant,
    GrantNotFoundError | GrantExceededError | TenantMismatchError
  > {
    const { getGrant } = this;
    const {
      grantId,
      actor,
      tenantId,
      environmentId,
      actionId,
      reservationAmount,
      now = Date.now(),
    } = params;

    return Effect.gen(function* () {
      const grant = yield* getGrant(grantId, tenantId);

      if (grant.environmentId !== environmentId) {
        const reason = `Grant environment '${grant.environmentId}' does not match execution environment '${environmentId}'`;
        return yield* Effect.fail(
          new GrantExceededError({
            grantId,
            message: reason,
            reason,
          })
        );
      }

      if (grant.actorId !== actor.id) {
        const reason = `Grant actor '${grant.actorId}' does not match invoking actor '${actor.id}'`;
        return yield* Effect.fail(
          new GrantExceededError({
            grantId,
            message: reason,
            reason,
          })
        );
      }

      if (now > grant.expiresAt) {
        const reason = `Grant '${grantId}' has expired at ${grant.expiresAt}`;
        return yield* Effect.fail(
          new GrantExceededError({
            grantId,
            message: reason,
            reason,
          })
        );
      }

      if (
        grant.eligibleActions.length > 0 &&
        !grant.eligibleActions.includes(actionId) &&
        !grant.eligibleActions.includes("*")
      ) {
        const reason = `Action '${actionId}' is not authorized under grant eligible actions [${grant.eligibleActions.join(", ")}]`;
        return yield* Effect.fail(
          new GrantExceededError({
            grantId,
            message: reason,
            reason,
          })
        );
      }

      // Budget check: committed + reservationAmount <= maxReservations
      const totalRequested =
        grant.budget.committedReservations + reservationAmount;
      if (totalRequested > grant.budget.maxReservations) {
        const reason = `Grant budget exceeded: requested reservation ${reservationAmount} + committed ${grant.budget.committedReservations} exceeds maximum budget ${grant.budget.maxReservations}`;
        return yield* Effect.fail(
          new GrantExceededError({
            grantId,
            message: reason,
            reason,
          })
        );
      }

      return grant;
    });
  }

  /**
   * Reserves budget atomically
   */
  reserveBudget(
    grantId: string,
    tenantId: string,
    amount: number
  ): Effect.Effect<
    void,
    GrantNotFoundError | GrantExceededError | TenantMismatchError
  > {
    const { getGrant, grants } = this;
    return Effect.gen(function* () {
      const grant = yield* getGrant(grantId, tenantId);
      const newCommitted = grant.budget.committedReservations + amount;
      if (newCommitted > grant.budget.maxReservations) {
        const reason = `Reservation of ${amount} exceeds remaining budget of ${grant.budget.maxReservations - grant.budget.committedReservations}`;
        return yield* Effect.fail(
          new GrantExceededError({
            grantId,
            message: reason,
            reason,
          })
        );
      }
      grants.set(grantId, {
        ...grant,
        budget: {
          ...grant.budget,
          committedReservations: newCommitted,
        },
      });
    });
  }

  exportSnapshot(): AuthoritySnapshot {
    return {
      grants: [...this.grants.values()],
      mandates: [...this.mandates.values()],
    };
  }

  importSnapshot(snapshot: AuthoritySnapshot): void {
    this.mandates.clear();
    for (const m of snapshot.mandates) {
      this.mandates.set(m.id, m);
    }
    this.grants.clear();
    for (const g of snapshot.grants) {
      this.grants.set(g.id, g);
    }
  }
}
