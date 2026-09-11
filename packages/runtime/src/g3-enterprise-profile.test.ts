import type {
  AuditedBackupPackage,
  CandidateObservationLedger,
  ContractVersionDeclaration,
  DeploymentConfiguration,
  FactoryTaskContract,
  FederatedViewContract,
  FormalExecutableFragment,
  LocalityPolicy,
  MultiCellOperationPlan,
  NormativeLedger,
  ScenarioExecutionPlan,
  TenantQuotaPolicy,
} from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  AuditedBackupService,
  buildHashChain,
} from "./backup/audited-backup-service.js";
import {
  FencedWriterService,
  validateDeploymentConfiguration,
} from "./deployment/fenced-writer-service.js";
import { TenantQuotaService } from "./economics/quota-service.js";
import {
  InMemoryExportRestoreStorage,
  SovereignExportService,
} from "./export/sovereign-export-service.js";
import { FederationService } from "./federation/federation-service.js";
import {
  AdversarialScenarioTamperError,
  BackupAuditIntegrityError,
  BoundedProofMisrepresentationError,
  ContractRevisionConflictError,
  DifferentialDivergenceError,
  DualLedgerVerifier,
  EvidenceMutationRejectedError,
  ExternalGateRequiredError,
  FormalAssuranceService,
  InconclusiveAssuranceRejectedError,
  IncrementalVerificationDivergenceError,
  ProductionInMemoryAuthorityForbiddenError,
  RegionalLocalityViolationError,
  RemoteCellExecutionError,
  RestoreSideEffectReplayForbiddenError,
  ScenarioSandboxEscapeError,
  SplitBrainWriterFencedError,
  TenantQuotaExceededError,
  UnapprovedTaskContractError,
  UncontractedLinkTraversalError,
} from "./index.js";

