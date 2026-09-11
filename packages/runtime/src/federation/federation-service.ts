import { randomUUID } from "node:crypto";

import type {
  FederatedRemoteClaim,
  FederatedViewContract,
  MultiCellOperationPlan,
  MultiCellOperationStep,
  MultiCellSagaOutcome,
  MultiCellStepResult,
} from "@operon/schema";
import { Cause, Clock, Effect, Exit } from "effect";

import {
  FederationAttributionMissingError,
  FederationContractExpiredError,
  FederationContractRevokedError,
  UncontractedLinkTraversalError,
} from "../actions-errors.js";
import type {
  RemoteCellCompensationError,
  RemoteCellExecutionError,
} from "../actions-errors.js";

/**
 * Interface for cell-specific step execution and compensation (OPR-FULL-046)
 */
export interface CellStepExecutor {
  readonly executeStep: (
    step: MultiCellOperationStep
  ) => Effect.Effect<string, RemoteCellExecutionError>;
  readonly executeCompensation?: (
    step: MultiCellOperationStep
  ) => Effect.Effect<string, RemoteCellCompensationError>;
}

/**
 * Traversal check outcome
 */
export interface LinkTraversalResult {
  readonly linkRelation: string;
  readonly permitted: boolean;
  readonly requestedPath: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
}

/**
 * Filtered federated view outcome
 */
export interface FilteredFederatedView {
  readonly allowedLinks: readonly string[];
  readonly exportedData: Record<string, unknown>;
  readonly schemaType: string;
}

export interface TraverseFederatedLinkOptions {
  readonly contract: FederatedViewContract;
  readonly sourceEntityId: string;
  readonly linkRelation: string;
  readonly targetEntityId: string;
  readonly currentTime?: string;
}

function extractCompensationErrorMessage(cause: Cause.Cause<unknown>): string {
  const failReason = cause.reasons.find(Cause.isFailReason);
  const failError = failReason?.error;
  if (failError && typeof failError === "object" && "message" in failError) {
    return String((failError as { message: unknown }).message);
  }
  return String(failError ?? Cause.pretty(cause));
}

const compensateSingleStep = Effect.fn("compensateSingleStep")(function* (
  step: MultiCellOperationStep,
  executeCompensation: (
    step: MultiCellOperationStep
  ) => Effect.Effect<string, unknown>,
  stepResults: MultiCellStepResult[]
): Effect.fn.Return<boolean, never> {
  const compExecutedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const compExit = yield* Effect.exit(executeCompensation(step));
  const resultIndex = stepResults.findIndex((r) => r.stepId === step.stepId);

  if (Exit.isFailure(compExit)) {
    const compError = extractCompensationErrorMessage(compExit.cause);
    if (resultIndex !== -1) {
      stepResults[resultIndex] = {
        cellId: step.cellId,
        error: `Compensation failed: ${compError}`,
        executedAt: compExecutedAt,
        status: "COMPENSATION_FAILED",
        stepId: step.stepId,
      };
    }
    return true;
  }

  if (resultIndex !== -1) {
    stepResults[resultIndex] = {
      cellId: step.cellId,
      executedAt: compExecutedAt,
      receiptId: compExit.value,
      status: "COMPENSATED",
      stepId: step.stepId,
    };
  }
  return false;
});

const compensateCommittedSteps = Effect.fn("compensateCommittedSteps")(
  function* (
    committedSteps: MultiCellOperationStep[],
    cellExecutors: Record<string, CellStepExecutor>,
    stepResults: MultiCellStepResult[]
  ): Effect.fn.Return<boolean, never> {
    const stepsToCompensate = committedSteps
      .toReversed()
      .filter((s) => s.compensatingAction);

    const outcomes = yield* Effect.forEach(
      stepsToCompensate,
      (step) => {
        const executor = cellExecutors[step.cellId];
        if (!executor?.executeCompensation) {
          return Effect.succeed(false);
        }
        return compensateSingleStep(
          step,
          executor.executeCompensation,
          stepResults
        );
      },
      { concurrency: 1 }
    );

    return outcomes.some(Boolean);
  }
);

/**
 * FederationService (S15, OPR-FULL-044, OPR-FULL-046):
 * Manages federated contracted views, selective export, uncontracted link traversal denial,
 * remote claim attribution with explicit uncertainty, and multi-cell sagas without fictional global commits.
 */
