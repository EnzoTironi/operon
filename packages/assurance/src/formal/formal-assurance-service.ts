import type {
  AssuranceCase,
  FormalAssuranceOutcome,
  FormalExecutableFragment,
  GateIIVerdict,
  GateIVerdict,
  ScenarioExecutionPlan,
} from "@operon/schema";
import { Effect } from "effect";

import {
  BoundedProofMisrepresentationError,
  DifferentialDivergenceError,
  GateIIVerificationError,
  GateIVerificationError,
  InconclusiveAssuranceRejectedError,
  IncrementalVerificationDivergenceError,
  ScenarioSandboxEscapeError,
} from "../errors.js";

/**
 * FormalAssuranceService (S19, OPR-FULL-026..030):
 * Manages formal executable fragments, bounded proof reports, differential equivalence,
 * scenario sandbox containment, and Gate I/II verification.
 */
export class FormalAssuranceService {
  /**
   * Evaluates an assurance case report, strictly validating search bounds and outcomes (FULL-ACC-026)
   */
  evaluateAssuranceReport(params: {
    readonly candidateDigest: string;
    readonly caseId: string;
    readonly claimedOutcome: FormalAssuranceOutcome;
    readonly fragment: FormalExecutableFragment;
    readonly searchDepthBound?: number;
    readonly solverFoundCounterexample?: boolean;
    readonly solverTimedOut?: boolean;
  }): Effect.Effect<AssuranceCase, BoundedProofMisrepresentationError> {
    const {
      candidateDigest,
      caseId,
      claimedOutcome,
      fragment,
      searchDepthBound,
      solverFoundCounterexample,
      solverTimedOut,
    } = params;

    let actualOutcome: FormalAssuranceOutcome;

    if (solverTimedOut) {
      actualOutcome = "TIMEOUT";
    } else if (solverFoundCounterexample) {
      actualOutcome = "COUNTEREXAMPLE";
    } else if (searchDepthBound === undefined) {
      actualOutcome = claimedOutcome;
    } else {
      // Solver searched to depth K and found no counterexample
      if (claimedOutcome === "PROVEN_IN_MODEL") {
        return Effect.fail(
          new BoundedProofMisrepresentationError({
            attemptedOutcome: claimedOutcome,
            message: `Finite search depth K=${searchDepthBound} cannot be misrepresented as unbounded mathematical proof (PROVEN_IN_MODEL). Must be published as BOUNDED_NO_COUNTEREXAMPLE.`,
            searchDepthBound,
          })
        );
      }
      actualOutcome = "BOUNDED_NO_COUNTEREXAMPLE";
    }

    const assuranceCase: AssuranceCase = {
      candidateDigest,
      caseId,
      fragment,
      outcome: actualOutcome,
      searchDepthBound,
      verifiedAt: Date.now(),
    };

    return Effect.succeed(assuranceCase);
  }

