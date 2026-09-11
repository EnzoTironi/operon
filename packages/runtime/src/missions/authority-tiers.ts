import type {
  AuthorityTier,
  CalibrationEvidence,
  DemotionEvent,
  ExecutionActorRecord,
  RiskBand,
  TaskMandateEnvelope,
} from "@operon/schema";
import { isObjectInSet, isRiskBandAllowed } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Clock, Context, Effect, Layer } from "effect";

import {
  BudgetExhaustedError,
  EnvelopeViolationError,
  MandateExpiredError,
  TierAuthorityExceededError,
  UnjustifiedPromotionError,
} from "../actions-errors.js";

export type OperationType =
  | "read"
  | "propose"
  | "approve"
  | "execute"
  | "administer";

export interface InvocationEnvelopeCheck {
  readonly actionClass: string;
  readonly targetObjectId: string;
  readonly riskBand: RiskBand;
  readonly requestedBudgetUnits: number;
  readonly now?: number;
}

export interface DemotionOutcome {
  readonly updatedMandate: TaskMandateEnvelope;
  readonly demotionEvent: DemotionEvent;
}

export interface Tier2ExecutionParams {
  readonly humanReviewerId: string;
  readonly agentProposerId: string;
  readonly proposalId: string;
  readonly confirmedAt?: number;
}

export interface Tier3ExecutionParams {
  readonly executingAgentId: string;
  readonly humanApproverId: string;
  readonly approvalId: string;
  readonly confirmedAt?: number;
}

export interface Tier4ExecutionParams {
  readonly executingAgentId: string;
  readonly mandateId: string;
  readonly riskBand: RiskBand;
  readonly confirmedAt?: number;
}

/**
 * Service managing the four interaction modes and authority tiers (S12 / OPR-AGT-001, OPR-AGT-002)
 */
export class AuthorityTierService extends Context.Service<
  AuthorityTierService,
  {
    readonly checkOperationPermitted: (
      tier: AuthorityTier,
      op: OperationType
    ) => Effect.Effect<void, TierAuthorityExceededError>;

    readonly validateMandateEnvelope: (
      mandate: TaskMandateEnvelope,
      invocation: InvocationEnvelopeCheck
    ) => Effect.Effect<
      void,
      EnvelopeViolationError | BudgetExhaustedError | MandateExpiredError
    >;

    readonly promoteTier: (
      mandate: TaskMandateEnvelope,
      targetTier: AuthorityTier,
      evidence?: CalibrationEvidence
    ) => Effect.Effect<TaskMandateEnvelope, UnjustifiedPromotionError>;

    readonly demoteTier: (
      mandate: TaskMandateEnvelope,
      targetTier: AuthorityTier,
      reason: string,
      violationsCount: number
    ) => Effect.Effect<DemotionOutcome, never>;

    readonly recordExecutionActor: (
      params:
        | ({ readonly mode: "TIER_2_HUMAN" } & Tier2ExecutionParams)
        | ({ readonly mode: "TIER_3_APPROVED_AGENT" } & Tier3ExecutionParams)
        | ({ readonly mode: "TIER_4_AUTONOMOUS_AGENT" } & Tier4ExecutionParams)
    ) => Effect.Effect<ExecutionActorRecord, TierAuthorityExceededError>;
  }
>()("operon/runtime/AuthorityTierService") {}

