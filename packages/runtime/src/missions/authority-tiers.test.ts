import type { CalibrationEvidence, TaskMandateEnvelope } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AuthorityTierService,
  AuthorityTierServiceLive,
} from "./authority-tiers.js";

const sampleMandate: TaskMandateEnvelope = {
  allowedActionClasses: ["prescribe_medication", "adjust_dosage"],
  budgetLimit: 100,
  expiresAt: Date.now() + 3_600_000,
  mandateId: "mandate_cardio_01",
  maxRiskBand: "MEDIUM",
  objectSet: ["Patient:P001", "Order:*"],
  principalId: "agent_cardiology_007",
  spentBudget: 20,
  tier: "TIER_2_PROPOSE",
};

describe("AuthorityTierService (V2-01 / OPR-AGT-001, OPR-AGT-002)", () => {
  describe("AGT-001.T01: Exercise every tier against read, propose, approve, execute, and administer operations", () => {
    it("permits only read operations in Tier 1 (Observe)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        // Read permitted
        yield* service.checkOperationPermitted("TIER_1_OBSERVE", "read");

        // Propose forbidden
        const proposeExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_1_OBSERVE", "propose")
        );
        expect(proposeExit._tag).toBe("Failure");

        // Execute forbidden
        const execExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_1_OBSERVE", "execute")
        );
        expect(execExit._tag).toBe("Failure");

        // Approve forbidden
        const approveExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_1_OBSERVE", "approve")
        );
        expect(approveExit._tag).toBe("Failure");

        // Administer forbidden
        const adminExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_1_OBSERVE", "administer")
        );
        expect(adminExit._tag).toBe("Failure");
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("permits read and propose in Tier 2 (Propose) but forbids execute and approve", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        yield* service.checkOperationPermitted("TIER_2_PROPOSE", "read");
        yield* service.checkOperationPermitted("TIER_2_PROPOSE", "propose");

        const execExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_2_PROPOSE", "execute")
        );
        expect(execExit._tag).toBe("Failure");

        const approveExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_2_PROPOSE", "approve")
        );
        expect(approveExit._tag).toBe("Failure");
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("permits read, propose, and approved execution in Tier 3 but forbids self-approval and administration", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        yield* service.checkOperationPermitted(
          "TIER_3_EXECUTE_WITH_APPROVAL",
          "read"
        );
        yield* service.checkOperationPermitted(
          "TIER_3_EXECUTE_WITH_APPROVAL",
          "propose"
        );
        yield* service.checkOperationPermitted(
          "TIER_3_EXECUTE_WITH_APPROVAL",
          "execute"
        );

        const approveExit = yield* Effect.exit(
          service.checkOperationPermitted(
            "TIER_3_EXECUTE_WITH_APPROVAL",
            "approve"
          )
        );
        expect(approveExit._tag).toBe("Failure");

        const adminExit = yield* Effect.exit(
          service.checkOperationPermitted(
            "TIER_3_EXECUTE_WITH_APPROVAL",
            "administer"
          )
        );
        expect(adminExit._tag).toBe("Failure");
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("permits bounded autonomous execution in Tier 4 but forbids self-approval of policy and administration", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        yield* service.checkOperationPermitted(
          "TIER_4_BOUNDED_AUTONOMY",
          "read"
        );
        yield* service.checkOperationPermitted(
          "TIER_4_BOUNDED_AUTONOMY",
          "propose"
        );
        yield* service.checkOperationPermitted(
          "TIER_4_BOUNDED_AUTONOMY",
          "execute"
        );

        const approveExit = yield* Effect.exit(
          service.checkOperationPermitted("TIER_4_BOUNDED_AUTONOMY", "approve")
        );
        expect(approveExit._tag).toBe("Failure");

        const adminExit = yield* Effect.exit(
          service.checkOperationPermitted(
            "TIER_4_BOUNDED_AUTONOMY",
            "administer"
          )
        );
        expect(adminExit._tag).toBe("Failure");
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });
  });

  describe("AGT-001.T02: Complete business actions under tiers 2 and 3 with distinct actor/confirmation records", () => {
    it("records distinct actor records for Tier 2 human execution and Tier 3 agent execution", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        // Tier 2: Human executes the proposed action
        const tier2Record = yield* service.recordExecutionActor({
          agentProposerId: "agent_cardiology_007",
          confirmedAt: 1789000000000,
          humanReviewerId: "dr_smith_md",
          mode: "TIER_2_HUMAN",
          proposalId: "prop_vitals_99",
        });

        expect(tier2Record.mode).toBe("TIER_2_HUMAN");
        if (tier2Record.mode === "TIER_2_HUMAN") {
          expect(tier2Record.humanReviewerId).toBe("dr_smith_md");
          expect(tier2Record.agentProposerId).toBe("agent_cardiology_007");
          expect(tier2Record.proposalId).toBe("prop_vitals_99");
        }

        // Tier 3: Agent executes under human approval
        const tier3Record = yield* service.recordExecutionActor({
          approvalId: "appr_vitals_77",
          confirmedAt: 1789000001000,
          executingAgentId: "agent_cardiology_007",
          humanApproverId: "dr_jones_md",
          mode: "TIER_3_APPROVED_AGENT",
        });

        expect(tier3Record.mode).toBe("TIER_3_APPROVED_AGENT");
        if (tier3Record.mode === "TIER_3_APPROVED_AGENT") {
          expect(tier3Record.executingAgentId).toBe("agent_cardiology_007");
          expect(tier3Record.humanApproverId).toBe("dr_jones_md");
          expect(tier3Record.approvalId).toBe("appr_vitals_77");
        }

        // Tier 4: Autonomous execution record
        const tier4Record = yield* service.recordExecutionActor({
          confirmedAt: 1789000002000,
          executingAgentId: "agent_cardiology_007",
          mandateId: "mandate_cardio_01",
          mode: "TIER_4_AUTONOMOUS_AGENT",
          riskBand: "LOW",
        });

        expect(tier4Record.mode).toBe("TIER_4_AUTONOMOUS_AGENT");
        if (tier4Record.mode === "TIER_4_AUTONOMOUS_AGENT") {
          expect(tier4Record.riskBand).toBe("LOW");
          expect(tier4Record.mandateId).toBe("mandate_cardio_01");
        }
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("denies self-approval when human reviewer is identical to agent proposer in Tier 2", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        const exit = yield* Effect.exit(
          service.recordExecutionActor({
            agentProposerId: "agent_cardiology_007",
            humanReviewerId: "agent_cardiology_007",
            mode: "TIER_2_HUMAN",
            proposalId: "prop_vitals_99",
          })
        );

        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });
  });

  describe("AGT-002.T01: Try allowed action outside envelope and unlisted action inside envelope", () => {
    it("permits action when within envelope action class, object set, risk band, and budget", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        yield* service.validateMandateEnvelope(sampleMandate, {
          actionClass: "prescribe_medication",
          requestedBudgetUnits: 10,
          riskBand: "LOW",
          targetObjectId: "Patient:P001",
        });

        // Wildcard match in objectSet "Order:*"
        yield* service.validateMandateEnvelope(sampleMandate, {
          actionClass: "adjust_dosage",
          requestedBudgetUnits: 5,
          riskBand: "MEDIUM",
          targetObjectId: "Order:ORD-123",
        });
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("rejects unlisted action class even when inside object set and risk band", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        const exit = yield* Effect.exit(
          service.validateMandateEnvelope(sampleMandate, {
            actionClass: "discharge_patient", // Not allowed
            requestedBudgetUnits: 5,
            riskBand: "LOW",
            targetObjectId: "Patient:P001",
          })
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = exit.cause;
          expect(String(failure)).toContain("actionClass");
        }
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("rejects allowed action class when outside authorized object set", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        const exit = yield* Effect.exit(
          service.validateMandateEnvelope(sampleMandate, {
            actionClass: "prescribe_medication",
            requestedBudgetUnits: 5,
            riskBand: "LOW",
            targetObjectId: "Patient:P999_UNAUTHORIZED", // Outside object set
          })
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = exit.cause;
          expect(String(failure)).toContain("objectSet");
        }
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("rejects allowed action class when risk band exceeds mandate maximum", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        const exit = yield* Effect.exit(
          service.validateMandateEnvelope(sampleMandate, {
            actionClass: "prescribe_medication",
            requestedBudgetUnits: 5,
            riskBand: "HIGH", // Exceeds MEDIUM maxRiskBand
            targetObjectId: "Patient:P001",
          })
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = exit.cause;
          expect(String(failure)).toContain("riskBand");
        }
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("rejects action when requested budget exceeds remaining budget limit", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        // spentBudget is 20, limit is 100, requesting 85 exceeds 100
        const exit = yield* Effect.exit(
          service.validateMandateEnvelope(sampleMandate, {
            actionClass: "prescribe_medication",
            requestedBudgetUnits: 85,
            riskBand: "LOW",
            targetObjectId: "Patient:P001",
          })
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = exit.cause;
          expect(String(failure)).toContain("budget");
        }
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("rejects action when mandate has expired", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        const exit = yield* Effect.exit(
          service.validateMandateEnvelope(sampleMandate, {
            actionClass: "prescribe_medication",
            now: sampleMandate.expiresAt + 1000, // Past expiration
            requestedBudgetUnits: 5,
            riskBand: "LOW",
            targetObjectId: "Patient:P001",
          })
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const failure = exit.cause;
          expect(String(failure)).toContain("expired");
        }
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });
  });

  describe("AGT-002.T02: Earned promotion to Tier 4 and deterioration demotion triggers", () => {
    it("rejects promotion to Tier 4 when calibration evidence is missing or insufficient", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        // 1. Missing evidence completely
        const noEvidenceExit = yield* Effect.exit(
          service.promoteTier(sampleMandate, "TIER_4_BOUNDED_AUTONOMY")
        );
        expect(noEvidenceExit._tag).toBe("Failure");

        // 2. Insufficient trial count
        const insufficientTrials: CalibrationEvidence = {
          evaluatedAt: Date.now(),
          minimumTrialsRequired: 10,
          passRate: 1,
          safetyViolations: 0,
          trialCount: 5, // Only 5 trials
          verifierSignature: "sig_calib_001",
        };
        const trialsExit = yield* Effect.exit(
          service.promoteTier(
            sampleMandate,
            "TIER_4_BOUNDED_AUTONOMY",
            insufficientTrials
          )
        );
        expect(trialsExit._tag).toBe("Failure");

        // 3. Pass rate below 95% threshold
        const lowPassRate: CalibrationEvidence = {
          evaluatedAt: Date.now(),
          minimumTrialsRequired: 10,
          passRate: 0.9, // 90% < 95%
          safetyViolations: 0,
          trialCount: 10,
          verifierSignature: "sig_calib_002",
        };
        const passRateExit = yield* Effect.exit(
          service.promoteTier(
            sampleMandate,
            "TIER_4_BOUNDED_AUTONOMY",
            lowPassRate
          )
        );
        expect(passRateExit._tag).toBe("Failure");

        // 4. Safety violations present
        const withViolations: CalibrationEvidence = {
          evaluatedAt: Date.now(),
          minimumTrialsRequired: 10,
          passRate: 1,
          safetyViolations: 1, // 1 violation
          trialCount: 10,
          verifierSignature: "sig_calib_003",
        };
        const violationsExit = yield* Effect.exit(
          service.promoteTier(
            sampleMandate,
            "TIER_4_BOUNDED_AUTONOMY",
            withViolations
          )
        );
        expect(violationsExit._tag).toBe("Failure");
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("approves promotion to Tier 4 when calibration evidence meets all criteria", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        const validEvidence: CalibrationEvidence = {
          evaluatedAt: Date.now(),
          minimumTrialsRequired: 10,
          passRate: 0.98, // 98% >= 95%
          safetyViolations: 0,
          trialCount: 15, // 15 >= 10
          verifierSignature: "sig_calib_valid",
        };

        const promoted = yield* service.promoteTier(
          sampleMandate,
          "TIER_4_BOUNDED_AUTONOMY",
          validEvidence
        );

        expect(promoted.tier).toBe("TIER_4_BOUNDED_AUTONOMY");
        expect(promoted.mandateId).toBe(sampleMandate.mandateId);
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });

    it("demotes agent upon deterioration trigger and records auditable demotion event", async () => {
      const program = Effect.gen(function* () {
        const service = yield* AuthorityTierService;

        // Start with a Tier 4 mandate
        const tier4Mandate: TaskMandateEnvelope = {
          ...sampleMandate,
          tier: "TIER_4_BOUNDED_AUTONOMY",
        };

        // Deterioration trigger fired (e.g. 3 consecutive safety policy violations)
        const outcome = yield* service.demoteTier(
          tier4Mandate,
          "TIER_2_PROPOSE",
          "consecutive_safety_boundary_breaches",
          3
        );

        expect(outcome.updatedMandate.tier).toBe("TIER_2_PROPOSE");
        expect(outcome.demotionEvent.previousTier).toBe(
          "TIER_4_BOUNDED_AUTONOMY"
        );
        expect(outcome.demotionEvent.newTier).toBe("TIER_2_PROPOSE");
        expect(outcome.demotionEvent.reason).toBe(
          "consecutive_safety_boundary_breaches"
        );
        expect(outcome.demotionEvent.violationsCount).toBe(3);
        expect(outcome.demotionEvent.mandateId).toBe(tier4Mandate.mandateId);
      }).pipe(Effect.provide(AuthorityTierServiceLive));

      await Effect.runPromise(program);
    });
  });
});