const executeSingleCellStep = Effect.fn("executeSingleCellStep")(function* (
  step: MultiCellOperationStep,
  executor: CellStepExecutor | undefined,
  coordinatorCellId: string
): Effect.fn.Return<
  | {
      readonly _tag: "Success";
      readonly step: MultiCellOperationStep;
      readonly result: MultiCellStepResult;
    }
  | {
      readonly _tag: "Failed";
      readonly result: MultiCellStepResult;
      readonly remoteClaim?: FederatedRemoteClaim;
    },
  never
> {
  const stepExecutedAt = new Date(yield* Clock.currentTimeMillis).toISOString();

  if (!executor) {
    const failureStatus = "UNREACHABLE";
    const result: MultiCellStepResult = {
      cellId: step.cellId,
      error: `No executor registered for cell "${step.cellId}"`,
      executedAt: stepExecutedAt,
      status: failureStatus,
      stepId: step.stepId,
    };

    const remoteClaim: FederatedRemoteClaim = {
      attribution: {
        assertedAt: stepExecutedAt,
        sourceAuthority: coordinatorCellId,
        sourceCellId: step.cellId,
      },
      claimId: `claim-${randomUUID()}`,
      claimType: "CELL_UNREACHABLE_PENDING",
      payload: {
        actionName: step.actionName,
        error: `No executor for cell ${step.cellId}`,
        stepPayload: step.payload,
      },
      subjectEntityId: step.stepId,
      targetCellId: coordinatorCellId,
      uncertainty: {
        reconciliationNotes: `Remote cell ${step.cellId} unreachable during saga execution`,
        status: "UNREACHABLE",
      },
    };

    return {
      _tag: "Failed" as const,
      result,
      remoteClaim,
    };
  }

  const stepExit = yield* Effect.exit(executor.executeStep(step));
  if (Exit.isFailure(stepExit)) {
    const failReason = stepExit.cause.reasons.find(Cause.isFailReason);
    const failError = failReason?.error;
    const errorMsg =
      failError && typeof failError === "object" && "message" in failError
        ? String((failError as { message: unknown }).message)
        : String(failError ?? Cause.pretty(stepExit.cause));

    const isUnreachable =
      errorMsg.toLowerCase().includes("unreachable") ||
      errorMsg.toLowerCase().includes("offline") ||
      errorMsg.toLowerCase().includes("timeout");

    const status = isUnreachable ? "UNREACHABLE" : "FAILED";

    const result: MultiCellStepResult = {
      cellId: step.cellId,
      error: errorMsg,
      executedAt: stepExecutedAt,
      status,
      stepId: step.stepId,
    };

    let remoteClaim: FederatedRemoteClaim | undefined = undefined;
    if (isUnreachable) {
      remoteClaim = {
        attribution: {
          assertedAt: stepExecutedAt,
          sourceAuthority: coordinatorCellId,
          sourceCellId: step.cellId,
        },
        claimId: `claim-${randomUUID()}`,
        claimType: "REMOTE_STEP_UNREACHABLE_PENDING",
        payload: {
          actionName: step.actionName,
          error: errorMsg,
          stepPayload: step.payload,
        },
        subjectEntityId: step.stepId,
        targetCellId: coordinatorCellId,
        uncertainty: {
          reconciliationNotes: `Remote cell ${step.cellId} timed out or offline during step ${step.stepId}`,
          status: "UNREACHABLE",
        },
      };
    }

    return {
      _tag: "Failed" as const,
      result,
      remoteClaim,
    };
  }

  const receiptId = stepExit.value;
  const result: MultiCellStepResult = {
    cellId: step.cellId,
    executedAt: stepExecutedAt,
    receiptId,
    status: "COMMITTED",
    stepId: step.stepId,
  };

  return {
    _tag: "Success" as const,
    step,
    result,
  };
});

