import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  ClosedObjectModificationDeniedError,
  RoomAccessRevokedError,
} from "../actions-errors.js";
import {
  SurfaceRuntimeService,
  SurfaceRuntimeServiceLive,
} from "./surface-runtime.js";

describe("Surface Runtime & Channel Equivalence (WS07 / S13 / S14)", () => {
  describe("Channel Equivalence (FULL-ACC-036 / OPR-FULL-036)", () => {
    it("does reject modification of closed object via BUTTON channel with ClosedObjectModificationDeniedError", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;
        return yield* service.executeGovernedActionViaChannel({
          actionName: "CLOSE_TICKET",
          channel: "BUTTON",
          isClosed: true,
          objectId: "INCIDENT-404",
          objectStatus: "CLOSED",
          payload: { reason: "Duplicate" },
        });
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(ClosedObjectModificationDeniedError.name);
        expect(causeStr).toContain("INCIDENT-404");
        expect(causeStr).toContain("BUTTON");
      }
    });

    it("does reject modification of closed object via API channel identically to button channel", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;
        return yield* service.executeGovernedActionViaChannel({
          actionName: "UPDATE_STATUS",
          channel: "API",
          isClosed: false,
          objectId: "INCIDENT-404",
          objectStatus: "CLOSED",
          payload: { note: "Direct API write" },
        });
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(ClosedObjectModificationDeniedError.name);
        expect(causeStr).toContain("API");
      }
    });

    it("does reject modification of closed object via AGENT_TOOL channel identically to UI channels", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;
        return yield* service.executeGovernedActionViaChannel({
          actionName: "AUTONOMOUS_RESOLVE",
          channel: "AGENT_TOOL",
          isClosed: true,
          objectId: "INCIDENT-404",
          objectStatus: "ARCHIVED",
          payload: { summary: "Resolved by agent" },
        });
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(ClosedObjectModificationDeniedError.name);
        expect(causeStr).toContain("AGENT_TOOL");
      }
    });

    it("does permit modification via channel when object is open and active", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;
        return yield* service.executeGovernedActionViaChannel({
          actionName: "ASSIGN_SPECIALIST",
          channel: "BUTTON",
          isClosed: false,
          objectId: "INCIDENT-500",
          objectStatus: "OPEN",
          payload: { assignee: "dr-house" },
        });
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.status).toBe("EXECUTED");
      expect(result.channel).toBe("BUTTON");
      expect(result.receiptId).toContain("rec-BUTTON-");
    });
  });

  describe("Room Audience Access & Revocation (FULL-ACC-038 / OPR-FULL-038)", () => {
    it("does grant access to active room members and immediately revoke access upon membership exit", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;

        // Add member
        const member = yield* service.addRoomMember({
          role: "CLINICAL_STAFF",
          roomId: "trauma-bay-1",
          userId: "nurse-joy",
        });
        expect(member.status).toBe("ACTIVE");

        // Verify active access
        const access1 = yield* service.checkRoomAccess(
          "trauma-bay-1",
          "nurse-joy"
        );
        expect(access1.accessible).toBe(true);

        // Revoke membership
        yield* service.revokeRoomMember("trauma-bay-1", "nurse-joy");

        // Verify revoked access fails
        return yield* service.checkRoomAccess("trauma-bay-1", "nurse-joy");
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(RoomAccessRevokedError.name);
        expect(causeStr).toContain("trauma-bay-1");
        expect(causeStr).toContain("nurse-joy");
      }
    });

    it("does fail room access check for users who were never granted membership", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;
        return yield* service.checkRoomAccess(
          "secure-boardroom",
          "unauthorized-guest"
        );
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(RoomAccessRevokedError.name);
      }
    });
  });

  describe("Shadow Proposal Evaluation (ORG-002.T01 / OPR-ORG-002)", () => {
    it("does evaluate shadow proposal with zero committed writes", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;

        return yield* service.evaluateShadowProposal({
          payload: { allocationAmount: 50_000, targetDepartment: "ICU" },
          proposalId: "prop-shadow-budget-01",
          simulation: (payload) =>
            Effect.sync(() => ({
              projectedDifference: {
                budgetRemaining: 150_000,
                delta: payload.allocationAmount,
              },
            })),
        });
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const result = await Effect.runPromise(program);

      expect(result.isShadow).toBe(true);
      expect(result.writesCommitted).toBe(0);
      expect(result.diff).toEqual({
        budgetRemaining: 150_000,
        delta: 50_000,
      });
    });
  });

  describe("Operational Telemetry Indicators (ORG-003.T01 / OPR-ORG-003)", () => {
    it("does compute proposal acceptance rate, override rate, cycle time, and readiness ratio", async () => {
      const program = Effect.gen(function* () {
        const service = yield* SurfaceRuntimeService;

        return yield* service.computeOperationalMetrics([
          {
            durationMs: 120,
            eventType: "PROPOSAL_CREATED",
            readinessPassed: true,
          },
          {
            durationMs: 240,
            eventType: "PROPOSAL_ACCEPTED",
            readinessPassed: true,
          },
          {
            durationMs: 300,
            eventType: "PROPOSAL_CREATED",
            readinessPassed: false,
          },
          {
            durationMs: 180,
            eventType: "OVERRIDE_REJECTED",
            readinessPassed: false,
          },
          {
            durationMs: 160,
            eventType: "PROPOSAL_ACCEPTED",
            readinessPassed: true,
          },
        ]);
      }).pipe(Effect.provide(SurfaceRuntimeServiceLive));

      const metrics = await Effect.runPromise(program);

      expect(metrics.totalProposals).toBe(2);
      expect(metrics.acceptedProposals).toBe(2);
      expect(metrics.rejectedOverrides).toBe(1);
      expect(metrics.overrideRate).toBe(0.5); // 1 / 2
      expect(metrics.readinessRatio).toBe(0.6); // 3 / 5
      expect(metrics.averageCycleTimeMs).toBe(200); // (120 + 240 + 300 + 180 + 160) / 5 = 1000 / 5 = 200
      expect(metrics.calculatedAt).toBeGreaterThan(0);
    });
  });
});