  /**
   * Performs differential execution between reference interpreter and backend runtime (FULL-ACC-027)
   */
  evaluateDifferentialEquivalence(params: {
    readonly backendResult: unknown;
    readonly referenceInterpreterResult: unknown;
    readonly ruleId: string;
  }): Effect.Effect<boolean, DifferentialDivergenceError> {
    const { backendResult, referenceInterpreterResult, ruleId } = params;

    const refJson = JSON.stringify(referenceInterpreterResult);
    const backendJson = JSON.stringify(backendResult);

    if (refJson !== backendJson) {
      const counterexampleFixture = JSON.stringify(
        {
          backend: backendResult,
          detectedAt: new Date().toISOString(),
          divergence: "SEMANTIC_TRANSLATION_MISMATCH",
          reference: referenceInterpreterResult,
          ruleId,
        },
        null,
        2
      );

      return Effect.fail(
        new DifferentialDivergenceError({
          backendResult,
          counterexampleFixture,
          message: `Differential execution diverged for rule "${ruleId}": backend runtime semantics do not match reference interpreter. Publication blocked with counterexample fixture.`,
          referenceInterpreterResult,
          ruleId,
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Executes formal simulation scenarios under strict sandbox containment (FULL-ACC-028)
   */
  executeScenarioUnderContainment(params: {
    readonly plan: ScenarioExecutionPlan;
  }): Effect.Effect<boolean, ScenarioSandboxEscapeError> {
    const { plan } = params;

    if (!plan.containedInSandbox) {
      return Effect.fail(
        new ScenarioSandboxEscapeError({
          message: `Scenario "${plan.scenarioId}" breached sandbox containment boundary.`,
          reason: "SANDBOX_ESCAPE_CONTAINMENT_FALSE",
          scenarioId: plan.scenarioId,
        })
      );
    }

    if (plan.realCredentialsExposed) {
      return Effect.fail(
        new ScenarioSandboxEscapeError({
          message: `Scenario "${plan.scenarioId}" attempted access to real production credentials.`,
          reason: "CREDENTIAL_EXPOSURE_DETECTED",
          scenarioId: plan.scenarioId,
        })
      );
    }

    for (const action of plan.actions) {
      if (!action.simulated) {
        return Effect.fail(
          new ScenarioSandboxEscapeError({
            message: `Scenario "${plan.scenarioId}" attempted unsimulated real side-effect dispatch on action "${action.actionName}". Real external dispatch channels are prohibited in simulation scenarios.`,
            reason: "UNSIMULATED_DISPATCH_CHANNEL",
            scenarioId: plan.scenarioId,
          })
        );
      }
    }

    return Effect.succeed(true);
  }

  /**
   * Verifies release qualification against formal assurance case (FULL-ACC-029)
   */
  verifyReleaseQualification(
    assuranceCase: AssuranceCase,
    requiredOutcome?: "PROVEN_IN_MODEL" | "BOUNDED_NO_COUNTEREXAMPLE"
  ): Effect.Effect<boolean, InconclusiveAssuranceRejectedError> {
    const { outcome, caseId } = assuranceCase;

    if (
      outcome === "TIMEOUT" ||
      outcome === "INCONCLUSIVE" ||
      outcome === "UNSUPPORTED"
    ) {
      return Effect.fail(
        new InconclusiveAssuranceRejectedError({
          caseId,
          message: `Release qualification failed: assurance report returned "${outcome}", which does not satisfy proof requirements. Inconclusive evidence cannot be relabeled as PASS.`,
          outcome,
        })
      );
    }

    if (requiredOutcome && outcome !== requiredOutcome) {
      return Effect.fail(
        new InconclusiveAssuranceRejectedError({
          caseId,
          message: `Release qualification failed: required outcome was "${requiredOutcome}", but report produced "${outcome}".`,
          outcome,
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Verifies consistency between incremental and full baseline verification (FULL-ACC-030)
   */
  evaluateIncrementalConsistency(params: {
    readonly fullVerdict: unknown;
    readonly incrementalVerdict: unknown;
    readonly transitiveDependenciesModified?: boolean;
  }): Effect.Effect<boolean, IncrementalVerificationDivergenceError> {
    const { fullVerdict, incrementalVerdict } = params;

    const fullStr = JSON.stringify(fullVerdict);
    const incStr = JSON.stringify(incrementalVerdict);

    if (fullStr !== incStr) {
      const counterexampleFixture = JSON.stringify(
        {
          fullVerdict,
          incrementalVerdict,
          transitiveDependenciesModified:
            params.transitiveDependenciesModified ?? false,
        },
        null,
        2
      );

      return Effect.fail(
        new IncrementalVerificationDivergenceError({
          counterexampleFixture,
          fullVerdict,
          incrementalVerdict,
          message:
            "Incremental verification verdict diverged from full baseline evaluation. Incremental mode is blocked with counterexample fixture.",
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Compiler Gate I: Permitted executions respect declared rules without over-restriction (S19)
   */
  evaluateGateI(params: {
    readonly executionRules: readonly {
      readonly arbitrarilyBlocked: boolean;
      readonly ruleId: string;
      readonly satisfied: boolean;
    }[];
  }): Effect.Effect<GateIVerdict, GateIVerificationError> {
    const unmetRules: string[] = [];
    let arbitrarilyBlockedCount = 0;

    for (const rule of params.executionRules) {
      if (!rule.satisfied) {
        unmetRules.push(rule.ruleId);
      }
      if (rule.arbitrarilyBlocked) {
        arbitrarilyBlockedCount++;
      }
    }

    const overRestricted = arbitrarilyBlockedCount > 0;

    if (unmetRules.length > 0 || overRestricted) {
      return Effect.fail(
        new GateIVerificationError({
          message: `Gate I verification failed: ${unmetRules.length} unmet rule(s), ${arbitrarilyBlockedCount} arbitrarily blocked execution(s)`,
          overRestricted,
          unmetRules,
        })
      );
    }

    return Effect.succeed({
      arbitrarilyBlockedCount: 0,
      overRestricted: false,
      passed: true,
      respectedRules: params.executionRules.map((r) => r.ruleId),
    });
  }

  /**
   * Compiler Gate II: Knowledge admission against registered evidence and policy (S19)
   */
  evaluateGateII(params: {
    readonly claimId: string;
    readonly evidencePointers: readonly string[];
    readonly policyRulesPassed: boolean;
  }): Effect.Effect<GateIIVerdict, GateIIVerificationError> {
    const { claimId, evidencePointers, policyRulesPassed } = params;

    if (evidencePointers.length === 0) {
      return Effect.fail(
        new GateIIVerificationError({
          claimId,
          message: `Gate II admission rejected for claim "${claimId}": no registered evidence pointers provided.`,
          reason: "NO_EVIDENCE_POINTERS",
        })
      );
    }

    if (!policyRulesPassed) {
      return Effect.fail(
        new GateIIVerificationError({
          claimId,
          message: `Gate II admission rejected for claim "${claimId}": policy rules not satisfied.`,
          reason: "POLICY_VIOLATION",
        })
      );
    }

    return Effect.succeed({
      admitted: true,
      claimId,
      evidencePointers,
      policySatisfied: true,
    });
  }
}
