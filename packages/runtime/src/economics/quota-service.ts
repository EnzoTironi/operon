import type {
  LocalityChannel,
  LocalityPolicy,
  MissionCapacityReservation,
  TenantContentionReport,
  TenantQuotaPolicy,
} from "@operon/schema";
import { Effect } from "effect";

import {
  RegionalLocalityViolationError,
  TenantQuotaExceededError,
} from "../actions-errors.js";

interface TenantRuntimeState {
  activeMissions: number;
  recentRequestTimestamps: number[];
  spendCents: number;
  throttledCount: number;
}

/**
 * TenantQuotaService (S16, OPR-FULL-048, OPR-FULL-050):
 * Enforces multi-tenant resource quotas, noisy-neighbor capacity isolation,
 * finite transactional mission budgets, and sovereign regional locality fences.
 */
export class TenantQuotaService {
  private readonly quotaPolicies = new Map<string, TenantQuotaPolicy>();
  private readonly localityPolicies = new Map<string, LocalityPolicy>();
  private readonly tenantStates = new Map<string, TenantRuntimeState>();
  private readonly cellCapacity: number;

  constructor(options?: { readonly totalCellCapacity?: number }) {
    this.cellCapacity = options?.totalCellCapacity ?? 100;
  }

  /**
   * Registers or updates quota and locality policies for a tenant
   */
  registerTenant(quota: TenantQuotaPolicy, locality: LocalityPolicy): void {
    this.quotaPolicies.set(quota.tenantId, quota);
    this.localityPolicies.set(locality.tenantId, locality);
    if (!this.tenantStates.has(quota.tenantId)) {
      this.tenantStates.set(quota.tenantId, {
        activeMissions: 0,
        recentRequestTimestamps: [],
        spendCents: 0,
        throttledCount: 0,
      });
    }
  }

  /**
   * Reserves mission capacity with strict noisy-neighbor isolation (FULL-ACC-048)
   */
  reserveMissionCapacity(params: {
    readonly currentTime?: number;
    readonly reservationId?: string;
    readonly tenantId: string;
  }): Effect.Effect<MissionCapacityReservation, TenantQuotaExceededError> {
    const { tenantId } = params;
    const policy = this.quotaPolicies.get(tenantId);

    if (!policy) {
      return Effect.fail(
        new TenantQuotaExceededError({
          currentValue: 0,
          limitValue: 0,
          message: `Tenant "${tenantId}" has no declared quota policy`,
          quotaType: "CONCURRENCY",
          tenantId,
        })
      );
    }

    const state = this.tenantStates.get(tenantId)!;
    const now = params.currentTime ?? Date.now();

    // 1. Rate Limiting Check (sliding 60-second window)
    const windowStart = now - 60_000;
    state.recentRequestTimestamps = state.recentRequestTimestamps.filter(
      (ts) => ts > windowStart
    );

    if (state.recentRequestTimestamps.length >= policy.maxRatePerMinute) {
      state.throttledCount++;
      return Effect.fail(
        new TenantQuotaExceededError({
          currentValue: state.recentRequestTimestamps.length,
          limitValue: policy.maxRatePerMinute,
          message: `Tenant "${tenantId}" exceeded rate limit of ${policy.maxRatePerMinute} requests/minute`,
          quotaType: "RATE_LIMIT",
          tenantId,
        })
      );
    }

    // 2. Tenant Concurrency Check
    if (state.activeMissions >= policy.maxConcurrentMissions) {
      state.throttledCount++;
      return Effect.fail(
        new TenantQuotaExceededError({
          currentValue: state.activeMissions,
          limitValue: policy.maxConcurrentMissions,
          message: `Tenant "${tenantId}" exceeded maximum concurrent missions limit of ${policy.maxConcurrentMissions}`,
          quotaType: "CONCURRENCY",
          tenantId,
        })
      );
    }

    // 3. Noisy Neighbor Protection: compute other tenants' guaranteed capacity pool (FULL-ACC-048)
    let totalOtherGuaranteed = 0;
    let totalActiveAcrossCell = 0;

    for (const [otherTenantId, otherPolicy] of this.quotaPolicies.entries()) {
      const otherState = this.tenantStates.get(otherTenantId);
      const otherActive = otherState ? otherState.activeMissions : 0;
      totalActiveAcrossCell += otherActive;

      if (otherTenantId !== tenantId) {
        // Unused guaranteed capacity reserved exclusively for other tenants
        const unusedGuaranteed = Math.max(
          0,
          otherPolicy.guaranteedCapacityMissions - otherActive
        );
        totalOtherGuaranteed += unusedGuaranteed;
      }
    }

    // If tenant's current request would encroach upon other tenants' reserved guaranteed capacity:
    const availableDynamicPool = this.cellCapacity - totalOtherGuaranteed;
    const isWithinOwnGuaranteed =
      state.activeMissions < policy.guaranteedCapacityMissions;

    if (
      !isWithinOwnGuaranteed &&
      totalActiveAcrossCell >= availableDynamicPool
    ) {
      state.throttledCount++;
      return Effect.fail(
        new TenantQuotaExceededError({
          currentValue: totalActiveAcrossCell,
          limitValue: availableDynamicPool,
          message: `Tenant "${tenantId}" burst capacity throttled to preserve guaranteed capacity of co-tenants (cell capacity: ${this.cellCapacity}, reserved for others: ${totalOtherGuaranteed})`,
          quotaType: "CONCURRENCY",
          tenantId,
        })
      );
    }

    // Grant reservation
    state.activeMissions++;
    state.recentRequestTimestamps.push(now);

    const reservation: MissionCapacityReservation = {
      reservationId:
        params.reservationId ??
        `res_${tenantId}_${now}_${Math.random().toString(36).slice(2, 7)}`,
      reservedAt: now,
      status: "ACTIVE",
      tenantId,
    };

    return Effect.succeed(reservation);
  }