export const AuthorityTierServiceLive = Layer.succeed(
  AuthorityTierService,
  AuthorityTierService.of({
    checkOperationPermitted: Effect.fn(
      "AuthorityTierService.checkOperationPermitted"
    )(function* (tier: AuthorityTier, op: OperationType) {
      switch (tier) {
        case "TIER_1_OBSERVE": {
          if (op !== "read") {
            return yield* new TierAuthorityExceededError({
              attemptedOperation: op,
              message: `Tier 1 (Observe) is read-only; operation '${op}' is forbidden`,
              tier,
            });
          }
          break;
        }
        case "TIER_2_PROPOSE": {
          if (op !== "read" && op !== "propose") {
            return yield* new TierAuthorityExceededError({
              attemptedOperation: op,
              message: `Tier 2 (Propose) can only read or propose; operation '${op}' is forbidden for agent`,
              tier,
            });
          }
          break;
        }
        case "TIER_3_EXECUTE_WITH_APPROVAL": {
          if (op === "approve" || op === "administer") {
            return yield* new TierAuthorityExceededError({
              attemptedOperation: op,
              message: `Tier 3 (Execute with Approval) agent cannot approve its own actions or administer`,
              tier,
            });
          }
          break;
        }
        case "TIER_4_BOUNDED_AUTONOMY": {
          if (op === "approve" || op === "administer") {
            return yield* new TierAuthorityExceededError({
              attemptedOperation: op,
              message: `Tier 4 (Bounded Autonomy) agent cannot approve policy or administer`,
              tier,
            });
          }
          break;
        }
        default: {
          break;
        }
      }
    }),

    validateMandateEnvelope: Effect.fn(
      "AuthorityTierService.validateMandateEnvelope"
    )(function* (
      mandate: TaskMandateEnvelope,
      invocation: InvocationEnvelopeCheck
    ) {
      const now = invocation.now ?? (yield* Clock.currentTimeMillis);

      // 1. Check expiration
      if (now > mandate.expiresAt) {
        return yield* new MandateExpiredError({
          attemptedAt: now,
          expiresAt: mandate.expiresAt,
          mandateId: mandate.mandateId,
          message: `TaskMandate '${mandate.mandateId}' expired at ${mandate.expiresAt} (attempted at ${now})`,
        });
      }

      // 2. Check allowed action class
      if (!mandate.allowedActionClasses.includes(invocation.actionClass)) {
        return yield* new EnvelopeViolationError({
          details: `Action class '${invocation.actionClass}' is not in allowed classes: [${mandate.allowedActionClasses.join(", ")}]`,
          mandateId: mandate.mandateId,
          message: `Action class violation for mandate '${mandate.mandateId}': actionClass '${invocation.actionClass}' not allowed`,
          violationType: "actionClass",
        });
      }

      // 3. Check object set containment
      if (!isObjectInSet(mandate.objectSet, invocation.targetObjectId)) {
        return yield* new EnvelopeViolationError({
          details: `Target object '${invocation.targetObjectId}' is outside authorized object set: [${mandate.objectSet.join(", ")}]`,
          mandateId: mandate.mandateId,
          message: `Object set violation for mandate '${mandate.mandateId}': objectSet '${invocation.targetObjectId}' not authorized`,
          violationType: "objectSet",
        });
      }

      // 4. Check risk band bounds
      if (!isRiskBandAllowed(mandate.maxRiskBand, invocation.riskBand)) {
        return yield* new EnvelopeViolationError({
          details: `Requested risk band '${invocation.riskBand}' exceeds mandate maximum risk band '${mandate.maxRiskBand}'`,
          mandateId: mandate.mandateId,
          message: `Risk band violation for mandate '${mandate.mandateId}': riskBand '${invocation.riskBand}' exceeds maximum`,
          violationType: "riskBand",
        });
      }

      // 5. Check budget limit
      const totalProjected =
        mandate.spentBudget + invocation.requestedBudgetUnits;
      if (totalProjected > mandate.budgetLimit) {
        return yield* new BudgetExhaustedError({
          budgetLimit: mandate.budgetLimit,
          mandateId: mandate.mandateId,
          message: `TaskMandate budget exhausted: requesting ${invocation.requestedBudgetUnits} units with ${mandate.spentBudget}/${mandate.budgetLimit} already spent`,
          requestedBudget: invocation.requestedBudgetUnits,
          spentBudget: mandate.spentBudget,
        });
      }
    }),

    promoteTier: Effect.fn("AuthorityTierService.promoteTier")(function* (
      mandate: TaskMandateEnvelope,
      targetTier: AuthorityTier,
      evidence?: CalibrationEvidence
    ) {
      if (targetTier === "TIER_4_BOUNDED_AUTONOMY") {
        if (!evidence) {
          return yield* new UnjustifiedPromotionError({
            mandateId: mandate.mandateId,
            message: `Cannot promote mandate '${mandate.mandateId}' to Tier 4 without valid calibration evidence`,
            reason: "missing_calibration_evidence",
          });
        }

        if (evidence.trialCount < evidence.minimumTrialsRequired) {
          return yield* new UnjustifiedPromotionError({
            mandateId: mandate.mandateId,
            message: `Insufficient calibration trials: ${evidence.trialCount} completed, ${evidence.minimumTrialsRequired} required`,
            reason: "insufficient_trials",
          });
        }

        if (evidence.passRate < 0.95) {
          return yield* new UnjustifiedPromotionError({
            mandateId: mandate.mandateId,
            message: `Calibration pass rate ${(evidence.passRate * 100).toFixed(1)}% is below required 95.0% threshold`,
            reason: "pass_rate_below_threshold",
          });
        }

        if (evidence.safetyViolations > 0) {
          return yield* new UnjustifiedPromotionError({
            mandateId: mandate.mandateId,
            message: `Calibration evidence contains ${evidence.safetyViolations} safety violations (0 required)`,
            reason: "safety_violations_present",
          });
        }
      }

      const updatedMandate: TaskMandateEnvelope = {
        ...mandate,
        tier: targetTier,
      };

      yield* Effect.sync(() => {
        OperonTelemetryService.getInstance().trackEvent({
          event: "operon_agent_promoted",
          properties: {
            mandateId: mandate.mandateId,
            newTier: targetTier,
            previousTier: mandate.tier,
            principalId: mandate.principalId,
          },
        });
      });

      return updatedMandate;
    }),

    demoteTier: Effect.fn("AuthorityTierService.demoteTier")(function* (
      mandate: TaskMandateEnvelope,
      targetTier: AuthorityTier,
      reason: string,
      violationsCount: number
    ) {
      const demotedAt = yield* Clock.currentTimeMillis;
      const demotionEvent: DemotionEvent = {
        agentId: mandate.principalId,
        demotedAt,
        mandateId: mandate.mandateId,
        newTier: targetTier,
        previousTier: mandate.tier,
        reason,
        violationsCount,
      };

      const updatedMandate: TaskMandateEnvelope = {
        ...mandate,
        tier: targetTier,
      };

      yield* Effect.sync(() => {
        OperonTelemetryService.getInstance().trackEvent({
          event: "operon_agent_demoted",
          properties: {
            mandateId: mandate.mandateId,
            newTier: targetTier,
            previousTier: mandate.tier,
            principalId: mandate.principalId,
            reason,
            violationsCount,
          },
        });
      });

      return {
        demotionEvent,
        updatedMandate,
      };
    }),

    recordExecutionActor: Effect.fn(
      "AuthorityTierService.recordExecutionActor"
    )(function* (params) {
      const confirmedAt =
        params.confirmedAt ?? (yield* Clock.currentTimeMillis);

      switch (params.mode) {
        case "TIER_2_HUMAN": {
          if (params.humanReviewerId === params.agentProposerId) {
            return yield* new TierAuthorityExceededError({
              attemptedOperation: "execute",
              message: `Independent review required: human reviewer '${params.humanReviewerId}' cannot be identical to proposer`,
              tier: "TIER_2_PROPOSE",
            });
          }
          const record: ExecutionActorRecord = {
            agentProposerId: params.agentProposerId,
            confirmedAt,
            humanReviewerId: params.humanReviewerId,
            mode: "TIER_2_HUMAN",
            proposalId: params.proposalId,
          };
          return record;
        }
        case "TIER_3_APPROVED_AGENT": {
          if (params.humanApproverId === params.executingAgentId) {
            return yield* new TierAuthorityExceededError({
              attemptedOperation: "execute",
              message: `Self-approval denied: human approver cannot be the executing agent '${params.executingAgentId}'`,
              tier: "TIER_3_EXECUTE_WITH_APPROVAL",
            });
          }
          const record: ExecutionActorRecord = {
            approvalId: params.approvalId,
            confirmedAt,
            executingAgentId: params.executingAgentId,
            humanApproverId: params.humanApproverId,
            mode: "TIER_3_APPROVED_AGENT",
          };
          return record;
        }
        case "TIER_4_AUTONOMOUS_AGENT": {
          const record: ExecutionActorRecord = {
            confirmedAt,
            executingAgentId: params.executingAgentId,
            mandateId: params.mandateId,
            mode: "TIER_4_AUTONOMOUS_AGENT",
            riskBand: params.riskBand,
          };
          return record;
        }
        default: {
          const _exhaustive: never = params;
          return yield* new TierAuthorityExceededError({
            attemptedOperation: "execute",
            message: `Unknown execution actor mode: ${String(_exhaustive)}`,
            tier: "TIER_1_OBSERVE",
          });
        }
      }
    }),
  })
);
