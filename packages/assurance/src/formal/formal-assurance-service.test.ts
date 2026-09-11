import type {
  AssuranceCase,
  FormalExecutableFragment,
  ScenarioExecutionPlan,
} from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  BoundedProofMisrepresentationError,
  DifferentialDivergenceError,
  GateIIVerificationError,
  GateIVerificationError,
  InconclusiveAssuranceRejectedError,
  IncrementalVerificationDivergenceError,
  ScenarioSandboxEscapeError,
} from "../errors.js";
import { FormalAssuranceService } from "./formal-assurance-service.js";

describe("V3-08 Formal Assurance (Gate I & II), AssuranceCase Reports & Optimization (S19, OPR-FULL-026..030)", () => {
  const service = new FormalAssuranceService();

  const sampleFragment: FormalExecutableFragment = {
    assumptions: ["monotonic_time", "linear_ledger_commitment"],
    fragmentId: "frag-core-v3",
    solverVersion: "z3-4.12.2-embedded",
    supportedActions: ["COMMIT_TRANSACTION", "FENCE_WRITER"],
    supportedTypes: ["Account", "LedgerEntry"],
  };

  it("FULL-ACC-026.T01: publishes bounded_no_counterexample when no counterexample is found up to depth K, rejecting claims of unbounded proof", async () => {
    // Finite depth bound K=15 without counterexample cannot claim PROVEN_IN_MODEL
    const misrepresentationExit = await Effect.runPromiseExit(
      service.evaluateAssuranceReport({
        candidateDigest: "cand-digest-1",
        caseId: "case-depth-bound-1",
        claimedOutcome: "PROVEN_IN_MODEL", // invalid claim!
        fragment: sampleFragment,
        searchDepthBound: 15,
        solverFoundCounterexample: false,
      })
    );

    expect(Exit.isFailure(misrepresentationExit)).toBe(true);
    if (Exit.isFailure(misrepresentationExit)) {
      const err = misrepresentationExit.cause.reasons.find(
        Cause.isFailReason
      )?.error;
      expect(err).toBeInstanceOf(BoundedProofMisrepresentationError);
      expect((err as BoundedProofMisrepresentationError).searchDepthBound).toBe(
        15
      );
    }

    // Explicit publication as BOUNDED_NO_COUNTEREXAMPLE succeeds
    const boundedCase = await Effect.runPromise(
      service.evaluateAssuranceReport({
        candidateDigest: "cand-digest-1",
        caseId: "case-depth-bound-1",
        claimedOutcome: "BOUNDED_NO_COUNTEREXAMPLE",
        fragment: sampleFragment,
        searchDepthBound: 15,
        solverFoundCounterexample: false,
      })
    );

    expect(boundedCase.outcome).toBe("BOUNDED_NO_COUNTEREXAMPLE");
    expect(boundedCase.searchDepthBound).toBe(15);
  });

  it("FULL-ACC-027.T01: blocks publication and exports reproducible counterexample fixture when backend and reference interpreter diverge", async () => {
    const referenceInterpreterResult = {
      decision: "ALLOW",
      evaluatedRules: ["RULE_FENCE_VALID", "RULE_QUOTA_OK"],
      permittedDelta: 500,
    };

    const backendResult = {
      decision: "REVIEW_REQUIRED", // semantic mismatch!
      evaluatedRules: ["RULE_FENCE_VALID"],
      permittedDelta: 0,
    };

    const divergenceExit = await Effect.runPromiseExit(
      service.evaluateDifferentialEquivalence({
        backendResult,
        referenceInterpreterResult,
        ruleId: "RULE_PERMISSION_EVALUATION",
      })
    );

    expect(Exit.isFailure(divergenceExit)).toBe(true);
    if (Exit.isFailure(divergenceExit)) {
      const err = divergenceExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(DifferentialDivergenceError);
      expect((err as DifferentialDivergenceError).ruleId).toBe(
        "RULE_PERMISSION_EVALUATION"
      );
      expect(
        (err as DifferentialDivergenceError).counterexampleFixture
      ).toContain("SEMANTIC_TRANSLATION_MISMATCH");
    }

    // Matching results succeed
    const matchSuccess = await Effect.runPromise(
      service.evaluateDifferentialEquivalence({
        backendResult: referenceInterpreterResult,
        referenceInterpreterResult,
        ruleId: "RULE_PERMISSION_EVALUATION",
      })
    );
    expect(matchSuccess).toBe(true);
  });

  it("FULL-ACC-028.T01: confines scenario execution to simulator endpoints, preventing real side effects or credential exposure", async () => {
    // Attempting unsimulated dispatch triggers escape error
    const escapePlan: ScenarioExecutionPlan = {
      actions: [
        { actionName: "PREPARE", simulated: true },
        { actionName: "DISPATCH_REAL_EMAIL", simulated: false }, // unsimulated!
      ],
      containedInSandbox: true,
      realCredentialsExposed: false,
      scenarioId: "scen-escape-01",
    };

    const escapeExit = await Effect.runPromiseExit(
      service.executeScenarioUnderContainment({ plan: escapePlan })
    );

    expect(Exit.isFailure(escapeExit)).toBe(true);
    if (Exit.isFailure(escapeExit)) {
      const err = escapeExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(ScenarioSandboxEscapeError);
      expect((err as ScenarioSandboxEscapeError).reason).toBe(
        "UNSIMULATED_DISPATCH_CHANNEL"
      );
    }

    // Fully contained simulated plan succeeds
    const containedPlan: ScenarioExecutionPlan = {
      actions: [
        { actionName: "PREPARE", simulated: true },
        { actionName: "DISPATCH_MOCK_EMAIL", simulated: true },
      ],
      containedInSandbox: true,
      realCredentialsExposed: false,
      scenarioId: "scen-safe-01",
    };

    const safeResult = await Effect.runPromise(
      service.executeScenarioUnderContainment({ plan: containedPlan })
    );
    expect(safeResult).toBe(true);
  });

  it("FULL-ACC-029.T01: rejects release publication when assurance outcome is inconclusive or timed out", async () => {
    const timedOutCase: AssuranceCase = {
      candidateDigest: "cand-digest-timeout",
      caseId: "case-timeout",
      fragment: sampleFragment,
      outcome: "TIMEOUT",
      verifiedAt: Date.now(),
    };

    const timeoutExit = await Effect.runPromiseExit(
      service.verifyReleaseQualification(timedOutCase, "PROVEN_IN_MODEL")
    );

    expect(Exit.isFailure(timeoutExit)).toBe(true);
    if (Exit.isFailure(timeoutExit)) {
      const err = timeoutExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(InconclusiveAssuranceRejectedError);
      expect((err as InconclusiveAssuranceRejectedError).outcome).toBe(
        "TIMEOUT"
      );
    }

    // Valid proven case passes
    const provenCase: AssuranceCase = {
      candidateDigest: "cand-digest-proven",
      caseId: "case-proven",
      fragment: sampleFragment,
      outcome: "PROVEN_IN_MODEL",
      verifiedAt: Date.now(),
    };

    const provenResult = await Effect.runPromise(
      service.verifyReleaseQualification(provenCase, "PROVEN_IN_MODEL")
    );
    expect(provenResult).toBe(true);
  });

  it("FULL-ACC-030.T01: enforces consistency between incremental and full baseline verification when transitive dependencies change", async () => {
    const fullVerdict = { status: "ALLOW", appliedRules: ["R1", "R2", "R3"] };
    const incrementalVerdict = { status: "DENY", appliedRules: ["R1"] }; // diverged due to stale cache

    const divergenceExit = await Effect.runPromiseExit(
      service.evaluateIncrementalConsistency({
        fullVerdict,
        incrementalVerdict,
        transitiveDependenciesModified: true,
      })
    );

    expect(Exit.isFailure(divergenceExit)).toBe(true);
    if (Exit.isFailure(divergenceExit)) {
      const err = divergenceExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(IncrementalVerificationDivergenceError);
      expect(
        (err as IncrementalVerificationDivergenceError).counterexampleFixture
      ).toBeDefined();
    }

    // Consistent verdicts pass cleanly
    const matchResult = await Effect.runPromise(
      service.evaluateIncrementalConsistency({
        fullVerdict,
        incrementalVerdict: fullVerdict,
        transitiveDependenciesModified: true,
      })
    );
    expect(matchResult).toBe(true);
  });

  it("S19.T01: evaluates Gate I rule compliance/non-over-restriction and Gate II knowledge admission", async () => {
    // Gate I: Over-restriction is rejected
    const overRestrictedExit = await Effect.runPromiseExit(
      service.evaluateGateI({
        executionRules: [
          { arbitrarilyBlocked: false, ruleId: "RULE_1", satisfied: true },
          { arbitrarilyBlocked: true, ruleId: "RULE_2", satisfied: true }, // arbitrarily blocked!
        ],
      })
    );

    expect(Exit.isFailure(overRestrictedExit)).toBe(true);
    if (Exit.isFailure(overRestrictedExit)) {
      const err = overRestrictedExit.cause.reasons.find(
        Cause.isFailReason
      )?.error;
      expect(err).toBeInstanceOf(GateIVerificationError);
      expect((err as GateIVerificationError).overRestricted).toBe(true);
    }

    // Gate I: Valid rules pass
    const gateIPass = await Effect.runPromise(
      service.evaluateGateI({
        executionRules: [
          { arbitrarilyBlocked: false, ruleId: "RULE_1", satisfied: true },
          { arbitrarilyBlocked: false, ruleId: "RULE_2", satisfied: true },
        ],
      })
    );
    expect(gateIPass.passed).toBe(true);
    expect(gateIPass.overRestricted).toBe(false);

    // Gate II: Knowledge admission without evidence pointers is rejected
    const noEvidenceExit = await Effect.runPromiseExit(
      service.evaluateGateII({
        claimId: "claim-patient-vital-status",
        evidencePointers: [], // empty!
        policyRulesPassed: true,
      })
    );

    expect(Exit.isFailure(noEvidenceExit)).toBe(true);
    if (Exit.isFailure(noEvidenceExit)) {
      const err = noEvidenceExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(GateIIVerificationError);
      expect((err as GateIIVerificationError).reason).toBe(
        "NO_EVIDENCE_POINTERS"
      );
    }

    // Gate II: Valid evidence admits knowledge
    const gateIIPass = await Effect.runPromise(
      service.evaluateGateII({
        claimId: "claim-patient-vital-status",
        evidencePointers: ["ev-span-bitemporal-001"],
        policyRulesPassed: true,
      })
    );
    expect(gateIIPass.admitted).toBe(true);
    expect(gateIIPass.policySatisfied).toBe(true);
  });
});