  /**
   * Releases an active mission capacity reservation
   */
  releaseMissionCapacity(params: { readonly tenantId: string }): void {
    const state = this.tenantStates.get(params.tenantId);
    if (state && state.activeMissions > 0) {
      state.activeMissions--;
    }
  }

  /**
   * Records transactional spend against finite mission budget (S16)
   */
  recordSpend(params: {
    readonly amountCents: number;
    readonly tenantId: string;
  }): Effect.Effect<number, TenantQuotaExceededError> {
    const { amountCents, tenantId } = params;
    const policy = this.quotaPolicies.get(tenantId);

    if (!policy) {
      return Effect.fail(
        new TenantQuotaExceededError({
          currentValue: 0,
          limitValue: 0,
          message: `Tenant "${tenantId}" has no declared quota policy`,
          quotaType: "BUDGET_EXHAUSTED",
          tenantId,
        })
      );
    }

    const state = this.tenantStates.get(tenantId)!;
    const projectedSpend = state.spendCents + amountCents;

    if (projectedSpend > policy.spendBudgetCents) {
      state.throttledCount++;
      return Effect.fail(
        new TenantQuotaExceededError({
          currentValue: projectedSpend,
          limitValue: policy.spendBudgetCents,
          message: `Tenant "${tenantId}" exceeded transactional budget of ${policy.spendBudgetCents} cents (attempted ${projectedSpend} cents)`,
          quotaType: "BUDGET_EXHAUSTED",
          tenantId,
        })
      );
    }

    state.spendCents = projectedSpend;
    return Effect.succeed(state.spendCents);
  }

  /**
   * Verifies data residency and blocks egress outside authorized geographic regions before transmission (FULL-ACC-050)
   */
  verifyLocalityEgress(params: {
    readonly channel: LocalityChannel;
    readonly targetRegion: string;
    readonly tenantId: string;
  }): Effect.Effect<boolean, RegionalLocalityViolationError> {
    const { channel, targetRegion, tenantId } = params;
    const policy = this.localityPolicies.get(tenantId);

    if (!policy) {
      return Effect.fail(
        new RegionalLocalityViolationError({
          allowedRegions: [],
          attemptedRegion: targetRegion,
          channel,
          message: `Tenant "${tenantId}" has no registered locality policy; external transmission blocked fail-closed`,
          tenantId,
        })
      );
    }

    if (
      policy.enforceStrictLocality &&
      !policy.allowedRegions.includes(targetRegion)
    ) {
      return Effect.fail(
        new RegionalLocalityViolationError({
          allowedRegions: policy.allowedRegions,
          attemptedRegion: targetRegion,
          channel,
          message: `Sovereign locality violation on channel "${channel}": attempted target region "${targetRegion}" is outside allowed boundaries [${policy.allowedRegions.join(", ")}]`,
          tenantId,
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Computes contention, queue, and isolation report for a tenant (S16)
   */
  getContentionReport(tenantId: string): TenantContentionReport {
    const state = this.tenantStates.get(tenantId);
    const policy = this.quotaPolicies.get(tenantId);

    return {
      activeMissions: state ? state.activeMissions : 0,
      guaranteedCapacityPreserved: Boolean(
        policy &&
        state &&
        state.activeMissions <= policy.guaranteedCapacityMissions
      ),
      queuedMissions: 0,
      tenantId,
      throttledCount: state ? state.throttledCount : 0,
      totalSpendCents: state ? state.spendCents : 0,
    };
  }
}