export class FederationService {
  /**
   * Filters an entity's data according to a negotiated FederatedViewContract (OPR-FULL-044, FULL-ACC-044)
   * Any properties not explicitly in allowedProperties are omitted.
   * Access is denied if contract is revoked or expired.
   */
  filterFederatedView = Effect.fn("FederationService.filterFederatedView")(
    function* (
      this: FederationService,
      contract: FederatedViewContract,
      schemaType: string,
      entityData: Record<string, unknown>,
      currentTime?: string
    ): Effect.fn.Return<
      FilteredFederatedView,
      | FederationContractRevokedError
      | FederationContractExpiredError
      | UncontractedLinkTraversalError
    > {
      const now = yield* Clock.currentTimeMillis;
      const effectiveTime = currentTime ?? new Date(now).toISOString();

      if (contract.revoked) {
        return yield* new FederationContractRevokedError({
          contractId: contract.contractId,
          message: `Federation contract "${contract.contractId}" is revoked`,
          sourceCellId: contract.sourceCellId,
          targetCellId: contract.targetCellId,
        });
      }

      if (contract.validityWindow) {
        const attempted = Date.parse(effectiveTime);
        const until = Date.parse(contract.validityWindow.validUntil);
        const from = Date.parse(contract.validityWindow.validFrom);
        if (attempted < from || attempted > until) {
          return yield* new FederationContractExpiredError({
            attemptedAt: effectiveTime,
            contractId: contract.contractId,
            message: `Federation contract "${contract.contractId}" is outside validity window (${contract.validityWindow.validFrom} to ${contract.validityWindow.validUntil})`,
            validUntil: contract.validityWindow.validUntil,
          });
        }
      }

      if (!contract.allowedSchemaTypes.includes(schemaType)) {
        return yield* new UncontractedLinkTraversalError({
          contractId: contract.contractId,
          linkRelation: schemaType,
          message: `Schema type "${schemaType}" is not permitted under contract "${contract.contractId}"`,
          requestedPath: `schemaType:${schemaType}`,
          sourceCellId: contract.sourceCellId,
          targetCellId: contract.targetCellId,
        });
      }

      const allowedProps = contract.allowedProperties[schemaType] ?? [];
      const exportedData: Record<string, unknown> = {};
      for (const prop of allowedProps) {
        if (Object.hasOwn(entityData, prop)) {
          exportedData[prop] = entityData[prop];
        }
      }

      return {
        allowedLinks: contract.allowedLinkRelations,
        exportedData,
        schemaType,
      };
    }
  );

  /**
   * Validates whether navigation along a link relation between two cells is contracted (FULL-ACC-044)
   * Fails explicitly with UncontractedLinkTraversalError if the link is private/uncontracted.
   */
  traverseFederatedLink = Effect.fn("FederationService.traverseFederatedLink")(
    function* (
      this: FederationService,
      options: TraverseFederatedLinkOptions
    ): Effect.fn.Return<
      LinkTraversalResult,
      | FederationContractRevokedError
      | FederationContractExpiredError
      | UncontractedLinkTraversalError
    > {
      const {
        contract,
        sourceEntityId,
        linkRelation,
        targetEntityId,
        currentTime,
      } = options;
      const now = yield* Clock.currentTimeMillis;
      const effectiveTime = currentTime ?? new Date(now).toISOString();

      if (contract.revoked) {
        return yield* new FederationContractRevokedError({
          contractId: contract.contractId,
          message: `Federation contract "${contract.contractId}" is revoked`,
          sourceCellId: contract.sourceCellId,
          targetCellId: contract.targetCellId,
        });
      }

      if (contract.validityWindow) {
        const attempted = Date.parse(effectiveTime);
        const until = Date.parse(contract.validityWindow.validUntil);
        const from = Date.parse(contract.validityWindow.validFrom);
        if (attempted < from || attempted > until) {
          return yield* new FederationContractExpiredError({
            attemptedAt: effectiveTime,
            contractId: contract.contractId,
            message: `Federation contract "${contract.contractId}" is outside validity window`,
            validUntil: contract.validityWindow.validUntil,
          });
        }
      }

      const requestedPath = `${sourceEntityId} -> [${linkRelation}] -> ${targetEntityId}`;

      if (!contract.allowedLinkRelations.includes(linkRelation)) {
        return yield* new UncontractedLinkTraversalError({
          contractId: contract.contractId,
          linkRelation,
          message: `Link relation "${linkRelation}" is not contracted between cell "${contract.sourceCellId}" and cell "${contract.targetCellId}"`,
          requestedPath,
          sourceCellId: contract.sourceCellId,
          targetCellId: contract.targetCellId,
        });
      }

      return {
        linkRelation,
        permitted: true,
        requestedPath,
        sourceEntityId,
        targetEntityId,
      };
    }
  );

