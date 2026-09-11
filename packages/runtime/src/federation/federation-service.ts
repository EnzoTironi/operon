import { randomUUID } from "node:crypto";

import type {
  FederatedRemoteClaim,
  FederatedViewContract,
  MultiCellOperationPlan,
  MultiCellOperationStep,
  MultiCellSagaOutcome,
  MultiCellStepResult,
} from "@operon/schema";
import { Cause, Effect, Exit } from "effect";

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

/**
 * FederationService (S15, OPR-FULL-044, OPR-FULL-046):
 * Manages federated contracted views, selective export, uncontracted link traversal denial,
 * remote claim attribution with explicit uncertainty, and multi-cell sagas without fictional global commits.
 */
export class FederationService {
  /**
   * Filters an entity's data according to a negotiated FederatedViewContract (OPR-FULL-044, FULL-ACC-044)
   * Any properties not explicitly in allowedProperties are omitted.
   * Access is denied if contract is revoked or expired.
   */
  filterFederatedView(
    contract: FederatedViewContract,
    schemaType: string,
    entityData: Record<string, unknown>,
    currentTime: string = new Date().toISOString()
  ): Effect.Effect<
    FilteredFederatedView,
    | FederationContractRevokedError
    | FederationContractExpiredError
    | UncontractedLinkTraversalError
  > {
    return Effect.gen(this, function* () {
      if (contract.revoked) {
        return yield* Effect.fail(
          new FederationContractRevokedError({
            contractId: contract.contractId,
            message: `Federation contract "${contract.contractId}" is revoked`,
            sourceCellId: contract.sourceCellId,
            targetCellId: contract.targetCellId,
          })
        );
      }

      if (contract.validityWindow) {
        const attempted = Date.parse(currentTime);
        const until = Date.parse(contract.validityWindow.validUntil);
        const from = Date.parse(contract.validityWindow.validFrom);
        if (attempted < from || attempted > until) {
          return yield* Effect.fail(
            new FederationContractExpiredError({
              attemptedAt: currentTime,
              contractId: contract.contractId,
              message: `Federation contract "${contract.contractId}" is outside validity window (${contract.validityWindow.validFrom} to ${contract.validityWindow.validUntil})`,
              validUntil: contract.validityWindow.validUntil,
            })
          );
        }
      }

      if (!contract.allowedSchemaTypes.includes(schemaType)) {
        return yield* Effect.fail(
          new UncontractedLinkTraversalError({
            contractId: contract.contractId,
            linkRelation: schemaType,
            message: `Schema type "${schemaType}" is not permitted under contract "${contract.contractId}"`,
            requestedPath: `schemaType:${schemaType}`,
            sourceCellId: contract.sourceCellId,
            targetCellId: contract.targetCellId,
          })
        );
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
    });
  }

  /**
   * Validates whether navigation along a link relation between two cells is contracted (FULL-ACC-044)
   * Fails explicitly with UncontractedLinkTraversalError if the link is private/uncontracted.
   */
  traverseFederatedLink(
    contract: FederatedViewContract,
    sourceEntityId: string,
    linkRelation: string,
    targetEntityId: string,
    currentTime: string = new Date().toISOString()
  ): Effect.Effect<
    LinkTraversalResult,
    | FederationContractRevokedError
    | FederationContractExpiredError
    | UncontractedLinkTraversalError
  > {
    return Effect.gen(this, function* () {
      if (contract.revoked) {
        return yield* Effect.fail(
          new FederationContractRevokedError({
            contractId: contract.contractId,
            message: `Federation contract "${contract.contractId}" is revoked`,
            sourceCellId: contract.sourceCellId,
            targetCellId: contract.targetCellId,
          })
        );
      }

      if (contract.validityWindow) {
        const attempted = Date.parse(currentTime);
        const until = Date.parse(contract.validityWindow.validUntil);
        const from = Date.parse(contract.validityWindow.validFrom);
        if (attempted < from || attempted > until) {
          return yield* Effect.fail(
            new FederationContractExpiredError({
              attemptedAt: currentTime,
              contractId: contract.contractId,
              message: `Federation contract "${contract.contractId}" is outside validity window`,
              validUntil: contract.validityWindow.validUntil,
            })
          );
        }
      }

      const requestedPath = `${sourceEntityId} -> [${linkRelation}] -> ${targetEntityId}`;

      if (!contract.allowedLinkRelations.includes(linkRelation)) {
        return yield* Effect.fail(
          new UncontractedLinkTraversalError({
            contractId: contract.contractId,
            linkRelation,
            message: `Link relation "${linkRelation}" is not contracted between cell "${contract.sourceCellId}" and cell "${contract.targetCellId}"`,
            requestedPath,
            sourceCellId: contract.sourceCellId,
            targetCellId: contract.targetCellId,
          })
        );
      }

      return {
        linkRelation,
        permitted: true,
        requestedPath,
        sourceEntityId,
        targetEntityId,
      };
    });
  }

  /**
   * Records a remote claim, ensuring source attribution and uncertainty are explicitly retained (S15, OPR-FULL-046)
   */
  recordRemoteClaim(claim: {
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
  }): Effect.Effect<FederatedRemoteClaim, FederationAttributionMissingError> {
    return Effect.gen(this, function* () {
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
        return yield* Effect.fail(
          new FederationAttributionMissingError({
            claimId: claim.claimId,
            message: `Remote claim missing mandatory attribution: ${missingFields.join(", ")}`,
            missingFields,
          })
        );
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
    });
  }

  /**
   * Executes a multi-cell saga without promising or inventing a global commit (OPR-FULL-046, FULL-ACC-046)
   * If any step fails or becomes unreachable, previous committed steps are compensated.
   * Returns honest outcome algebra with explicit partial state and remote uncertainty.
   */
  executeMultiCellSaga(
    plan: MultiCellOperationPlan,
    cellExecutors: Record<string, CellStepExecutor>
  ): Effect.Effect<MultiCellSagaOutcome, never> {
    return Effect.gen(this, function* () {
      const stepResults: MultiCellStepResult[] = [];
      const remotePendingClaims: FederatedRemoteClaim[] = [];
      const committedSteps: MultiCellOperationStep[] = [];
      let stepFailureOccurred = false;

      for (const step of plan.steps) {
        const executor = cellExecutors[step.cellId];
        const stepExecutedAt = new Date().toISOString();

        if (!executor) {
          stepFailureOccurred = true;
          const failureStatus = "UNREACHABLE";
          stepResults.push({
            cellId: step.cellId,
            error: `No executor registered for cell "${step.cellId}"`,
            executedAt: stepExecutedAt,
            status: failureStatus,
            stepId: step.stepId,
          });

          remotePendingClaims.push({
            attribution: {
              assertedAt: stepExecutedAt,
              sourceAuthority: plan.coordinatorCellId,
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
            targetCellId: plan.coordinatorCellId,
            uncertainty: {
              reconciliationNotes: `Remote cell ${step.cellId} unreachable during saga execution`,
              status: "UNREACHABLE",
            },
          });
          break;
        }

        const stepExit = yield* Effect.exit(executor.executeStep(step));
        if (Exit.isFailure(stepExit)) {
          stepFailureOccurred = true;
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

          stepResults.push({
            cellId: step.cellId,
            error: errorMsg,
            executedAt: stepExecutedAt,
            status,
            stepId: step.stepId,
          });

          if (isUnreachable) {
            remotePendingClaims.push({
              attribution: {
                assertedAt: stepExecutedAt,
                sourceAuthority: plan.coordinatorCellId,
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
              targetCellId: plan.coordinatorCellId,
              uncertainty: {
                reconciliationNotes: `Remote cell ${step.cellId} timed out or offline during step ${step.stepId}`,
                status: "UNREACHABLE",
              },
            });
          }
          break;
        }

        const receiptId = stepExit.value;
        stepResults.push({
          cellId: step.cellId,
          executedAt: stepExecutedAt,
          receiptId,
          status: "COMMITTED",
          stepId: step.stepId,
        });
        committedSteps.push(step);
      }

      if (!stepFailureOccurred) {
        return {
          globalCommitPromised: false,
          operationId: plan.operationId,
          remotePendingClaims: [],
          status: "COMPLETED",
          stepResults,
        };
      }

      // Rollback committed steps in reverse order using registered compensating actions
      let anyCompensationFailed = false;
      for (let i = committedSteps.length - 1; i >= 0; i--) {
        const stepToCompensate = committedSteps[i];
        if (!stepToCompensate) {
          continue;
        }

        const executor = cellExecutors[stepToCompensate.cellId];
        const compExecutedAt = new Date().toISOString();

        if (
          stepToCompensate.compensatingAction &&
          executor?.executeCompensation
        ) {
          const compExit = yield* Effect.exit(
            executor.executeCompensation(stepToCompensate)
          );

          const resultIndex = stepResults.findIndex(
            (r) => r.stepId === stepToCompensate.stepId
          );

          if (Exit.isFailure(compExit)) {
            anyCompensationFailed = true;
            const failReason = compExit.cause.reasons.find(Cause.isFailReason);
            const failError = failReason?.error;
            const compError =
              failError &&
              typeof failError === "object" &&
              "message" in failError
                ? String((failError as { message: unknown }).message)
                : String(failError ?? Cause.pretty(compExit.cause));

            if (resultIndex !== -1) {
              stepResults[resultIndex] = {
                cellId: stepToCompensate.cellId,
                error: `Compensation failed: ${compError}`,
                executedAt: compExecutedAt,
                status: "COMPENSATION_FAILED",
                stepId: stepToCompensate.stepId,
              };
            }
          } else if (resultIndex !== -1) {
            stepResults[resultIndex] = {
              cellId: stepToCompensate.cellId,
              executedAt: compExecutedAt,
              receiptId: compExit.value,
              status: "COMPENSATED",
              stepId: stepToCompensate.stepId,
            };
          }
        }
      }

      return {
        globalCommitPromised: false,
        operationId: plan.operationId,
        remotePendingClaims,
        status: anyCompensationFailed
          ? "COMPENSATION_FAILED"
          : "PARTIALLY_FAILED_COMPENSATED",
        stepResults,
      };
    });
  }
}
