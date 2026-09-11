import type {
  ConnectorContractDeclaration,
  OutboundInvocationReceipt,
  OutboundOperationDeclaration,
  PackageConnectorRequirement,
} from "@operon/schema";
import { Clock, Context, Effect, Exit, Layer } from "effect";

import type { OutboundExecutionFailedError } from "../actions-errors.js";
import {
  BrokerCredentialViolationError,
  BusinessAuthorityMissingError,
  ConnectorCapabilityMismatchError,
} from "../actions-errors.js";

/**
 * Service governing contracted connectors, capability verification, outbound credential boundaries, and compensation (S15, OPR-FULL-043, OPR-FULL-044)
 */
export class ContractedConnectorService extends Context.Service<
  ContractedConnectorService,
  {
    readonly advanceIngestionCheckpoint: (params: {
      readonly connectorId: string;
      readonly lsn: number;
      readonly timestampMs: number;
    }) => Effect.Effect<
      { readonly advanced: true; readonly currentLsn: number },
      never
    >;

    readonly checkSourceFreshness: (params: {
      readonly declaration: ConnectorContractDeclaration;
      readonly lastReceivedTimestampMs: number;
    }) => Effect.Effect<
      { readonly fresh: boolean; readonly lagMs: number },
      never
    >;

    readonly executeOutboundOperation: (params: {
      readonly actorId: string;
      readonly bearerToken?: string;
      readonly compensateRemote?: () => Effect.Effect<void, never>;
      readonly executeRemote: () => Effect.Effect<
        Record<string, unknown>,
        OutboundExecutionFailedError
      >;
      readonly intentGrantId?: string;
      readonly operation: OutboundOperationDeclaration;
      readonly payload: Record<string, unknown>;
      readonly targetSystem: string;
    }) => Effect.Effect<
      OutboundInvocationReceipt,
      BusinessAuthorityMissingError | OutboundExecutionFailedError
    >;

    readonly extractBrokerCredentials: (params: {
      readonly actorId: string;
      readonly actorType: "AGENT" | "BROKER_WORKER";
      readonly connectorId: string;
    }) => Effect.Effect<
      { readonly credentialsAvailable: true },
      BrokerCredentialViolationError
    >;

    readonly validateConnectorContract: (params: {
      readonly declaration: ConnectorContractDeclaration;
      readonly requirement: PackageConnectorRequirement;
    }) => Effect.Effect<
      { readonly compatible: true },
      ConnectorCapabilityMismatchError
    >;
  }
>()("operon/runtime/ContractedConnectorService") {}

/**
 * Live layer for ContractedConnectorService
 */
