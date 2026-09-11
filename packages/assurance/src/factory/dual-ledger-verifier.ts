import type {
  CandidateObservationLedger,
  ContractVersionDeclaration,
  FactoryTaskContract,
  NormativeLedger,
} from "@operon/schema";
import { Clock, Effect, Option } from "effect";

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

function checkContractRequirements(
  contract: FactoryTaskContract
): readonly string[] {
  const missing: string[] = [];
  if (!contract.approved) {
    missing.push("contract_approval");
  }
  if (contract.inputs.length === 0) {
    missing.push("declared_inputs");
  }
  if (contract.scope.length === 0) {
    missing.push("declared_scope");
  }
  if (contract.dependencies.length === 0) {
    missing.push("declared_dependencies");
  }
  if (contract.requiredEvidence.length === 0) {
    missing.push("declared_required_evidence");
  }
  return missing;
}

function checkRevisionConflict(
  contractId: string,
  decls: readonly ContractVersionDeclaration[]
): Option.Option<ContractRevisionConflictError> {
  if (decls.length <= 1) {
    return Option.none();
  }
  const first = decls[0];
  if (!first) {
    return Option.none();
  }
  const hasConflict = decls.some(
    (d) => d.interfaceVersion !== first.interfaceVersion
  );
  if (!hasConflict) {
    return Option.none();
  }
  const conflictingModules = decls.map((d) => ({
    moduleId: d.moduleId,
    version: d.interfaceVersion,
  }));
  return Option.some(
    new ContractRevisionConflictError({
      conflictingModules,
      contractId,
      message: `Incompatible interface revisions detected for contract "${contractId}": parallel modules must align on the same version without silent fallback`,
    })
  );
}

function checkTrustedRunner(
  runnerId: string,
  trustedRunners: readonly string[]
): Effect.Effect<void, EvidenceMutationRejectedError> {
  if (!trustedRunners.includes(runnerId)) {
    return Effect.fail(
      new EvidenceMutationRejectedError({
        details: `Runner "${runnerId}" is not in trusted runners list [${trustedRunners.join(", ")}]`,
        message: "Untrusted runner forged or unregistered",
        mutationType: "UNTRUSTED_RUNNER",
      })
    );
  }
  return Effect.void;
}

function checkCaseIntegrity(
  normativeLedger: NormativeLedger,
  observations: CandidateObservationLedger["observations"]
): Effect.Effect<void, EvidenceMutationRejectedError> {
  const observedIds = new Set<string>();
  for (const obs of observations) {
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
  return Effect.void;
}

function verifyRequirementObservation(
  req: NormativeLedger["requirements"][number],
  obs: CandidateObservationLedger["observations"][number]
): Effect.Effect<number, EvidenceMutationRejectedError> {
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
  return Effect.succeed(obs.assertionCount);
}

const verifyAllRequirements = Effect.fn("verifyAllRequirements")(function* (
  requirements: NormativeLedger["requirements"],
  observations: CandidateObservationLedger["observations"]
): Effect.fn.Return<number, EvidenceMutationRejectedError> {
  const observationMap = new Map(observations.map((o) => [o.caseId, o]));
  let totalAssertions = 0;
  const processRequirement = Effect.fn("processRequirement")(function* (
    req: NormativeLedger["requirements"][number]
  ) {
    const obs = observationMap.get(req.caseId);
    if (obs) {
      const count = yield* verifyRequirementObservation(req, obs);
      totalAssertions += count;
    }
  });
  yield* Effect.forEach(requirements, processRequirement, { concurrency: 1 });
  return totalAssertions;
});

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

    const missingRequirements = checkContractRequirements(contract);
    if (missingRequirements.length > 0) {
      return Effect.fail(
        new UnapprovedTaskContractError({
          message: `Protected write denied for task "${contract.taskId}": missing mandatory contract specifications [${missingRequirements.join(", ")}]`,
          missingRequirements: [...missingRequirements],
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
    const contractsMap = new Map<string, ContractVersionDeclaration[]>();
    for (const decl of declarations) {
      const existing = contractsMap.get(decl.contractId) ?? [];
      existing.push(decl);
      contractsMap.set(decl.contractId, existing);
    }

    for (const [contractId, decls] of contractsMap.entries()) {
      const conflict = checkRevisionConflict(contractId, decls);
      if (Option.isSome(conflict)) {
        return Effect.fail(conflict.value);
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
    return Effect.gen(function* () {
      yield* checkTrustedRunner(observationLedger.runnerId, trustedRunners);
      yield* checkCaseIntegrity(
        normativeLedger,
        observationLedger.observations
      );
      const totalAssertions = yield* verifyAllRequirements(
        normativeLedger.requirements,
        observationLedger.observations
      );

      return {
        candidateDigest: observationLedger.candidateDigest,
        matchedCasesCount: normativeLedger.requirements.length,
        normativeLedgerId: normativeLedger.ledgerId,
        runnerId: observationLedger.runnerId,
        totalAssertions,
        verifiedAt: yield* Clock.currentTimeMillis,
      };
    });
  }
}
