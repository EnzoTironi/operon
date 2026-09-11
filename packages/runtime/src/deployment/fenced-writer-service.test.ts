import type { DeploymentConfiguration } from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ProductionInMemoryAuthorityForbiddenError,
  ProductionSimulatedDispatcherForbiddenError,
  ProductionTenantInvalidError,
  SplitBrainWriterFencedError,
} from "../actions-errors.js";
import {
  FencedWriterService,
  validateDeploymentConfiguration,
} from "./fenced-writer-service.js";

describe("FencedWriterService & Deployment Profiles (S16, OPR-FULL-047, FULL-ACC-047)", () => {
  const service = new FencedWriterService();

  beforeEach(() => {
    service.reset();
  });

  describe("Split-Brain Dual-Writer Resolution & Fencing (OPR-FULL-047, FULL-ACC-047)", () => {
    it("FULL-ACC-047.T01: only the active fence token holder dispatches effects; superseded process fails with SplitBrainWriterFencedError", async () => {
      const tenantId = "tenant-hospital-metro";

      // 1. Process A acquires writer lease (Token 1)
      const leaseA = await Effect.runPromise(
        service.claimWriterLease(tenantId, "process-node-worker-a")
      );
      expect(leaseA.fencingToken).toBe(1);
      expect(leaseA.holderProcessId).toBe("process-node-worker-a");

      // 2. Failover occurs: Process B acquires writer lease (Token 2)
      const leaseB = await Effect.runPromise(
        service.claimWriterLease(tenantId, "process-node-worker-b")
      );
      expect(leaseB.fencingToken).toBe(2);
      expect(leaseB.holderProcessId).toBe("process-node-worker-b");

      // 3. Process B (active fence holder) dispatches an effect -> SUCCEEDS
      const dispatchB = await Effect.runPromise(
        service.dispatchFencedEffect(
          tenantId,
          "process-node-worker-b",
          leaseB.fencingToken,
          () =>
            Effect.succeed({
              committedState: "ORDER_FULFILLED",
              unitsDispatched: 10,
            })
        )
      );

      expect(dispatchB.receipt.status).toBe("DISPATCHED");
      expect(dispatchB.receipt.fencingToken).toBe(2);
      expect(dispatchB.receipt.processId).toBe("process-node-worker-b");
      expect(dispatchB.result.committedState).toBe("ORDER_FULFILLED");

      // 4. Process A (stale zombie process) attempts to dispatch with Token 1 -> FAILS with SplitBrainWriterFencedError
      let sideEffectExecuted = false;
      const dispatchAExit = await Effect.runPromiseExit(
        service.dispatchFencedEffect(
          tenantId,
          "process-node-worker-a",
          leaseA.fencingToken,
          () => {
            sideEffectExecuted = true;
            return Effect.succeed({ committedState: "ORDER_STALE_WRITE" });
          }
        )
      );

      // Verify side effect was completely prevented
      expect(sideEffectExecuted).toBe(false);
      expect(Exit.isFailure(dispatchAExit)).toBe(true);

      if (Exit.isFailure(dispatchAExit)) {
        const failReason = dispatchAExit.cause.reasons.find(Cause.isFailReason);
        const err = failReason?.error;
        expect(err).toBeInstanceOf(SplitBrainWriterFencedError);
        if (err instanceof SplitBrainWriterFencedError) {
          expect(err._tag).toBe("SplitBrainWriterFencedError");
          expect(err.activeFenceToken).toBe(2);
          expect(err.presentedFenceToken).toBe(1);
          expect(err.rejectedProcessId).toBe("process-node-worker-a");
          expect(err.currentHolderProcessId).toBe("process-node-worker-b");
        }
      }
    });

    it("FULL-ACC-047.T02: active fence holder can renew lease; superseded process renewal fails with SplitBrainWriterFencedError", async () => {
      const tenantId = "tenant-logistics-corp";

      const leaseA = await Effect.runPromise(
        service.claimWriterLease(tenantId, "process-1")
      );
      const leaseB = await Effect.runPromise(
        service.claimWriterLease(tenantId, "process-2")
      );

      // Process B renewal succeeds
      const renewedB = await Effect.runPromise(
        service.renewWriterLease(leaseB, 10000)
      );
      expect(renewedB.holderProcessId).toBe("process-2");
      expect(renewedB.fencingToken).toBe(2);

      // Process A renewal fails
      const renewalAExit = await Effect.runPromiseExit(
        service.renewWriterLease(leaseA, 10000)
      );

      expect(Exit.isFailure(renewalAExit)).toBe(true);
      if (Exit.isFailure(renewalAExit)) {
        const failReason = renewalAExit.cause.reasons.find(Cause.isFailReason);
        expect(failReason?.error).toBeInstanceOf(SplitBrainWriterFencedError);
      }
    });
  });

  describe("Sovereign Deployment Profile Startup Constraints (S16)", () => {
    it("FULL-ACC-047.T03: reference production cell profile rejects IN_MEMORY authority mode", async () => {
      const prodConfig: DeploymentConfiguration = {
        authorityMode: "IN_MEMORY",
        environmentId: "prod-cell-eu-1",
        profile: "REFERENCE_PRODUCTION_CELL",
        simulatedDispatcher: false,
        storageEngine: "POSTGRESQL",
        tenantId: "tenant-enterprise-live",
        unsupportedGuarantees: [],
      };

      const exit = await Effect.runPromiseExit(
        validateDeploymentConfiguration(prodConfig)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find(Cause.isFailReason);
        expect(failReason?.error).toBeInstanceOf(
          ProductionInMemoryAuthorityForbiddenError
        );
      }
    });

    it("FULL-ACC-047.T04: dedicated sovereign profile rejects simulated dispatchers", async () => {
      const sovereignConfig: DeploymentConfiguration = {
        authorityMode: "DISTRIBUTED_FENCED",
        environmentId: "sovereign-airgap-1",
        profile: "DEDICATED_SOVEREIGN",
        simulatedDispatcher: true, // Prohibited in sovereign/production profile
        storageEngine: "POSTGRESQL",
        tenantId: "tenant-defense-health",
        unsupportedGuarantees: [],
      };

      const exit = await Effect.runPromiseExit(
        validateDeploymentConfiguration(sovereignConfig)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find(Cause.isFailReason);
        expect(failReason?.error).toBeInstanceOf(
          ProductionSimulatedDispatcherForbiddenError
        );
      }
    });

    it("FULL-ACC-047.T04b: reference production cell profile rejects test/missing tenant IDs", async () => {
      const testTenantConfig: DeploymentConfiguration = {
        authorityMode: "DISTRIBUTED_FENCED",
        environmentId: "prod-cell-eu-1",
        profile: "REFERENCE_PRODUCTION_CELL",
        simulatedDispatcher: false,
        storageEngine: "POSTGRESQL",
        tenantId: "default", // Invalid for production cell
        unsupportedGuarantees: [],
      };

      const exit = await Effect.runPromiseExit(
        validateDeploymentConfiguration(testTenantConfig)
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find(Cause.isFailReason);
        expect(failReason?.error).toBeInstanceOf(ProductionTenantInvalidError);
      }
    });

    it("FULL-ACC-047.T05: local demo profile permits in-memory authority and simulated dispatchers", async () => {
      const demoConfig: DeploymentConfiguration = {
        authorityMode: "IN_MEMORY",
        environmentId: "demo-env",
        profile: "LOCAL_DEMO",
        simulatedDispatcher: true,
        storageEngine: "MEMORY",
        tenantId: "default",
        unsupportedGuarantees: ["DISTRIBUTED_FAILOVER"],
      };

      const result = await Effect.runPromise(
        validateDeploymentConfiguration(demoConfig)
      );

      expect(result).toBeUndefined(); // Void effect succeeded
    });
  });
});