export const ContractedConnectorServiceLive = Layer.sync(
  ContractedConnectorService,
  () => {
    const checkpoints = new Map<string, number>();

    return ContractedConnectorService.of({
      advanceIngestionCheckpoint: Effect.fn(
        "ContractedConnectorService.advanceIngestionCheckpoint"
      )((params) =>
        Effect.sync(() => {
          checkpoints.set(params.connectorId, params.lsn);
          return {
            advanced: true,
            currentLsn: params.lsn,
          };
        })
      ),

      checkSourceFreshness: Effect.fn(
        "ContractedConnectorService.checkSourceFreshness"
      )(function* (params) {
        const now = yield* Clock.currentTimeMillis;
        const lagMs = Math.max(0, now - params.lastReceivedTimestampMs);
        const fresh =
          lagMs <= params.declaration.capabilities.sourceFreshnessIntervalMs;
        return { fresh, lagMs };
      }),

      executeOutboundOperation: Effect.fn(
        "ContractedConnectorService.executeOutboundOperation"
      )(function* (params) {
        const {
          actorId,
          bearerToken,
          compensateRemote,
          executeRemote,
          intentGrantId,
          operation,
          targetSystem,
        } = params;

        // OPR-FULL-044 Invariant: Token availability does NOT grant business authority!
        if (operation.requiresBusinessGrant && !intentGrantId) {
          return yield* 
            new BusinessAuthorityMissingError({
              actorId,
              message: `Outbound operation '${operation.operationId}' denied: missing required IntentGrant. Bearer token presence does not confer business authority.`,
              operationId: operation.operationId,
              tokenPresent: bearerToken !== undefined && bearerToken.length > 0,
            })
          ;
        }

        const timestamp = yield* Clock.currentTimeMillis;
        const idempotencyKey = `idemp-${operation.operationId}-${timestamp}`;

        // Attempt remote dispatch
        const remoteExit = yield* Effect.exit(executeRemote());
        if (Exit.isFailure(remoteExit)) {
          if (compensateRemote) {
            yield* compensateRemote();
          }
          return yield* Effect.failCause(remoteExit.cause);
        }

        const receiptDigest = `sha256-receipt-${operation.operationId}-${timestamp}`;

        const receipt: OutboundInvocationReceipt = {
          dispatchedAt: timestamp,
          idempotencyKey,
          operationId: operation.operationId,
          receiptDigest,
          status: "EXECUTED",
          targetSystem,
        };

        return receipt;
      }),

      extractBrokerCredentials: Effect.fn(
        "ContractedConnectorService.extractBrokerCredentials"
      )(function* (params) {
        // OPR-FULL-044 Invariant: Credentials live in broker/worker boundary, NEVER in agent filesystem!
        if (params.actorType === "AGENT") {
          return yield* 
            new BrokerCredentialViolationError({
              actorId: params.actorId,
              connectorId: params.connectorId,
              message: `Security violation: Agent '${params.actorId}' attempted direct credential access for connector '${params.connectorId}'. Credentials isolated to broker boundary.`,
            })
          ;
        }

        return { credentialsAvailable: true };
      }),

      validateConnectorContract: Effect.fn(
        "ContractedConnectorService.validateConnectorContract"
      )(function* (params) {
        const { declaration, requirement } = params;
        const req = requirement.requiredCapabilities;

        // OPR-FULL-043 Invariant: Explicit failure when source lacks required guarantees!
        if (
          req.supportsConditionalWrites &&
          !declaration.capabilities.supportsConditionalWrites
        ) {
          return yield* 
            new ConnectorCapabilityMismatchError({
              connectorId: declaration.connectorId,
              message: `Connector '${declaration.connectorId}' does not support conditional writes demanded by package '${requirement.packageId}'. Incompatibility is explicit and cannot be bypassed.`,
              packageId: requirement.packageId,
              providedValue: false,
              requiredCapability: "supportsConditionalWrites",
            })
          ;
        }

        if (
          req.supportsIdempotencyKeys &&
          !declaration.capabilities.supportsIdempotencyKeys
        ) {
          return yield* 
            new ConnectorCapabilityMismatchError({
              connectorId: declaration.connectorId,
              message: `Connector '${declaration.connectorId}' does not support idempotency keys demanded by package '${requirement.packageId}'. Incompatibility is explicit and cannot be bypassed.`,
              packageId: requirement.packageId,
              providedValue: false,
              requiredCapability: "supportsIdempotencyKeys",
            })
          ;
        }

        if (
          req.supportsCompensatingActions &&
          !declaration.capabilities.supportsCompensatingActions
        ) {
          return yield* 
            new ConnectorCapabilityMismatchError({
              connectorId: declaration.connectorId,
              message: `Connector '${declaration.connectorId}' does not support compensating actions demanded by package '${requirement.packageId}'.`,
              packageId: requirement.packageId,
              providedValue: false,
              requiredCapability: "supportsCompensatingActions",
            })
          ;
        }

        if (
          req.supportsAtomicBatch &&
          !declaration.capabilities.supportsAtomicBatch
        ) {
          return yield* 
            new ConnectorCapabilityMismatchError({
              connectorId: declaration.connectorId,
              message: `Connector '${declaration.connectorId}' does not support atomic batch operations demanded by package '${requirement.packageId}'.`,
              packageId: requirement.packageId,
              providedValue: false,
              requiredCapability: "supportsAtomicBatch",
            })
          ;
        }

        if (
          req.supportsChangeDataCapture &&
          !declaration.capabilities.supportsChangeDataCapture
        ) {
          return yield* 
            new ConnectorCapabilityMismatchError({
              connectorId: declaration.connectorId,
              message: `Connector '${declaration.connectorId}' does not support Change Data Capture demanded by package '${requirement.packageId}'.`,
              packageId: requirement.packageId,
              providedValue: false,
              requiredCapability: "supportsChangeDataCapture",
            })
          ;
        }

        return { compatible: true };
      }),
    });
  }
);
