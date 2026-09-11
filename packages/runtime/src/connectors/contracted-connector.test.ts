import type {
  ConnectorContractDeclaration,
  PackageConnectorRequirement,
} from "@operon/schema";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  BrokerCredentialViolationError,
  BusinessAuthorityMissingError,
  ConnectorCapabilityMismatchError,
  OutboundExecutionFailedError,
} from "../actions-errors.js";
import {
  ContractedConnectorService,
  ContractedConnectorServiceLive,
} from "./contracted-connector.js";

describe("Contracted Connectors & Outbound Boundaries (Gate G3 / WS09 / S15)", () => {
  const referencePostgresConnector: ConnectorContractDeclaration = {
    capabilities: {
      isolationLevel: "SERIALIZABLE",
      maxBatchSize: 10_000,
      sourceFreshnessIntervalMs: 5000,
      supportsAtomicBatch: true,
      supportsChangeDataCapture: true,
      supportsCompensatingActions: true,
      supportsConditionalWrites: true,
      supportsIdempotencyKeys: true,
    },
    connectorId: "conn-postgres-ref",
    connectorVersion: "1.0.0",
    credentialIsolationBoundary: "BROKER_WORKER",
    sourceSystem: "PostgreSQL-Operational",
    transport: "CDC",
  };

  const simpleWebhookConnector: ConnectorContractDeclaration = {
    capabilities: {
      isolationLevel: "NONE",
      maxBatchSize: 1,
      sourceFreshnessIntervalMs: 60_000,
      supportsAtomicBatch: false,
      supportsChangeDataCapture: false,
      supportsCompensatingActions: false,
      supportsConditionalWrites: false, // Lacks conditional writes!
      supportsIdempotencyKeys: false,
    },
    connectorId: "conn-simple-webhook",
    connectorVersion: "1.0.0",
    credentialIsolationBoundary: "BROKER_WORKER",
    sourceSystem: "LegacyWebhook",
    transport: "WEBHOOK",
  };

  describe("Connector Capability Verification (FULL-ACC-043 / OPR-FULL-043)", () => {
    it("does reject connector contract explicitly when package requires conditional writes but source lacks it", async () => {
      const financialRequirement: PackageConnectorRequirement = {
        packageId: "operon.pkg.finance-ledger",
        requiredCapabilities: {
          supportsConditionalWrites: true,
          supportsIdempotencyKeys: true,
        },
      };

      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.validateConnectorContract({
          declaration: simpleWebhookConnector,
          requirement: financialRequirement,
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(ConnectorCapabilityMismatchError.name);
        expect(causeStr).toContain("supportsConditionalWrites");
        expect(causeStr).toContain("conn-simple-webhook");
        expect(causeStr).toContain("operon.pkg.finance-ledger");
      }
    });

    it("does accept connector contract when all demanded capabilities are satisfied", async () => {
      const clinicalRequirement: PackageConnectorRequirement = {
        packageId: "operon.pkg.clinical-operations",
        requiredCapabilities: {
          supportsAtomicBatch: true,
          supportsChangeDataCapture: true,
          supportsConditionalWrites: true,
          supportsIdempotencyKeys: true,
        },
      };

      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.validateConnectorContract({
          declaration: referencePostgresConnector,
          requirement: clinicalRequirement,
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.compatible).toBe(true);
    });
  });

  describe("Outbound Credential Isolation & Token Boundaries (FULL-ACC-044 / OPR-FULL-044)", () => {
    it("does deny outbound execution when IntentGrant is missing despite valid bearer token", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.executeOutboundOperation({
          actorId: "agent-007",
          bearerToken: "bearer-token-secret-xyz",
          executeRemote: () => Effect.succeed({ result: "should-not-run" }),
          intentGrantId: undefined, // Missing IntentGrant!
          operation: {
            actionName: "DISPATCH_PAYMENT",
            idempotencyKeyField: "paymentRef",
            operationId: "op-wire-transfer-404",
            requiresBusinessGrant: true,
            retryable: false,
            timeoutMs: 5000,
          },
          payload: { amountUsd: 100_000 },
          targetSystem: "SWIFT-Gateway",
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(BusinessAuthorityMissingError.name);
        expect(causeStr).toContain("op-wire-transfer-404");
        expect(causeStr).toContain("agent-007");
        expect(causeStr).toContain('"tokenPresent":true');
      }
    });

    it("does prevent agent from directly extracting broker credentials", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.extractBrokerCredentials({
          actorId: "untrusted-agent",
          actorType: "AGENT", // Agent actor!
          connectorId: "conn-postgres-ref",
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(BrokerCredentialViolationError.name);
        expect(causeStr).toContain("untrusted-agent");
        expect(causeStr).toContain("conn-postgres-ref");
      }
    });

    it("does allow broker worker to access credentials at the boundary", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.extractBrokerCredentials({
          actorId: "worker-pool-internal",
          actorType: "BROKER_WORKER",
          connectorId: "conn-postgres-ref",
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.credentialsAvailable).toBe(true);
    });
  });

  describe("Compensation on Outbound Failure (OUTBOUND-COMP-001 / OPR-FULL-044)", () => {
    it("does execute compensating action when outbound remote execution fails", async () => {
      let compensationExecuted = false;

      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.executeOutboundOperation({
          actorId: "authorized-agent",
          compensateRemote: () =>
            Effect.sync(() => {
              compensationExecuted = true;
            }),
          executeRemote: () =>
            Effect.fail(
              new OutboundExecutionFailedError({
                message: "Downstream third-party API timeout",
                operationId: "op-stock-reserve-12",
                targetSystem: "Supplier-ERP",
              })
            ),
          intentGrantId: "grant-auth-99",
          operation: {
            actionName: "RESERVE_EXTERNAL_STOCK",
            compensationAction: "RELEASE_EXTERNAL_STOCK",
            idempotencyKeyField: "reservationId",
            operationId: "op-stock-reserve-12",
            requiresBusinessGrant: true,
            retryable: true,
            timeoutMs: 3000,
          },
          payload: { partId: "VALVE-40", qty: 2 },
          targetSystem: "Supplier-ERP",
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(compensationExecuted).toBe(true);
    });

    it("does emit invocation receipt with status EXECUTED when outbound dispatch succeeds", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        return yield* service.executeOutboundOperation({
          actorId: "authorized-agent",
          executeRemote: () =>
            Effect.succeed({ ack: true, ref: "EXT-CONFIRM-1" }),
          intentGrantId: "grant-auth-99",
          operation: {
            actionName: "NOTIFY_DISPATCH",
            idempotencyKeyField: "dispatchId",
            operationId: "op-notify-dispatch-1",
            requiresBusinessGrant: true,
            retryable: true,
            timeoutMs: 3000,
          },
          payload: { orderId: "ORD-999" },
          targetSystem: "Logistics-Hub",
        });
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const receipt = await Effect.runPromise(program);
      expect(receipt.status).toBe("EXECUTED");
      expect(receipt.operationId).toBe("op-notify-dispatch-1");
      expect(receipt.targetSystem).toBe("Logistics-Hub");
      expect(receipt.idempotencyKey).toContain("idemp-op-notify-dispatch-1-");
      expect(receipt.receiptDigest).toContain(
        "sha256-receipt-op-notify-dispatch-1-"
      );
    });
  });

  describe("Inbound Checkpoints & Source Freshness", () => {
    it("does advance and track ingestion checkpoints", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;
        const adv1 = yield* service.advanceIngestionCheckpoint({
          connectorId: "conn-postgres-ref",
          lsn: 104_8576,
          timestampMs: Date.now(),
        });
        const adv2 = yield* service.advanceIngestionCheckpoint({
          connectorId: "conn-postgres-ref",
          lsn: 104_8600,
          timestampMs: Date.now(),
        });
        return { adv1, adv2 };
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.adv1.currentLsn).toBe(104_8576);
      expect(result.adv2.currentLsn).toBe(104_8600);
    });

    it("does detect stale sources when lag exceeds freshness interval", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ContractedConnectorService;

        // Fresh: received 2 seconds ago, freshness limit is 5 seconds
        const freshCheck = yield* service.checkSourceFreshness({
          declaration: referencePostgresConnector,
          lastReceivedTimestampMs: Date.now() - 2000,
        });

        // Stale: received 10 seconds ago, freshness limit is 5 seconds
        const staleCheck = yield* service.checkSourceFreshness({
          declaration: referencePostgresConnector,
          lastReceivedTimestampMs: Date.now() - 10_000,
        });

        return { freshCheck, staleCheck };
      }).pipe(Effect.provide(ContractedConnectorServiceLive));

      const { freshCheck, staleCheck } = await Effect.runPromise(program);
      expect(freshCheck.fresh).toBe(true);
      expect(staleCheck.fresh).toBe(false);
      expect(staleCheck.lagMs).toBeGreaterThanOrEqual(10_000);
    });
  });
});