  /**
   * Records a remote claim, ensuring source attribution and uncertainty are explicitly retained (S15, OPR-FULL-046)
   */
  recordRemoteClaim = Effect.fn("FederationService.recordRemoteClaim")(
    function* (
      this: FederationService,
      claim: {
        readonly attribution: {
          readonly assertedAt: string;
          readonly sourceAuthority: string;
          readonly sourceCellId: string;
          readonly sourceSignature?: string;
        };
        readonly claimId?: string;
        readonly claimType: string;
        readonly payload: Record<string, unknown>;
        readonly subjectEntityId: string;
        readonly targetCellId: string;
        readonly uncertainty: {
          readonly freshnessDeadlineMs?: number;
          readonly lastVerifiedAt?: string;
          readonly reconciliationNotes?: string;
          readonly status: "FRESH" | "STALE" | "UNREACHABLE" | "DISPUTED";
        };
      }
    ): Effect.fn.Return<
      FederatedRemoteClaim,
      FederationAttributionMissingError
    > {
      const missingFields: string[] = [];
      if (!claim.attribution.sourceCellId) {
        missingFields.push("attribution.sourceCellId");
      }
      if (!claim.attribution.sourceAuthority) {
        missingFields.push("attribution.sourceAuthority");
      }
      if (!claim.attribution.assertedAt) {
        missingFields.push("attribution.assertedAt");
      }

      if (missingFields.length > 0) {
        return yield* new FederationAttributionMissingError({
          claimId: claim.claimId,
          message: `Remote claim missing mandatory attribution: ${missingFields.join(", ")}`,
          missingFields,
        });
      }

      const fullClaim: FederatedRemoteClaim = {
        attribution: claim.attribution,
        claimId: claim.claimId ?? `claim-${randomUUID()}`,
        claimType: claim.claimType,
        payload: claim.payload,
        subjectEntityId: claim.subjectEntityId,
        targetCellId: claim.targetCellId,
        uncertainty: claim.uncertainty,
      };

      return fullClaim;
    }
  );

  /**
   * Executes a multi-cell saga without promising or inventing a global commit (OPR-FULL-046, FULL-ACC-046)
   * If any step fails or becomes unreachable, previous committed steps are compensated.
   * Returns honest outcome algebra with explicit partial state and remote uncertainty.
   */
  executeMultiCellSaga = Effect.fn("FederationService.executeMultiCellSaga")(
    function* (
      this: FederationService,
      plan: MultiCellOperationPlan,
      cellExecutors: Record<string, CellStepExecutor>
    ): Effect.fn.Return<MultiCellSagaOutcome, never> {
      interface SagaState {
        readonly committedSteps: MultiCellOperationStep[];
        readonly remotePendingClaims: FederatedRemoteClaim[];
        readonly stepFailureOccurred: boolean;
        readonly stepResults: MultiCellStepResult[];
      }

      const finalState = yield* Effect.reduce(
        plan.steps,
        (): SagaState => ({
          committedSteps: [],
          remotePendingClaims: [],
          stepFailureOccurred: false,
          stepResults: [],
        }),
        (state, step) => {
          if (state.stepFailureOccurred) {
            return Effect.succeed(state);
          }
          return Effect.gen(function* () {
            const outcome = yield* executeSingleCellStep(
              step,
              cellExecutors[step.cellId],
              plan.coordinatorCellId
            );
            if (outcome._tag === "Failed") {
              return {
                committedSteps: state.committedSteps,
                remotePendingClaims: outcome.remoteClaim
                  ? [...state.remotePendingClaims, outcome.remoteClaim]
                  : state.remotePendingClaims,
                stepFailureOccurred: true,
                stepResults: [...state.stepResults, outcome.result],
              };
            }
            return {
              committedSteps: [...state.committedSteps, outcome.step],
              remotePendingClaims: state.remotePendingClaims,
              stepFailureOccurred: false,
              stepResults: [...state.stepResults, outcome.result],
            };
          });
        }
      );

      const {
        committedSteps,
        remotePendingClaims,
        stepFailureOccurred,
        stepResults,
      } = finalState;

      if (!stepFailureOccurred) {
        return {
          globalCommitPromised: false,
          operationId: plan.operationId,
          remotePendingClaims: [],
          status: "COMPLETED",
          stepResults,
        };
      }

      const anyCompensationFailed = yield* compensateCommittedSteps(
        committedSteps,
        cellExecutors,
        stepResults
      );

      return {
        globalCommitPromised: false,
        operationId: plan.operationId,
        remotePendingClaims,
        status: anyCompensationFailed
          ? "COMPENSATION_FAILED"
          : "PARTIALLY_FAILED_COMPENSATED",
        stepResults,
      };
    }
  );
}
