import type {
  OperationalMetricsRecord,
  RoomAudienceMembership,
} from "@operon/schema";
import { Clock, Context, Effect, Layer } from "effect";

import {
  ClosedObjectModificationDeniedError,
  RoomAccessRevokedError,
} from "../actions-errors.js";

/**
 * Service governing channel equivalence, room audience membership, and surface runtime telemetry (OPR-FULL-036, 038, OPR-ORG-002, 003)
 */
export class SurfaceRuntimeService extends Context.Service<
  SurfaceRuntimeService,
  {
    readonly addRoomMember: (params: {
      readonly role: string;
      readonly roomId: string;
      readonly userId: string;
    }) => Effect.Effect<RoomAudienceMembership, never>;

    readonly checkRoomAccess: (
      roomId: string,
      userId: string
    ) => Effect.Effect<{ readonly accessible: true }, RoomAccessRevokedError>;

    readonly computeOperationalMetrics: (
      events: readonly {
        readonly durationMs?: number;
        readonly eventType:
          | "PROPOSAL_ACCEPTED"
          | "PROPOSAL_CREATED"
          | "OVERRIDE_REJECTED";
        readonly readinessPassed?: boolean;
      }[]
    ) => Effect.Effect<OperationalMetricsRecord, never>;

    readonly evaluateShadowProposal: (params: {
      readonly payload: Record<string, unknown>;
      readonly proposalId: string;
      readonly simulation: (
        payload: Record<string, unknown>
      ) => Effect.Effect<
        { readonly projectedDifference: Record<string, unknown> },
        never
      >;
    }) => Effect.Effect<
      {
        readonly diff: Record<string, unknown>;
        readonly isShadow: true;
        readonly writesCommitted: 0;
      },
      never
    >;

    readonly executeGovernedActionViaChannel: (params: {
      readonly actionName: string;
      readonly channel: "API" | "AGENT_TOOL" | "BUTTON";
      readonly isClosed?: boolean;
      readonly objectId: string;
      readonly objectStatus: string;
      readonly payload: Record<string, unknown>;
    }) => Effect.Effect<
      {
        readonly channel: "API" | "AGENT_TOOL" | "BUTTON";
        readonly receiptId: string;
        readonly status: "EXECUTED";
      },
      ClosedObjectModificationDeniedError
    >;

    readonly revokeRoomMember: (
      roomId: string,
      userId: string
    ) => Effect.Effect<void, never>;
  }
>()("operon/runtime/SurfaceRuntimeService") {}

interface OperationalEvent {
  readonly durationMs?: number;
  readonly eventType:
    | "PROPOSAL_ACCEPTED"
    | "PROPOSAL_CREATED"
    | "OVERRIDE_REJECTED";
  readonly readinessPassed?: boolean;
}

function membershipKey(roomId: string, userId: string): string {
  return `${roomId}::${userId}`;
}

function countProposalStats(events: readonly OperationalEvent[]) {
  let totalProposals = 0;
  let acceptedProposals = 0;
  let rejectedOverrides = 0;
  for (const ev of events) {
    if (ev.eventType === "PROPOSAL_CREATED") {
      totalProposals++;
    } else if (ev.eventType === "PROPOSAL_ACCEPTED") {
      acceptedProposals++;
    } else if (ev.eventType === "OVERRIDE_REJECTED") {
      rejectedOverrides++;
    }
  }
  return { acceptedProposals, rejectedOverrides, totalProposals };
}

function calculateAverageDuration(events: readonly OperationalEvent[]) {
  let totalDuration = 0;
  let durationCount = 0;
  for (const ev of events) {
    if (ev.durationMs !== undefined) {
      totalDuration += ev.durationMs;
      durationCount++;
    }
  }
  return durationCount > 0 ? totalDuration / durationCount : 0;
}

function calculateReadinessRatio(events: readonly OperationalEvent[]) {
  let readinessPassCount = 0;
  let readinessTotal = 0;
  for (const ev of events) {
    if (ev.readinessPassed !== undefined) {
      readinessTotal++;
      if (ev.readinessPassed) {
        readinessPassCount++;
      }
    }
  }
  return readinessTotal > 0 ? readinessPassCount / readinessTotal : 1;
}

