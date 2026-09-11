import type { LocalityPolicy, TenantQuotaPolicy } from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  RegionalLocalityViolationError,
  TenantQuotaExceededError,
} from "../actions-errors.js";
import { TenantQuotaService } from "./quota-service.js";

describe("V3-06 Tenant Resource Quotas, Operational Economics & Sovereign Locality (S16, OPR-FULL-048, OPR-FULL-050)", () => {
  it("FULL-ACC-048.T01: throttles bursting tenant A while preserving measured guaranteed capacity of co-tenant B", async () => {
    // Total cell capacity = 10 missions
    const service = new TenantQuotaService({ totalCellCapacity: 10 });

    const tenantAPolicy: TenantQuotaPolicy = {
      guaranteedCapacityMissions: 2,
      maxConcurrentMissions: 10,
      maxRatePerMinute: 60,
      spendBudgetCents: 100_000,
      tenantId: "tenant-A-burst",
    };

    const tenantBPolicy: TenantQuotaPolicy = {
      guaranteedCapacityMissions: 4,
      maxConcurrentMissions: 5,
      maxRatePerMinute: 60,
      spendBudgetCents: 50_000,
      tenantId: "tenant-B-guaranteed",
    };

    const defaultLocality: LocalityPolicy = {
      allowedRegions: ["us-east-1"],
      enforceStrictLocality: false,
      tenantId: "default",
    };

    service.registerTenant(tenantAPolicy, {
      ...defaultLocality,
      tenantId: "tenant-A-burst",
    });
    service.registerTenant(tenantBPolicy, {
      ...defaultLocality,
      tenantId: "tenant-B-guaranteed",
    });

    // Cell capacity = 10. Tenant B has 4 guaranteed. Tenant A can only burst up to 10 - 4 = 6.
    // Tenant A attempts to acquire 7 missions in parallel.
    const tenantAResults = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        Effect.runPromiseExit(
          service.reserveMissionCapacity({
            reservationId: `res-A-${i}`,
            tenantId: "tenant-A-burst",
          })
        )
      )
    );

    const successfulA = tenantAResults.filter(Exit.isSuccess);
    const failedA = tenantAResults.filter(Exit.isFailure);

    // Tenant A gets exactly 6 (its max without encroaching on Tenant B's guaranteed 4)
    expect(successfulA.length).toBe(6);
    expect(failedA.length).toBe(1);

    // The failure on tenant A is a structured TenantQuotaExceededError with CONCURRENCY
    const failureError = failedA[0]!.cause.reasons.find(
      Cause.isFailReason
    )?.error;
    expect(failureError).toBeInstanceOf(TenantQuotaExceededError);
    expect((failureError as TenantQuotaExceededError).quotaType).toBe(
      "CONCURRENCY"
    );

    // Now Tenant B requests all 4 of its guaranteed capacity missions
    const tenantBResults = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        Effect.runPromiseExit(
          service.reserveMissionCapacity({
            reservationId: `res-B-${i}`,
            tenantId: "tenant-B-guaranteed",
          })
        )
      )
    );

    // Tenant B's guaranteed capacity was completely preserved despite Tenant A's aggressive burst!
    const successfulB = tenantBResults.filter(Exit.isSuccess);
    expect(successfulB.length).toBe(4);
  });

  it("FULL-ACC-048.T02: enforces finite transactional mission spend budget, preventing unbounded spend", async () => {
    const service = new TenantQuotaService();
    const quota: TenantQuotaPolicy = {
      guaranteedCapacityMissions: 1,
      maxConcurrentMissions: 5,
      maxRatePerMinute: 60,
      spendBudgetCents: 500, // 500 cents budget
      tenantId: "tenant-frugal",
    };
    const locality: LocalityPolicy = {
      allowedRegions: ["us-west-2"],
      enforceStrictLocality: false,
      tenantId: "tenant-frugal",
    };

    service.registerTenant(quota, locality);

    // First spend: 300 cents (OK)
    const spend1 = await Effect.runPromise(
      service.recordSpend({ amountCents: 300, tenantId: "tenant-frugal" })
    );
    expect(spend1).toBe(300);

    // Second spend: 150 cents (OK, total 450 cents <= 500 cents)
    const spend2 = await Effect.runPromise(
      service.recordSpend({ amountCents: 150, tenantId: "tenant-frugal" })
    );
    expect(spend2).toBe(450);

    // Third spend: 100 cents (fails: 450 + 100 = 550 > 500)
    const spend3Exit = await Effect.runPromiseExit(
      service.recordSpend({ amountCents: 100, tenantId: "tenant-frugal" })
    );

    expect(Exit.isFailure(spend3Exit)).toBe(true);
    if (Exit.isFailure(spend3Exit)) {
      const err = spend3Exit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(TenantQuotaExceededError);
      expect((err as TenantQuotaExceededError).quotaType).toBe(
        "BUDGET_EXHAUSTED"
      );
      expect((err as TenantQuotaExceededError).limitValue).toBe(500);
      expect((err as TenantQuotaExceededError).currentValue).toBe(550);
    }
  });

  it("FULL-ACC-050.T01: blocks model routing outside permitted geographic regions before data transmission", async () => {
    const service = new TenantQuotaService();
    const quota: TenantQuotaPolicy = {
      guaranteedCapacityMissions: 5,
      maxConcurrentMissions: 10,
      maxRatePerMinute: 100,
      spendBudgetCents: 1_000_000,
      tenantId: "tenant-eu-sovereign",
    };
    const locality: LocalityPolicy = {
      allowedRegions: ["eu-central-1", "eu-west-1"],
      enforceStrictLocality: true,
      tenantId: "tenant-eu-sovereign",
    };

    service.registerTenant(quota, locality);

    // Within authorized boundary: OK
    const euAllowed = await Effect.runPromise(
      service.verifyLocalityEgress({
        channel: "MODEL_INVOCATION",
        targetRegion: "eu-central-1",
        tenantId: "tenant-eu-sovereign",
      })
    );
    expect(euAllowed).toBe(true);

    // Attempted egress to unauthorized US region: blocked fail-closed before transmission
    const usEgressExit = await Effect.runPromiseExit(
      service.verifyLocalityEgress({
        channel: "MODEL_INVOCATION",
        targetRegion: "us-east-1",
        tenantId: "tenant-eu-sovereign",
      })
    );

    expect(Exit.isFailure(usEgressExit)).toBe(true);
    if (Exit.isFailure(usEgressExit)) {
      const err = usEgressExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(RegionalLocalityViolationError);
      expect((err as RegionalLocalityViolationError).channel).toBe(
        "MODEL_INVOCATION"
      );
      expect((err as RegionalLocalityViolationError).attemptedRegion).toBe(
        "us-east-1"
      );
      expect((err as RegionalLocalityViolationError).allowedRegions).toEqual([
        "eu-central-1",
        "eu-west-1",
      ]);
    }
  });

  it("FULL-ACC-050.T02: strictly blocks log export, backup transfer, and artifact distribution outside authorized regions", async () => {
    const service = new TenantQuotaService();
    const quota: TenantQuotaPolicy = {
      guaranteedCapacityMissions: 1,
      maxConcurrentMissions: 5,
      maxRatePerMinute: 10,
      spendBudgetCents: 10_000,
      tenantId: "tenant-swiss-bank",
    };
    const locality: LocalityPolicy = {
      allowedRegions: ["ch-zurich-1"],
      enforceStrictLocality: true,
      tenantId: "tenant-swiss-bank",
    };

    service.registerTenant(quota, locality);

    const channels = [
      "LOG_EXPORT",
      "BACKUP_TRANSFER",
      "ARTIFACT_EGRESS",
    ] as const;

    const blockedExits = await Promise.all(
      channels.map((channel) =>
        Effect.runPromiseExit(
          service.verifyLocalityEgress({
            channel,
            targetRegion: "ap-southeast-1",
            tenantId: "tenant-swiss-bank",
          })
        )
      )
    );

    for (const exit of blockedExits) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(RegionalLocalityViolationError);
        expect((err as RegionalLocalityViolationError).attemptedRegion).toBe(
          "ap-southeast-1"
        );
      }
    }
  });

  it("FULL-ACC-050.T03: records contention report with active missions, throttled count, and verified capacity isolation", async () => {
    const service = new TenantQuotaService({ totalCellCapacity: 5 });
    const quota: TenantQuotaPolicy = {
      guaranteedCapacityMissions: 2,
      maxConcurrentMissions: 3,
      maxRatePerMinute: 10,
      spendBudgetCents: 10_000,
      tenantId: "tenant-reporting-test",
    };
    const locality: LocalityPolicy = {
      allowedRegions: ["us-east-1"],
      enforceStrictLocality: false,
      tenantId: "tenant-reporting-test",
    };

    service.registerTenant(quota, locality);

    // Acquire 2 missions
    await Effect.runPromise(
      service.reserveMissionCapacity({
        reservationId: "r1",
        tenantId: "tenant-reporting-test",
      })
    );
    await Effect.runPromise(
      service.reserveMissionCapacity({
        reservationId: "r2",
        tenantId: "tenant-reporting-test",
      })
    );

    // Record some spend
    await Effect.runPromise(
      service.recordSpend({
        amountCents: 450,
        tenantId: "tenant-reporting-test",
      })
    );

    const report = service.getContentionReport("tenant-reporting-test");

    expect(report.tenantId).toBe("tenant-reporting-test");
    expect(report.activeMissions).toBe(2);
    expect(report.guaranteedCapacityPreserved).toBe(true);
    expect(report.totalSpendCents).toBe(450);
    expect(report.throttledCount).toBe(0);

    // Release 1 mission
    service.releaseMissionCapacity({ tenantId: "tenant-reporting-test" });
    const updatedReport = service.getContentionReport("tenant-reporting-test");
    expect(updatedReport.activeMissions).toBe(1);
  });
});