describe("Gate G3 Exit Verification: Isolated Enterprise Profile (S15, S16, S17, S19)", () => {
  // Shared services
  const federationService = new FederationService();
  const exportService = new SovereignExportService();
  const fencedWriterService = new FencedWriterService();
  const backupService = new AuditedBackupService();
  const quotaService = new TenantQuotaService({ totalCellCapacity: 10 });
  const dualLedgerVerifier = new DualLedgerVerifier();
  const formalService = new FormalAssuranceService();

  describe("1. Federated Authority & Multi-Cell Compensation (S15, OPR-FULL-044, OPR-FULL-046)", () => {
    it("FULL-ACC-044: enforces view contract, filters uncontracted fields, and denies uncontracted link traversal", async () => {
      const contract: FederatedViewContract = {
        allowedLinkRelations: ["PATIENT_ROOM"],
        allowedProperties: {
          "healthcare.Patient": ["department", "patientId", "triageLevel"],
        },
        allowedPurposes: ["CLINICAL_COLLABORATION"],
        allowedSchemaTypes: ["healthcare.Patient"],
        contractId: "fed-contract-clinical-eu-us",
        revoked: false,
        sourceCellId: "cell-eu-frankfurt-01",
        targetCellId: "cell-us-ashburn-01",
        tenantId: "tenant-enterprise-sovereign-01",
      };

      // Export view: confidential 'ssn' and 'billingRecord' must be filtered out
      const rawEntity = {
        billingRecord: "CONFIDENTIAL_BILLING_99",
        department: "Cardiology",
        patientId: "P-8801",
        ssn: "000-11-2222",
        triageLevel: "URGENT",
      };

      const filtered = await Effect.runPromise(
        federationService.filterFederatedView(
          contract,
          "healthcare.Patient",
          rawEntity,
          "2026-09-11T12:00:00.000Z"
        )
      );

      expect(filtered.exportedData).toEqual({
        department: "Cardiology",
        patientId: "P-8801",
        triageLevel: "URGENT",
      });
      expect(filtered.exportedData).not.toHaveProperty("ssn");
      expect(filtered.exportedData).not.toHaveProperty("billingRecord");

      // Deny uncontracted link traversal outside negotiated contract
      const traversalExit = await Effect.runPromiseExit(
        federationService.traverseFederatedLink({
          contract,
          currentTime: "2026-09-11T12:00:00.000Z",
          linkRelation: "PRIVATE_FINANCIAL_LEDGER", // not permitted!
          sourceEntityId: "P-8801",
          targetEntityId: "FIN-99",
        })
      );

      expect(Exit.isFailure(traversalExit)).toBe(true);
      if (Exit.isFailure(traversalExit)) {
        const err = traversalExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(UncontractedLinkTraversalError);
      }
    });

    it("FULL-ACC-046: executes multi-cell saga with partial compensation without global transaction fantasy", async () => {
      const plan: MultiCellOperationPlan = {
        operationId: "op-federated-transfer-01",
        steps: [
          {
            action: "DEBIT_RESERVE",
            cellId: "cell-eu-frankfurt-01",
            compensatingAction: "REFUND_RESERVE",
            payload: { amount: 10_000 },
            stepId: "step-1",
            timeoutMs: 5000,
          },
          {
            action: "FAILING_REMOTE_CREDIT",
            cellId: "cell-us-ashburn-01",
            payload: { amount: 10_000 },
            stepId: "step-2",
            timeoutMs: 5000,
          },
        ],
        tenantId: "tenant-enterprise-sovereign-01",
      };

      const cellExecutors = {
        "cell-eu-frankfurt-01": {
          executeCompensation: () => Effect.succeed("comp-1"),
          executeStep: () => Effect.succeed("rcpt-1"),
        },
        "cell-us-ashburn-01": {
          executeStep: () =>
            Effect.fail(
              new RemoteCellExecutionError({
                cellId: "cell-us-ashburn-01",
                message: "Simulated remote network partition",
              })
            ),
        },
      };

      const outcome = await Effect.runPromise(
        federationService.executeMultiCellSaga(plan, cellExecutors)
      );

      expect(outcome.globalCommitPromised).toBe(false);
      expect(outcome.status).toBe("PARTIALLY_FAILED_COMPENSATED");
      const compensated = outcome.stepResults.find(
        (s) => s.status === "COMPENSATED"
      );
      expect(compensated).toBeDefined();
      expect(compensated?.stepId).toBe("step-1");
    });
  });

  describe("2. Regional Recovery, Fencing & Sovereign Locality (S15, S16, OPR-FULL-045, 047, 048, 049, 050)", () => {
    it("FULL-ACC-047: strictly validates sovereign production profile and fences split-brain processes", async () => {
      // Production rejects in-memory authority
      const invalidConfig: DeploymentConfiguration = {
        authorityMode: "IN_MEMORY", // forbidden in production!
        environmentId: "prod-cell-eu-1",
        profile: "REFERENCE_PRODUCTION_CELL",
        simulatedDispatcher: false,
        storageEngine: "POSTGRESQL",
        tenantId: "tenant-enterprise-live",
        unsupportedGuarantees: [],
      };

      const invalidConfigExit = await Effect.runPromiseExit(
        validateDeploymentConfiguration(invalidConfig)
      );

      expect(Exit.isFailure(invalidConfigExit)).toBe(true);
      if (Exit.isFailure(invalidConfigExit)) {
        const err = invalidConfigExit.cause.reasons.find(
          Cause.isFailReason
        )?.error;
        expect(err).toBeInstanceOf(ProductionInMemoryAuthorityForbiddenError);
      }

      // Process A acquires writer lease (Token 1)
      const leaseProcessA = await Effect.runPromise(
        fencedWriterService.claimWriterLease(
          "tenant-enterprise-sovereign-01",
          "proc-worker-node-1"
        )
      );
      expect(leaseProcessA.fencingToken).toBe(1);

      // Process B acquires writer lease (Token 2) on failover
      const leaseProcessB = await Effect.runPromise(
        fencedWriterService.claimWriterLease(
          "tenant-enterprise-sovereign-01",
          "proc-worker-node-2"
        )
      );
      expect(leaseProcessB.fencingToken).toBe(2);

      // Stale Process A is fenced out with SplitBrainWriterFencedError
      const fencedExit = await Effect.runPromiseExit(
        fencedWriterService.dispatchFencedEffect(
          "tenant-enterprise-sovereign-01",
          "proc-worker-node-1",
          leaseProcessA.fencingToken,
          () => Effect.succeed({ status: "OK" })
        )
      );

      expect(Exit.isFailure(fencedExit)).toBe(true);
      if (Exit.isFailure(fencedExit)) {
        const err = fencedExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(SplitBrainWriterFencedError);
      }
    });

    it("FULL-ACC-045 & FULL-ACC-049: qualifies restore with verified hash chain and clean replay-free state", async () => {
      // 1. Audited backup with hash chain
      const sampleEvents = [
        {
          operationId: "op-1",
          payload: { action: "CREATE_ACCOUNT" },
          timestamp: 1000,
        },
        {
          operationId: "op-2",
          payload: { action: "DEPOSIT", amount: 1000 },
          timestamp: 2000,
        },
      ];
      const chain = buildHashChain(sampleEvents);

      const backup: AuditedBackupPackage = {
        backupId: "bk-enterprise-01",
        canonicalEntities: [{ id: "acc-1", balance: 1000 }],
        checkpointHash: chain.at(-1)!.currentHash,
        createdAt: 2500,
        decisions: [],
        definitions: [],
        hashChain: chain,
        receipts: [{ receiptId: "rcpt-1", status: "COMMITTED" }],
        sourceCellId: "cell-eu-frankfurt-01",
        tenantId: "tenant-enterprise-sovereign-01",
      };

      const metrics = await Effect.runPromise(
        backupService.qualifyRestore({
          backup,
          declaredSla: { rpoObjectiveMs: 1000, rtoObjectiveMs: 2000 },
          simulatedRestoreDurationMs: 150,
          targetCellId: "cell-eu-frankfurt-02",
        })
      );

      expect(metrics.qualificationPassed).toBe(true);
      expect(metrics.slaCompliant).toBe(true);
      expect(metrics.blocksVerified).toBe(2);

      // Tampered backup fails restore qualification
      const tamperedBackup = {
        ...backup,
        hashChain: [chain[0]!, { ...chain[1]!, payloadHash: "TAMPERED_HASH" }],
      };
      const tamperedExit = await Effect.runPromiseExit(
        backupService.qualifyRestore({
          backup: tamperedBackup,
          declaredSla: { rpoObjectiveMs: 1000, rtoObjectiveMs: 2000 },
          targetCellId: "cell-eu-frankfurt-02",
        })
      );
      expect(Exit.isFailure(tamperedExit)).toBe(true);
      if (Exit.isFailure(tamperedExit)) {
        const err = tamperedExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(BackupAuditIntegrityError);
      }

      // 2. Sovereign export & clean restore into target storage
      const cleanStorage = new InMemoryExportRestoreStorage();
      const exportBundle = await Effect.runPromise(
        exportService.createExportBundle({
          decisions: [],
          entities: [
            {
              id: "acc-1",
              lastModifiedAt: 1789000000000,
              properties: { api_token: "secret_token_123", balance: 1000 },
              typeId: "Account",
              version: 1,
            },
          ],
          evidenceDossiers: [],
          receipts: [],
          sourceCellId: "cell-eu-frankfurt-01",
          strictRejectOnSecret: false,
          tenantId: "tenant-enterprise-sovereign-01",
        })
      );

      const restoreReport = await Effect.runPromise(
        exportService.restoreBundle({
          bundle: exportBundle,
          targetCellId: "cell-eu-frankfurt-02",
          targetStorage: cleanStorage,
        })
      );

      expect(restoreReport.historicalNotificationsReplayed).toBe(0);
      expect(restoreReport.outboxSideEffectsDispatched).toBe(0);
      expect(restoreReport.queryVerificationPassed).toBe(true);
      expect(restoreReport.dossiersMatchSource).toBe(true);

      // Replay attempt fails closed
      const replayAttemptExit = await Effect.runPromiseExit(
        exportService.restoreBundle({
          attemptSideEffectReplay: true,
          bundle: exportBundle,
          targetCellId: "cell-eu-frankfurt-02",
          targetStorage: cleanStorage,
        })
      );
      expect(Exit.isFailure(replayAttemptExit)).toBe(true);
      if (Exit.isFailure(replayAttemptExit)) {
        const err = replayAttemptExit.cause.reasons.find(
          Cause.isFailReason
        )?.error;
        expect(err).toBeInstanceOf(RestoreSideEffectReplayForbiddenError);
      }
    });

    it("FULL-ACC-048 & FULL-ACC-050: throttles bursting tenant while preserving co-tenant capacity and enforces regional locality", async () => {
      const tenantA: TenantQuotaPolicy = {
        guaranteedCapacityMissions: 2,
        maxConcurrentMissions: 10,
        maxRatePerMinute: 100,
        spendBudgetCents: 50_000,
        tenantId: "tenant-burst-alpha",
      };

      const tenantB: TenantQuotaPolicy = {
        guaranteedCapacityMissions: 4,
        maxConcurrentMissions: 5,
        maxRatePerMinute: 100,
        spendBudgetCents: 50_000,
        tenantId: "tenant-enterprise-sovereign-01",
      };

      const localityA: LocalityPolicy = {
        allowedRegions: ["eu-central-1"],
        enforceStrictLocality: true,
        tenantId: "tenant-burst-alpha",
      };

      const localityB: LocalityPolicy = {
        allowedRegions: ["eu-central-1", "eu-west-1"],
        enforceStrictLocality: true,
        tenantId: "tenant-enterprise-sovereign-01",
      };

      quotaService.registerTenant(tenantA, localityA);
      quotaService.registerTenant(tenantB, localityB);

      // Cell capacity = 10. Tenant B guaranteed = 4. Tenant A attempts 7 missions -> 6 succeed, 7th throttled
      const burstExits = await Promise.all(
        Array.from({ length: 7 }, (_, i) =>
          Effect.runPromiseExit(
            quotaService.reserveMissionCapacity({
              reservationId: `r-burst-${i}`,
              tenantId: "tenant-burst-alpha",
            })
          )
        )
      );

      const successfulBurst = burstExits.filter(Exit.isSuccess);
      const throttledBurst = burstExits.filter(Exit.isFailure);

      expect(successfulBurst.length).toBe(6);
      expect(throttledBurst.length).toBe(1);

      const throttleErr = throttledBurst[0]!.cause.reasons.find(
        Cause.isFailReason
      )?.error;
      expect(throttleErr).toBeInstanceOf(TenantQuotaExceededError);

      // Tenant B can acquire all 4 of its guaranteed missions without interference
      const guaranteedExits = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          Effect.runPromiseExit(
            quotaService.reserveMissionCapacity({
              reservationId: `r-guar-${i}`,
              tenantId: "tenant-enterprise-sovereign-01",
            })
          )
        )
      );

      expect(guaranteedExits.filter(Exit.isSuccess).length).toBe(4);

      // Geographic locality fence: model invocation to unauthorized region is blocked
      const localityViolationExit = await Effect.runPromiseExit(
        quotaService.verifyLocalityEgress({
          channel: "MODEL_INVOCATION",
          targetRegion: "us-east-1",
          tenantId: "tenant-enterprise-sovereign-01",
        })
      );

      expect(Exit.isFailure(localityViolationExit)).toBe(true);
      if (Exit.isFailure(localityViolationExit)) {
        const err = localityViolationExit.cause.reasons.find(
          Cause.isFailReason
        )?.error;
        expect(err).toBeInstanceOf(RegionalLocalityViolationError);
      }
    });
  });

  describe("3. Supply-Chain Provenance, Dual Ledgers & Adversarial Defense (S17, OPR-FULL-051..054)", () => {
    it("FULL-ACC-051..054 & S17: enforces task contracts, protects adversarial tests, prevents contract version conflicts, and requires external publication gate", async () => {
      // 1. Task contract enforcement (FULL-ACC-051)
      const unapprovedContract: FactoryTaskContract = {
        approved: false,
        dependencies: ["pkg-core"],
        inputs: ["spec.json"],
        requiredEvidence: [],
        scope: [],
        taskId: "task-001",
      };
      const writeExit = await Effect.runPromiseExit(
        dualLedgerVerifier.verifyTaskExecution(unapprovedContract, "WRITE")
      );
      expect(Exit.isFailure(writeExit)).toBe(true);
      if (Exit.isFailure(writeExit)) {
        const err = writeExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(UnapprovedTaskContractError);
      }

      // 2. Adversarial scenario tamper protection (FULL-ACC-052)
      const diffExit = await Effect.runPromiseExit(
        dualLedgerVerifier.verifyDiffAgainstProtectedScenarios({
          baseProtectedScenarios: [
            "SCENARIO_AUTH",
            "SCENARIO_ADVERSARIAL_ATTACK",
          ],
          proposedScenarios: ["SCENARIO_AUTH"], // deleted attack scenario!
        })
      );
      expect(Exit.isFailure(diffExit)).toBe(true);
      if (Exit.isFailure(diffExit)) {
        const err = diffExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(AdversarialScenarioTamperError);
      }

      // 3. Contract version compatibility (FULL-ACC-053)
      const declarations: readonly ContractVersionDeclaration[] = [
        {
          contractId: "Storage",
          interfaceVersion: "1.0.0",
          moduleId: "A",
          owner: "team-1",
        },
        {
          contractId: "Storage",
          interfaceVersion: "2.0.0-incompatible",
          moduleId: "B",
          owner: "team-2",
        },
      ];
      const conflictExit = await Effect.runPromiseExit(
        dualLedgerVerifier.verifyModuleCompatibility(declarations)
      );
      expect(Exit.isFailure(conflictExit)).toBe(true);
      if (Exit.isFailure(conflictExit)) {
        const err = conflictExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(ContractRevisionConflictError);
      }

      // 4. Controlled self-hosting publication gate (FULL-ACC-054)
      const gateExit = await Effect.runPromiseExit(
        dualLedgerVerifier.verifyPublicationGate({
          externalGateSatisfied: false,
          policyDigest: "pol-anchor",
          selfModifiedExecutor: true,
          targetComponent: "executor-runtime",
        })
      );
      expect(Exit.isFailure(gateExit)).toBe(true);
      if (Exit.isFailure(gateExit)) {
        const err = gateExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(ExternalGateRequiredError);
      }

      // 5. Dual ledger adversarial mutation defense (S17)
      const normativeLedger: NormativeLedger = {
        digest: "normative-v3",
        ledgerId: "normative-v3-ledger",
        requirements: [
          {
            caseId: "CASE-1",
            description: "Check invariants",
            expectedOutcome: "PASS",
            isProtected: true,
            minimumAssertions: 1,
            requirementId: "REQ-1",
          },
        ],
        version: "3.0.0",
      };

      const droppedObservationLedger: CandidateObservationLedger = {
        candidateDigest: "cand-v3",
        observations: [], // dropped CASE-1!
        runnerId: "trusted-runner-ci",
        signature: "sig",
      };

      const mutationExit = await Effect.runPromiseExit(
        dualLedgerVerifier.verifyEvidenceAgainstNormativeLedger({
          normativeLedger,
          observationLedger: droppedObservationLedger,
          trustedRunners: ["trusted-runner-ci"],
        })
      );
      expect(Exit.isFailure(mutationExit)).toBe(true);
      if (Exit.isFailure(mutationExit)) {
        const err = mutationExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(EvidenceMutationRejectedError);
        expect((err as EvidenceMutationRejectedError).mutationType).toBe(
          "DROPPED_CASE"
        );
      }
    });
  });

  describe("4. Formal Checks (Gate I & Gate II, AssuranceCase Reports) (S19, OPR-FULL-026..030)", () => {
    it("FULL-ACC-026..030 & S19: validates bounded proof publication, differential translation, simulation containment, and Gate I/II", async () => {
      const fragment: FormalExecutableFragment = {
        assumptions: ["monotonic_ledger"],
        fragmentId: "frag-enterprise-v3",
        solverVersion: "z3-4.12.2",
        supportedActions: ["COMMIT"],
        supportedTypes: ["Ledger"],
      };

      // 1. Bounded search K=20 produces BOUNDED_NO_COUNTEREXAMPLE, rejects unbounded PROVEN_IN_MODEL (FULL-ACC-026)
      const misrepresentationExit = await Effect.runPromiseExit(
        formalService.evaluateAssuranceReport({
          candidateDigest: "cand-1",
          caseId: "case-1",
          claimedOutcome: "PROVEN_IN_MODEL",
          fragment,
          searchDepthBound: 20,
          solverFoundCounterexample: false,
        })
      );
      expect(Exit.isFailure(misrepresentationExit)).toBe(true);
      if (Exit.isFailure(misrepresentationExit)) {
        const err = misrepresentationExit.cause.reasons.find(
          Cause.isFailReason
        )?.error;
        expect(err).toBeInstanceOf(BoundedProofMisrepresentationError);
      }

      // 2. Differential translation divergence generates counterexample fixture (FULL-ACC-027)
      const divergenceExit = await Effect.runPromiseExit(
        formalService.evaluateDifferentialEquivalence({
          backendResult: { status: "ALLOW" },
          referenceInterpreterResult: { status: "DENY" },
          ruleId: "RULE_AUTHORITY",
        })
      );
      expect(Exit.isFailure(divergenceExit)).toBe(true);
      if (Exit.isFailure(divergenceExit)) {
        const err = divergenceExit.cause.reasons.find(
          Cause.isFailReason
        )?.error;
        expect(err).toBeInstanceOf(DifferentialDivergenceError);
      }

      // 3. Scenario sandbox containment blocks unsimulated dispatch (FULL-ACC-028)
      const breachPlan: ScenarioExecutionPlan = {
        actions: [{ actionName: "DISPATCH_REAL_SMS", simulated: false }],
        containedInSandbox: true,
        realCredentialsExposed: false,
        scenarioId: "scen-breach",
      };
      const breachExit = await Effect.runPromiseExit(
        formalService.executeScenarioUnderContainment({ plan: breachPlan })
      );
      expect(Exit.isFailure(breachExit)).toBe(true);
      if (Exit.isFailure(breachExit)) {
        const err = breachExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(ScenarioSandboxEscapeError);
      }

      // 4. Inconclusive evidence rejects release publication (FULL-ACC-029)
      const timeoutCase = {
        candidateDigest: "cand-1",
        caseId: "case-timeout",
        fragment,
        outcome: "TIMEOUT" as const,
        verifiedAt: Date.now(),
      };
      const rejectExit = await Effect.runPromiseExit(
        formalService.verifyReleaseQualification(
          timeoutCase,
          "BOUNDED_NO_COUNTEREXAMPLE"
        )
      );
      expect(Exit.isFailure(rejectExit)).toBe(true);
      if (Exit.isFailure(rejectExit)) {
        const err = rejectExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(InconclusiveAssuranceRejectedError);
      }

      // 5. Incremental verification consistency (FULL-ACC-030)
      const incDivergeExit = await Effect.runPromiseExit(
        formalService.evaluateIncrementalConsistency({
          fullVerdict: { allowed: true },
          incrementalVerdict: { allowed: false },
          transitiveDependenciesModified: true,
        })
      );
      expect(Exit.isFailure(incDivergeExit)).toBe(true);
      if (Exit.isFailure(incDivergeExit)) {
        const err = incDivergeExit.cause.reasons.find(
          Cause.isFailReason
        )?.error;
        expect(err).toBeInstanceOf(IncrementalVerificationDivergenceError);
      }

      // 6. Gate I and Gate II pass
      const gateI = await Effect.runPromise(
        formalService.evaluateGateI({
          executionRules: [
            { arbitrarilyBlocked: false, ruleId: "R1", satisfied: true },
          ],
        })
      );
      expect(gateI.passed).toBe(true);

      const gateII = await Effect.runPromise(
        formalService.evaluateGateII({
          claimId: "claim-01",
          evidencePointers: ["ev-hash-1"],
          policyRulesPassed: true,
        })
      );
      expect(gateII.admitted).toBe(true);
    });
  });
});