function aggregateOperationalCounts(events: readonly OperationalEvent[]) {
  const { acceptedProposals, rejectedOverrides, totalProposals } =
    countProposalStats(events);
  const averageCycleTimeMs = calculateAverageDuration(events);
  const readinessRatio = calculateReadinessRatio(events);

  return {
    acceptedProposals,
    averageCycleTimeMs,
    overrideRate: totalProposals > 0 ? rejectedOverrides / totalProposals : 0,
    readinessRatio,
    rejectedOverrides,
    totalProposals,
  };
}

/**
 * Live layer for SurfaceRuntimeService
 */
export const SurfaceRuntimeServiceLive = Layer.sync(
  SurfaceRuntimeService,
  () => {
    const memberships = new Map<string, RoomAudienceMembership>();
    const surfaceCache = new Map<string, unknown>();

    return SurfaceRuntimeService.of({
      addRoomMember: Effect.fn("SurfaceRuntimeService.addRoomMember")(
        function* (params) {
          const now = yield* Clock.currentTimeMillis;
          const key = membershipKey(params.roomId, params.userId);
          const member: RoomAudienceMembership = {
            joinedAt: now,
            membershipId: `mem-${now}`,
            role: params.role,
            roomId: params.roomId,
            status: "ACTIVE",
            userId: params.userId,
          };
          memberships.set(key, member);
          return member;
        }
      ),

      checkRoomAccess: Effect.fn("SurfaceRuntimeService.checkRoomAccess")(
        function* (roomId: string, userId: string) {
          const key = membershipKey(roomId, userId);
          const member = memberships.get(key);

          if (!member || member.status === "REVOKED") {
            const revokedAt =
              member?.revokedAt ?? (yield* Clock.currentTimeMillis);
            return yield* new RoomAccessRevokedError({
              message: `User '${userId}' does not have active access to room '${roomId}'. Access was revoked or not granted.`,
              revokedAt,
              roomId,
              userId,
            });
          }

          return { accessible: true };
        }
      ),

      computeOperationalMetrics: Effect.fn(
        "SurfaceRuntimeService.computeOperationalMetrics"
      )(function* (events) {
        const counts = aggregateOperationalCounts(events);
        const now = yield* Clock.currentTimeMillis;
        return {
          ...counts,
          calculatedAt: now,
        };
      }),

      evaluateShadowProposal: Effect.fn(
        "SurfaceRuntimeService.evaluateShadowProposal"
      )(function* (params) {
        const result = yield* params.simulation(params.payload);
        return {
          diff: result.projectedDifference,
          isShadow: true,
          writesCommitted: 0,
        };
      }),

      executeGovernedActionViaChannel: Effect.fn(
        "SurfaceRuntimeService.executeGovernedActionViaChannel"
      )(function* (params) {
        const { actionName, channel, isClosed, objectId, objectStatus } =
          params;

        // OPR-FULL-036 / FULL-ACC-036:
        // When a rule prohibits altering a closed object, Button, API, and Agent all receive identical rejection!
        if (isClosed || objectStatus.toUpperCase() === "CLOSED") {
          return yield* new ClosedObjectModificationDeniedError({
            actionName,
            channel,
            message: `Channel '${channel}' denied: modification on closed object '${objectId}' prohibited by kernel rules`,
            objectId,
            objectStatus,
          });
        }

        const now = yield* Clock.currentTimeMillis;
        return {
          channel,
          receiptId: `rec-${channel}-${now}`,
          status: "EXECUTED",
        };
      }),

      revokeRoomMember: Effect.fn("SurfaceRuntimeService.revokeRoomMember")(
        function* (roomId: string, userId: string) {
          const key = membershipKey(roomId, userId);
          const current = memberships.get(key);
          if (current) {
            const now = yield* Clock.currentTimeMillis;
            memberships.set(key, {
              ...current,
              revokedAt: now,
              status: "REVOKED",
            });
          }
          // Invalidate any cached derived surfaces for this user and room (OPR-FULL-038)
          for (const cacheKey of surfaceCache.keys()) {
            if (cacheKey.startsWith(`${roomId}::`)) {
              surfaceCache.delete(cacheKey);
            }
          }
        }
      ),
    });
  }
);
