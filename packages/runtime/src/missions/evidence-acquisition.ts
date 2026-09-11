import type {
  EvidenceAcquisitionAction,
  EvidenceAcquisitionReceipt,
  MissionTaskMandate,
} from "@operon/schema";
import { computeCanonicalDigest, isObjectInSet } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Clock, Context, Effect, Layer } from "effect";

import { EvidenceAcquisitionDeniedError } from "../actions-errors.js";

/**
 * Interface for authorized external or internal evidence connectors
 */
export interface EvidenceConnector {
  readonly connectorId: string;
  readonly fetchEvidence: (
    targetObjectId: string,
    queryParameters: Record<string, unknown>
  ) => Effect.Effect<Record<string, unknown> | null, Error>;
}

/**
 * Service governing Active Evidence Acquisition per S12 & OPR-FULL-022
 */
export class EvidenceAcquisitionService extends Context.Service<
  EvidenceAcquisitionService,
  {
    readonly acquireEvidence: (
      action: EvidenceAcquisitionAction,
      mandate: MissionTaskMandate,
      now?: number
    ) => Effect.Effect<
      EvidenceAcquisitionReceipt,
      EvidenceAcquisitionDeniedError
    >;

    readonly registerConnector: (
      connector: EvidenceConnector
    ) => Effect.Effect<void, never>;
  }
>()("operon/runtime/EvidenceAcquisitionService") {}

/**
 * Creates a live instance of EvidenceAcquisitionService
 */
export const EvidenceAcquisitionServiceLive = Layer.sync(
  EvidenceAcquisitionService,
  () => {
    const connectors = new Map<string, EvidenceConnector>();

    return EvidenceAcquisitionService.of({
      acquireEvidence: Effect.fn("EvidenceAcquisitionService.acquireEvidence")(
        function* (
          action: EvidenceAcquisitionAction,
          mandate: MissionTaskMandate,
          nowParam?: number
        ) {
          const now = nowParam ?? (yield* Clock.currentTimeMillis);
          // 1. Validate action class is authorized in envelope
          if (
            !mandate.envelope.allowedActionClasses.includes(action.actionClass)
          ) {
            return yield* 
              new EvidenceAcquisitionDeniedError({
                actionId: action.actionId,
                mandateId: mandate.mandateId,
                message: `Action class '${action.actionClass}' is not permitted by mandate envelope: [${mandate.envelope.allowedActionClasses.join(", ")}]`,
                reason: "ACTION_NOT_ALLOWED",
              })
            ;
          }

          // 2. Validate target object is within mandate object set
          if (
            !isObjectInSet(mandate.envelope.objectSet, action.targetObjectId)
          ) {
            return yield* 
              new EvidenceAcquisitionDeniedError({
                actionId: action.actionId,
                mandateId: mandate.mandateId,
                message: `Target object '${action.targetObjectId}' is outside mandate object set: [${mandate.envelope.objectSet.join(", ")}]`,
                reason: "OBJECT_NOT_ALLOWED",
              })
            ;
          }

          // 3. Validate budget limit
          if (
            mandate.envelope.spentBudget + action.budgetCost >
            mandate.envelope.budgetLimit
          ) {
            return yield* 
              new EvidenceAcquisitionDeniedError({
                actionId: action.actionId,
                mandateId: mandate.mandateId,
                message: `Acquisition cost ${action.budgetCost} exceeds remaining budget (${mandate.envelope.budgetLimit - mandate.envelope.spentBudget})`,
                reason: "BUDGET_EXCEEDED",
              })
            ;
          }

          // 4. Query connector
          const connector = connectors.get(action.sourceConnectorId);
          let evidencePayload: Record<string, unknown> = {};
          let status: EvidenceAcquisitionReceipt["status"] =
            "SOURCE_UNAVAILABLE";

          if (connector) {
            const fetchResult = yield* Effect.orElseSucceed(
              connector.fetchEvidence(
                action.targetObjectId,
                action.queryParameters
              ),
              () => null
            );

            if (fetchResult !== null && Object.keys(fetchResult).length > 0) {
              evidencePayload = fetchResult;
              status = "ACQUIRED";
            }
          }

          // Compute tamper-evident candidate digest
          const candidateHash = computeCanonicalDigest({
            actionId: action.actionId,
            evidencePayload,
            mandateId: mandate.mandateId,
            sourceConnectorId: action.sourceConnectorId,
            targetObjectId: action.targetObjectId,
          });

          const receipt: EvidenceAcquisitionReceipt = {
            actionId: action.actionId,
            acquiredAt: now,
            candidateHash,
            cost: action.budgetCost,
            evidencePayload,
            mandateId: mandate.mandateId,
            sourceConnectorId: action.sourceConnectorId,
            status,
            targetObjectId: action.targetObjectId,
          };

          yield* Effect.sync(() => {
            OperonTelemetryService.getInstance().trackEvent({
              event: "operon_evidence_acquired",
              properties: {
                actionId: action.actionId,
                cost: action.budgetCost,
                mandateId: mandate.mandateId,
                sourceConnectorId: action.sourceConnectorId,
                status,
                targetObjectId: action.targetObjectId,
              },
            });
          });

          return receipt;
        }
      ),

      registerConnector: Effect.fn(
        "EvidenceAcquisitionService.registerConnector"
      )((connector: EvidenceConnector) =>
        Effect.sync(() => {
          connectors.set(connector.connectorId, connector);
        })
      ),
    });
  }
);
