import type {
  CandidateObservationLedger,
  ContractVersionDeclaration,
  FactoryTaskContract,
  NormativeLedger,
} from "@operon/schema";
import { Effect } from "effect";

import {
  AdversarialScenarioTamperError,
  ContractRevisionConflictError,
  EvidenceMutationRejectedError,
  ExternalGateRequiredError,
  UnapprovedTaskContractError,
} from "../errors.js";

/**
 * Verification summary for dual ledger comparison
 */
export interface DualLedgerVerificationReport {
  readonly candidateDigest: string;
  readonly matchedCasesCount: number;
  readonly normativeLedgerId: string;
  readonly runnerId: string;
  readonly totalAssertions: number;
  readonly verifiedAt: number;
}

/**
 * DualLedgerVerifier (S17, OPR-FULL-051..054):
 * Manages normative vs candidate observation ledgers, task contract authorization,
 * adversarial scenario protection, module compatibility, and external publication gates.
 */
export class DualLedgerVerifier {
  /**
   * Verifies task contract authorization before granting write permission (FULL-ACC-051)
   */
  verifyTaskExecution(
    contract: FactoryTaskContract,
    requestedAction: "READ" | "WRITE"
  ): Effect.Effect<boolean, UnapprovedTaskContractError> {
    if (requestedAction === "READ") {
      return Effect.succeed(true);
    }

    const missingRequirements: string[] = [];

    if (!contract.approved) {
      missingRequirements.push("contract_approval");
    }
    if (contract.inputs.length === 0) {
      missingRequirements.push("declared_inputs");
    }
    if (contract.scope.length === 0) {
      missingRequirements.push("declared_scope");
    }
    if (contract.dependencies.length === 0) {
      missingRequirements.push("declared_dependencies");
    }
    if (contract.requiredEvidence.length === 0) {
      missingRequirements.push("declared_required_evidence");
    }

    if (missingRequirements.length > 0) {
      return Effect.fail(
        new UnapprovedTaskContractError({
          message: `Protected write denied for task "${contract.taskId}": missing mandatory contract specifications [${missingRequirements.join(", ")}]`,
          missingRequirements,
          taskId: contract.taskId,
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Verifies that an implementer diff does not delete or weaken protected adversarial scenarios (FULL-ACC-052)
   */
  verifyDiffAgainstProtectedScenarios(params: {
    readonly baseProtectedScenarios: readonly string[];
    readonly proposedScenarios: readonly string[];
  }): Effect.Effect<boolean, AdversarialScenarioTamperError> {
    const proposedSet = new Set(params.proposedScenarios);
    const removedScenarios = params.baseProtectedScenarios.filter(
      (scenarioId) => !proposedSet.has(scenarioId)
    );

    if (removedScenarios.length > 0) {
      return Effect.fail(
        new AdversarialScenarioTamperError({
          message: `Implementer diff rejected: ${removedScenarios.length} protected adversarial scenario(s) were removed or modified [${removedScenarios.join(", ")}]`,
          removedScenarios,
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Verifies that parallel modules use compatible contract interface revisions (FULL-ACC-053)
   */
  verifyModuleCompatibility(
    declarations: readonly ContractVersionDeclaration[]
  ): Effect.Effect<boolean, ContractRevisionConflictError> {
    // Group declarations by contractId
    const contractsMap = new Map<string, ContractVersionDeclaration[]>();

    for (const decl of declarations) {
      const existing = contractsMap.get(decl.contractId) ?? [];
      existing.push(decl);
      contractsMap.set(decl.contractId, existing);
    }

    for (const [contractId, decls] of contractsMap.entries()) {
      if (decls.length > 1) {
        const firstVersion = decls[0]!.interfaceVersion;
        const hasConflict = decls.some(
          (d) => d.interfaceVersion !== firstVersion
        );

        if (hasConflict) {
          const conflictingModules = decls.map((d) => ({
            moduleId: d.moduleId,
            version: d.interfaceVersion,
          }));

          return Effect.fail(
            new ContractRevisionConflictError({
              conflictingModules,
              contractId,
              message: `Incompatible interface revisions detected for contract "${contractId}": parallel modules must align on the same version without silent fallback`,
            })
          );
        }
      }
    }

    return Effect.succeed(true);
  }

  /**
   * Enforces external publication gate when factory self-modifies its own executor (FULL-ACC-054)
   */
  verifyPublicationGate(params: {
    readonly externalGateSatisfied: boolean;
    readonly policyDigest: string;
    readonly selfModifiedExecutor: boolean;
    readonly targetComponent: string;
  }): Effect.Effect<boolean, ExternalGateRequiredError> {
    if (params.selfModifiedExecutor && !params.externalGateSatisfied) {
      return Effect.fail(
        new ExternalGateRequiredError({
          message: `Self-modification to platform executor component "${params.targetComponent}" cannot bypass external publication gate. The prevailing policy (${params.policyDigest}) remains mandatory.`,
          policyDigest: params.policyDigest,
          targetComponent: params.targetComponent,
        })
      );
    }

    return Effect.succeed(true);
  }

  /**
   * Verifies candidate observations ledger against normative requirements ledger with adversarial mutation defense (S17)
   */
  verifyEvidenceAgainstNormativeLedger(params: {
    readonly normativeLedger: NormativeLedger;
    readonly observationLedger: CandidateObservationLedger;
    readonly trustedRunners: readonly string[];
  }): Effect.Effect<
    DualLedgerVerificationReport,
    EvidenceMutationRejectedError
  > {
    const { normativeLedger, observationLedger, trustedRunners } = params;

    // 1. Untrusted runner check
    if (!trustedRunners.includes(observationLedger.runnerId)) {
      return Effect.fail(
        new EvidenceMutationRejectedError({
          details: `Runner "${observationLedger.runnerId}" is not in trusted runners list [${trustedRunners.join(", ")}]`,
          message: "Untrusted runner forged or unregistered",
          mutationType: "UNTRUSTED_RUNNER",
        })
      );
    }

    // 2. Duplicate case detection
    const observedIds = new Set<string>();
    for (const obs of observationLedger.observations) {
      if (observedIds.has(obs.caseId)) {
        return Effect.fail(
          new EvidenceMutationRejectedError({
            details: `Observation ledger contains duplicate entry for case "${obs.caseId}"`,
            message: "Adversarial duplicate case mutation detected",
            mutationType: "DUPLICATE_CASE",
          })
        );
      }
      observedIds.add(obs.caseId);
    }

    // 3. Dropped case detection against normative requirements ledger
    for (const req of normativeLedger.requirements) {
      if (!observedIds.has(req.caseId)) {
        return Effect.fail(
          new EvidenceMutationRejectedError({
            details: `Normative requirement "${req.caseId}" (${req.requirementId}) is missing from candidate observations`,
            message: "Adversarial dropped case mutation detected",
            mutationType: "DROPPED_CASE",
          })
        );
      }
    }

    // 4. Zero assertions detection and outcome verification
    let totalAssertions = 0;
    const observationMap = new Map(
      observationLedger.observations.map((o) => [o.caseId, o])
    );

    for (const req of normativeLedger.requirements) {
      const obs = observationMap.get(req.caseId)!;

      if (obs.status === "PASS" && obs.assertionCount === 0) {
        return Effect.fail(
          new EvidenceMutationRejectedError({
            details: `Case "${req.caseId}" reported PASS with 0 assertions`,
            message: "Adversarial zero-assertion pass detected",
            mutationType: "ZERO_ASSERTIONS",
          })
        );
      }

      if (obs.assertionCount < req.minimumAssertions) {
        return Effect.fail(
          new EvidenceMutationRejectedError({
            details: `Case "${req.caseId}" executed with ${obs.assertionCount} assertions, below normative minimum of ${req.minimumAssertions}`,
            message: "Adversarial insufficient assertions mutation detected",
            mutationType: "ZERO_ASSERTIONS",
          })
        );
      }

      if (obs.status !== req.expectedOutcome) {
        return Effect.fail(
          new EvidenceMutationRejectedError({
            details: `Case "${req.caseId}" produced outcome "${obs.status}", expected normative outcome "${req.expectedOutcome}"`,
            message: "Adversarial receipt tampering or test failure detected",
            mutationType: "RECEIPT_TAMPERED",
          })
        );
      }

      totalAssertions += obs.assertionCount;
    }

    return Effect.succeed({
      candidateDigest: observationLedger.candidateDigest,
      matchedCasesCount: normativeLedger.requirements.length,
      normativeLedgerId: normativeLedger.ledgerId,
      runnerId: observationLedger.runnerId,
      totalAssertions,
      verifiedAt: Date.now(),
    });
  }
}
