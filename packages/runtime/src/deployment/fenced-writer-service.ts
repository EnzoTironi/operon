import { randomUUID } from "node:crypto";

import type {
  DeploymentConfiguration,
  FencedEffectReceipt,
  WriterFencingLease,
} from "@operon/schema";
import { Effect } from "effect";

import {
  ProductionInMemoryAuthorityForbiddenError,
  ProductionSimulatedDispatcherForbiddenError,
  ProductionTenantInvalidError,
  SplitBrainWriterFencedError,
} from "../actions-errors.js";

/**
 * Validates a deployment configuration profile (S16)
 * Strictly enforces that production profiles never use in-memory authority, simulated dispatchers, or test tenants.
 */
export function validateDeploymentConfiguration(
  config: DeploymentConfiguration
): Effect.Effect<
  void,
  | ProductionInMemoryAuthorityForbiddenError
  | ProductionSimulatedDispatcherForbiddenError
  | ProductionTenantInvalidError
> {
  const isProduction =
    config.profile === "REFERENCE_PRODUCTION_CELL" ||
    config.profile === "DEDICATED_SOVEREIGN";

  if (!isProduction) {
    return Effect.void;
  }

  if (config.authorityMode === "IN_MEMORY") {
    return Effect.fail(
      new ProductionInMemoryAuthorityForbiddenError({
        message: `Production profile "${config.profile}" cannot use IN_MEMORY authority mode`,
        profile: config.profile,
        tenantId: config.tenantId,
      })
    );
  }

  if (config.simulatedDispatcher) {
    return Effect.fail(
      new ProductionSimulatedDispatcherForbiddenError({
        message: `Production profile "${config.profile}" cannot use simulated dispatchers`,
        profile: config.profile,
        tenantId: config.tenantId,
      })
    );
  }

  const isTestOrMissingTenant =
    !config.tenantId ||
    config.tenantId.trim() === "" ||
    config.tenantId === "default" ||
    config.tenantId.toLowerCase().includes("test");

  if (isTestOrMissingTenant) {
    return Effect.fail(
      new ProductionTenantInvalidError({
        message: `Production profile "${config.profile}" requires an explicit production tenant ID`,
        profile: config.profile,
        tenantId: config.tenantId,
      })
    );
  }

  return Effect.void;
}

/**
 * FencedWriterService (S16, OPR-FULL-047, FULL-ACC-047):
 * Manages monotonic fencing tokens and writer leases across failover,
 * ensuring only the holder of the active fence token can dispatch new effects.
 */
export class FencedWriterService {
  private readonly activeLeases = new Map<string, WriterFencingLease>();
  private readonly fencingCounters = new Map<string, number>();

  /**
   * Clears state for clean test runs
   */
  reset(): void {
    this.activeLeases.clear();
    this.fencingCounters.clear();
  }

  /**
   * Claims writer authority for a process, assigning a monotonically increasing fencing token (OPR-FULL-047)
   */
  claimWriterLease(
    tenantId: string,
    processId: string,
    ttlMs = 5000
  ): Effect.Effect<WriterFencingLease, never> {
    const currentToken = this.fencingCounters.get(tenantId) ?? 0;
    const nextToken = currentToken + 1;
    this.fencingCounters.set(tenantId, nextToken);

    const now = Date.now();
    const lease: WriterFencingLease = {
      acquiredAt: now,
      epoch: now,
      fencingToken: nextToken,
      holderProcessId: processId,
      leaseExpiresAt: now + ttlMs,
      tenantId,
    };

    this.activeLeases.set(tenantId, lease);
    return Effect.succeed(lease);
  }

  /**
   * Renews an active writer lease
   * Fails with SplitBrainWriterFencedError if superseded by a newer process with a higher token.
   */
  renewWriterLease(
    lease: WriterFencingLease,
    extensionMs = 5000
  ): Effect.Effect<WriterFencingLease, SplitBrainWriterFencedError> {
    const active = this.activeLeases.get(lease.tenantId);

    if (
      !active ||
      active.fencingToken > lease.fencingToken ||
      active.holderProcessId !== lease.holderProcessId
    ) {
      return Effect.fail(
        new SplitBrainWriterFencedError({
          activeFenceToken: active?.fencingToken ?? 0,
          currentHolderProcessId: active?.holderProcessId ?? "none",
          message: `Lease renewal rejected: process "${lease.holderProcessId}" with token ${lease.fencingToken} was superseded by active process "${active?.holderProcessId}" with token ${active?.fencingToken}`,
          presentedFenceToken: lease.fencingToken,
          rejectedProcessId: lease.holderProcessId,
          tenantId: lease.tenantId,
        })
      );
    }

    const now = Date.now();
    const renewed: WriterFencingLease = {
      ...active,
      leaseExpiresAt: now + extensionMs,
    };

    this.activeLeases.set(lease.tenantId, renewed);
    return Effect.succeed(renewed);
  }

  /**
   * Dispatches an effect only if the presented fencing token matches the active lease (FULL-ACC-047)
   * If an older/superseded process attempts dispatch, it is fenced out with SplitBrainWriterFencedError.
   */
  dispatchFencedEffect<A, E, R>(
    tenantId: string,
    processId: string,
    presentedToken: number,
    effectFn: () => Effect.Effect<A, E, R>
  ): Effect.Effect<
    { readonly receipt: FencedEffectReceipt; readonly result: A },
    E | SplitBrainWriterFencedError,
    R
  > {
    const active = this.activeLeases.get(tenantId);

    if (
      !active ||
      active.fencingToken !== presentedToken ||
      active.holderProcessId !== processId
    ) {
      return Effect.fail(
        new SplitBrainWriterFencedError({
          activeFenceToken: active?.fencingToken ?? 0,
          currentHolderProcessId: active?.holderProcessId ?? "none",
          message: `Effect dispatch rejected: process "${processId}" with token ${presentedToken} is fenced out by active holder "${active?.holderProcessId}" with token ${active?.fencingToken}`,
          presentedFenceToken: presentedToken,
          rejectedProcessId: processId,
          tenantId,
        })
      );
    }

    return Effect.gen(function* () {
      const result = yield* effectFn();
      const receipt: FencedEffectReceipt = {
        dispatchedAt: new Date().toISOString(),
        effectId: `effect-${randomUUID()}`,
        fencingToken: presentedToken,
        processId,
        status: "DISPATCHED",
        tenantId,
      };

      return { receipt, result };
    });
  }
}
