import type {
  ContractVersionDeclaration,
  FactoryTaskContract,
  NormativeLedger,
} from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  AdversarialScenarioTamperError,
  ContractRevisionConflictError,
  EvidenceMutationRejectedError,
  ExternalGateRequiredError,
  UnapprovedTaskContractError,
} from "../errors.js";
import { DualLedgerVerifier } from "./dual-ledger-verifier.js";

describe("V3-07 Independent Evidence, Dual Ledgers & Adversarial Factory Verification (S17, OPR-FULL-051..054)", () => {
  const verifier = new DualLedgerVerifier();

  it("FULL-ACC-051.T01: denies protected write for task without approved contract, pointing to missing requirements", async () => {
    // Unapproved contract missing scope and evidence requirements
    const unapprovedContract: FactoryTaskContract = {
      approved: false,
      dependencies: ["pkg-core"],
      inputs: ["dataset-v1"],
      requiredEvidence: [], // missing
      scope: [], // missing
      taskId: "task-feat-autorun-01",
    };

    // Read action is permitted
    const readResult = await Effect.runPromise(
      verifier.verifyTaskExecution(unapprovedContract, "READ")
    );
    expect(readResult).toBe(true);

    // Write action is strictly denied
    const writeExit = await Effect.runPromiseExit(
      verifier.verifyTaskExecution(unapprovedContract, "WRITE")
    );

    expect(Exit.isFailure(writeExit)).toBe(true);
    if (Exit.isFailure(writeExit)) {
      const err = writeExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(UnapprovedTaskContractError);
      expect((err as UnapprovedTaskContractError).taskId).toBe(
        "task-feat-autorun-01"
      );
      expect(
        (err as UnapprovedTaskContractError).missingRequirements
      ).toContain("contract_approval");
      expect(
        (err as UnapprovedTaskContractError).missingRequirements
      ).toContain("declared_scope");
      expect(
        (err as UnapprovedTaskContractError).missingRequirements
      ).toContain("declared_required_evidence");
    }

    // Fully approved contract succeeds
    const approvedContract: FactoryTaskContract = {
      approved: true,
      dependencies: ["pkg-core"],
      inputs: ["dataset-v1"],
      requiredEvidence: ["evidence-hash-01"],
      scope: ["src/feature"],
      taskId: "task-feat-autorun-01",
    };

    const approvedWrite = await Effect.runPromise(
      verifier.verifyTaskExecution(approvedContract, "WRITE")
    );
    expect(approvedWrite).toBe(true);
  });

  it("FULL-ACC-052.T01: rejects diff where implementer deletes protected adversarial scenarios to pass test suite", async () => {
    const baseProtectedScenarios = [
      "SCENARIO_HAPPY_PATH_AUTH",
      "SCENARIO_ADVERSARIAL_INJECTION_SQL",
      "SCENARIO_ADVERSARIAL_CREDENTIAL_LEAK",
      "SCENARIO_CONCURRENCY_BURST",
    ];

    // Implementer agent deleted the two adversarial scenarios to make tests green
    const proposedScenarios = [
      "SCENARIO_HAPPY_PATH_AUTH",
      "SCENARIO_CONCURRENCY_BURST",
    ];

    const diffExit = await Effect.runPromiseExit(
      verifier.verifyDiffAgainstProtectedScenarios({
        baseProtectedScenarios,
        proposedScenarios,
      })
    );

    expect(Exit.isFailure(diffExit)).toBe(true);
    if (Exit.isFailure(diffExit)) {
      const err = diffExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(AdversarialScenarioTamperError);
      expect((err as AdversarialScenarioTamperError).removedScenarios).toEqual([
        "SCENARIO_ADVERSARIAL_INJECTION_SQL",
        "SCENARIO_ADVERSARIAL_CREDENTIAL_LEAK",
      ]);
    }

    // If all protected scenarios are preserved, verification succeeds
    const validProposed = [...baseProtectedScenarios, "SCENARIO_NEW_FEATURE"];
    const validResult = await Effect.runPromise(
      verifier.verifyDiffAgainstProtectedScenarios({
        baseProtectedScenarios,
        proposedScenarios: validProposed,
      })
    );
    expect(validResult).toBe(true);
  });

  it("FULL-ACC-053.T01: fails release assembly with ContractRevisionConflictError on incompatible interface revisions", async () => {
    // Two modules use conflicting versions of the KernelStorage contract
    const declarations: readonly ContractVersionDeclaration[] = [
      {
        contractId: "KernelStorage",
        interfaceVersion: "2.1.0",
        moduleId: "pkg-runtime",
        owner: "team-core",
      },
      {
        contractId: "KernelStorage",
        interfaceVersion: "3.0.0-incompatible",
        moduleId: "pkg-extensions",
        owner: "team-contrib",
      },
    ];

    const compatExit = await Effect.runPromiseExit(
      verifier.verifyModuleCompatibility(declarations)
    );

    expect(Exit.isFailure(compatExit)).toBe(true);
    if (Exit.isFailure(compatExit)) {
      const err = compatExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(ContractRevisionConflictError);
      expect((err as ContractRevisionConflictError).contractId).toBe(
        "KernelStorage"
      );
      expect(
        (err as ContractRevisionConflictError).conflictingModules
      ).toHaveLength(2);
    }

    // Compatible modules pass
    const compatibleDeclarations: readonly ContractVersionDeclaration[] = [
      {
        contractId: "KernelStorage",
        interfaceVersion: "2.1.0",
        moduleId: "pkg-runtime",
        owner: "team-core",
      },
      {
        contractId: "KernelStorage",
        interfaceVersion: "2.1.0",
        moduleId: "pkg-extensions",
        owner: "team-contrib",
      },
    ];

    const passResult = await Effect.runPromise(
      verifier.verifyModuleCompatibility(compatibleDeclarations)
    );
    expect(passResult).toBe(true);
  });

  it("FULL-ACC-054.T01: requires external publication gate when factory self-modifies its own executor", async () => {
    // Factory modified its own executor component, but external gate is false
    const bypassExit = await Effect.runPromiseExit(
      verifier.verifyPublicationGate({
        externalGateSatisfied: false,
        policyDigest: "sha256_immutable_policy_anchor_99",
        selfModifiedExecutor: true,
        targetComponent: "packages/assurance/src/factory/runner",
      })
    );

    expect(Exit.isFailure(bypassExit)).toBe(true);
    if (Exit.isFailure(bypassExit)) {
      const err = bypassExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(ExternalGateRequiredError);
      expect((err as ExternalGateRequiredError).targetComponent).toBe(
        "packages/assurance/src/factory/runner"
      );
    }

    // With external gate satisfied, publication is authorized
    const verifiedResult = await Effect.runPromise(
      verifier.verifyPublicationGate({
        externalGateSatisfied: true,
        policyDigest: "sha256_immutable_policy_anchor_99",
        selfModifiedExecutor: true,
        targetComponent: "packages/assurance/src/factory/runner",
      })
    );
    expect(verifiedResult).toBe(true);
  });

  it("S17.T01: rejects adversarial mutations in candidate observations ledger against normative ledger", async () => {
    const normativeLedger: NormativeLedger = {
      digest: "normative-digest-v3",
      ledgerId: "normative-core-suite-v3",
      requirements: [
        {
          caseId: "CASE-001",
          description: "Verify atomic commit safety",
          expectedOutcome: "PASS",
          isProtected: true,
          minimumAssertions: 2,
          requirementId: "REQ-01",
        },
        {
          caseId: "CASE-002",
          description: "Verify adversarial split-brain fencing",
          expectedOutcome: "PASS",
          isProtected: true,
          minimumAssertions: 1,
          requirementId: "REQ-02",
        },
      ],
      version: "3.0.0",
    };

    const trustedRunners = [
      "runner-trusted-ci-01",
      "runner-independent-auditor",
    ];

    // 1. Untrusted runner mutation
    const untrustedRunnerExit = await Effect.runPromiseExit(
      verifier.verifyEvidenceAgainstNormativeLedger({
        normativeLedger,
        observationLedger: {
          candidateDigest: "cand-1",
          observations: [],
          runnerId: "runner-malicious-attacker",
          signature: "sig-1",
        },
        trustedRunners,
      })
    );
    expect(Exit.isFailure(untrustedRunnerExit)).toBe(true);
    if (Exit.isFailure(untrustedRunnerExit)) {
      const err = untrustedRunnerExit.cause.reasons.find(
        Cause.isFailReason
      )?.error;
      expect(err).toBeInstanceOf(EvidenceMutationRejectedError);
      expect((err as EvidenceMutationRejectedError).mutationType).toBe(
        "UNTRUSTED_RUNNER"
      );
    }

    // 2. Dropped case mutation
    const droppedCaseExit = await Effect.runPromiseExit(
      verifier.verifyEvidenceAgainstNormativeLedger({
        normativeLedger,
        observationLedger: {
          candidateDigest: "cand-1",
          observations: [
            {
              assertionCount: 2,
              caseId: "CASE-001",
              executionReceiptHash: "hash-001",
              observedAt: 1000,
              status: "PASS",
            },
            // CASE-002 is dropped!
          ],
          runnerId: "runner-trusted-ci-01",
          signature: "sig-1",
        },
        trustedRunners,
      })
    );
    expect(Exit.isFailure(droppedCaseExit)).toBe(true);
    if (Exit.isFailure(droppedCaseExit)) {
      const err = droppedCaseExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(EvidenceMutationRejectedError);
      expect((err as EvidenceMutationRejectedError).mutationType).toBe(
        "DROPPED_CASE"
      );
    }

    // 3. Duplicate case mutation
    const duplicateCaseExit = await Effect.runPromiseExit(
      verifier.verifyEvidenceAgainstNormativeLedger({
        normativeLedger,
        observationLedger: {
          candidateDigest: "cand-1",
          observations: [
            {
              assertionCount: 2,
              caseId: "CASE-001",
              executionReceiptHash: "hash-001",
              observedAt: 1000,
              status: "PASS",
            },
            {
              assertionCount: 2,
              caseId: "CASE-001", // duplicate!
              executionReceiptHash: "hash-001b",
              observedAt: 1001,
              status: "PASS",
            },
            {
              assertionCount: 1,
              caseId: "CASE-002",
              executionReceiptHash: "hash-002",
              observedAt: 1002,
              status: "PASS",
            },
          ],
          runnerId: "runner-trusted-ci-01",
          signature: "sig-1",
        },
        trustedRunners,
      })
    );
    expect(Exit.isFailure(duplicateCaseExit)).toBe(true);
    if (Exit.isFailure(duplicateCaseExit)) {
      const err = duplicateCaseExit.cause.reasons.find(
        Cause.isFailReason
      )?.error;
      expect(err).toBeInstanceOf(EvidenceMutationRejectedError);
      expect((err as EvidenceMutationRejectedError).mutationType).toBe(
        "DUPLICATE_CASE"
      );
    }

    // 4. Zero assertions mutation
    const zeroAssertionsExit = await Effect.runPromiseExit(
      verifier.verifyEvidenceAgainstNormativeLedger({
        normativeLedger,
        observationLedger: {
          candidateDigest: "cand-1",
          observations: [
            {
              assertionCount: 2,
              caseId: "CASE-001",
              executionReceiptHash: "hash-001",
              observedAt: 1000,
              status: "PASS",
            },
            {
              assertionCount: 0, // 0 assertions PASS!
              caseId: "CASE-002",
              executionReceiptHash: "hash-002",
              observedAt: 1002,
              status: "PASS",
            },
          ],
          runnerId: "runner-trusted-ci-01",
          signature: "sig-1",
        },
        trustedRunners,
      })
    );
    expect(Exit.isFailure(zeroAssertionsExit)).toBe(true);
    if (Exit.isFailure(zeroAssertionsExit)) {
      const err = zeroAssertionsExit.cause.reasons.find(
        Cause.isFailReason
      )?.error;
      expect(err).toBeInstanceOf(EvidenceMutationRejectedError);
      expect((err as EvidenceMutationRejectedError).mutationType).toBe(
        "ZERO_ASSERTIONS"
      );
    }

    // 5. Valid observations pass cleanly
    const validReport = await Effect.runPromise(
      verifier.verifyEvidenceAgainstNormativeLedger({
        normativeLedger,
        observationLedger: {
          candidateDigest: "cand-1",
          observations: [
            {
              assertionCount: 2,
              caseId: "CASE-001",
              executionReceiptHash: "hash-001",
              observedAt: 1000,
              status: "PASS",
            },
            {
              assertionCount: 3,
              caseId: "CASE-002",
              executionReceiptHash: "hash-002",
              observedAt: 1002,
              status: "PASS",
            },
          ],
          runnerId: "runner-trusted-ci-01",
          signature: "sig-valid",
        },
        trustedRunners,
      })
    );

    expect(validReport.matchedCasesCount).toBe(2);
    expect(validReport.totalAssertions).toBe(5);
    expect(validReport.runnerId).toBe("runner-trusted-ci-01");
  });
});
