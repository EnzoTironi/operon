import type {
  FederatedViewContract,
  MultiCellOperationPlan,
} from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  FederationAttributionMissingError,
  FederationContractExpiredError,
  FederationContractRevokedError,
  RemoteCellCompensationError,
  RemoteCellExecutionError,
  UncontractedLinkTraversalError,
} from "../actions-errors.js";
import { FederationService } from "./federation-service.js";

describe("FederationService (S15, OPR-FULL-044, OPR-FULL-046)", () => {
  const service = new FederationService();

  const sampleContract: FederatedViewContract = {
    allowedLinkRelations: ["public_tracking", "carrier_milestones"],
    allowedProperties: {
      "order.PublicStatus": ["orderId", "status", "estimatedDeliveryDate"],
    },
    allowedPurposes: ["ORDER_TRACKING_COLLABORATION"],
    allowedSchemaTypes: ["order.PublicStatus"],
    contractId: "contract-corp-a-to-corp-b",
    revoked: false,
    sourceCellId: "cell-company-alpha",
    targetCellId: "cell-partner-beta",
    tenantId: "tenant-enterprise-shared",
    validityWindow: {
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
    },
  };

  describe("Selective Sharing & Uncontracted Link Traversal Denial (OPR-FULL-044, FULL-ACC-044)", () => {
    it("FULL-ACC-044.T01: export filters uncontracted private fields from view", async () => {
      const rawEntityData = {
        customerInternalNotes: "VIP client; priority escalation",
        customerSSN: "000-12-3456",
        estimatedDeliveryDate: "2026-09-15T14:00:00.000Z",
        internalCostBasis: 420.5,
        orderId: "order-9901",
        profitMarginPct: 35.8,
        status: "DISPATCHED",
      };

      const result = await Effect.runPromise(
        service.filterFederatedView(
          sampleContract,
          "order.PublicStatus",
          rawEntityData,
          "2026-09-11T12:00:00.000Z"
        )
      );

      expect(result.schemaType).toBe("order.PublicStatus");
      expect(result.exportedData).toEqual({
        estimatedDeliveryDate: "2026-09-15T14:00:00.000Z",
        orderId: "order-9901",
        status: "DISPATCHED",
      });
      // Verify confidential properties are stripped
      expect(result.exportedData.customerSSN).toBeUndefined();
      expect(result.exportedData.profitMarginPct).toBeUndefined();
      expect(result.exportedData.internalCostBasis).toBeUndefined();
    });

    it("FULL-ACC-044.T02: traversing contracted link succeeds; traversing private/uncontracted link fails explicitly with UncontractedLinkTraversalError", async () => {
      // Contracted link traversal succeeds
      const contractedLink = await Effect.runPromise(
        service.traverseFederatedLink({
          contract: sampleContract,
          currentTime: "2026-09-11T12:00:00.000Z",
          linkRelation: "public_tracking",
          sourceEntityId: "order-9901",
          targetEntityId: "shipment-trk-5541",
        })
      );
      expect(contractedLink.permitted).toBe(true);
      expect(contractedLink.linkRelation).toBe("public_tracking");

      // Private uncontracted link traversal is denied
      const uncontractedAttempt = await Effect.runPromiseExit(
        service.traverseFederatedLink({
          contract: sampleContract,
          currentTime: "2026-09-11T12:00:00.000Z",
          linkRelation: "internal_financial_ledger",
          sourceEntityId: "order-9901",
          targetEntityId: "ledger-entry-882",
        })
      );

      expect(Exit.isFailure(uncontractedAttempt)).toBe(true);
      if (Exit.isFailure(uncontractedAttempt)) {
        const failReason = uncontractedAttempt.cause.reasons.find(
          Cause.isFailReason
        );
        const err = failReason?.error;
        expect(err).toBeInstanceOf(UncontractedLinkTraversalError);
        if (err instanceof UncontractedLinkTraversalError) {
          expect(err._tag).toBe("UncontractedLinkTraversalError");
          expect(err.contractId).toBe("contract-corp-a-to-corp-b");
          expect(err.linkRelation).toBe("internal_financial_ledger");
          expect(err.requestedPath).toContain(
            "order-9901 -> [internal_financial_ledger]"
          );
        }
      }
    });

    it("FULL-ACC-044.T03: fails with FederationContractRevokedError when contract is revoked", async () => {
      const revokedContract: FederatedViewContract = {
        ...sampleContract,
        revoked: true,
      };

      const result = await Effect.runPromiseExit(
        service.traverseFederatedLink({
          contract: revokedContract,
          currentTime: "2026-09-11T12:00:00.000Z",
          linkRelation: "public_tracking",
          sourceEntityId: "order-9901",
          targetEntityId: "shipment-trk-5541",
        })
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failReason = result.cause.reasons.find(Cause.isFailReason);
        const err = failReason?.error;
        expect(err).toBeInstanceOf(FederationContractRevokedError);
        if (err instanceof FederationContractRevokedError) {
          expect(err._tag).toBe("FederationContractRevokedError");
        }
      }
    });

    it("FULL-ACC-044.T04: fails with FederationContractExpiredError when accessing outside validity window", async () => {
      const expiredContract: FederatedViewContract = {
        ...sampleContract,
        validityWindow: {
          validFrom: "2025-01-01T00:00:00.000Z",
          validUntil: "2025-12-31T23:59:59.000Z",
        },
      };

      const result = await Effect.runPromiseExit(
        service.traverseFederatedLink({
          contract: expiredContract,
          currentTime: "2026-09-11T12:00:00.000Z",
          linkRelation: "public_tracking",
          sourceEntityId: "order-9901",
          targetEntityId: "shipment-trk-5541",
        })
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failReason = result.cause.reasons.find(Cause.isFailReason);
        const err = failReason?.error;
        expect(err).toBeInstanceOf(FederationContractExpiredError);
        if (err instanceof FederationContractExpiredError) {
          expect(err._tag).toBe("FederationContractExpiredError");
        }
      }
    });
  });

  describe("Remote Claim Attribution & Explicit Uncertainty (S15, OPR-FULL-046)", () => {
    it("FULL-ACC-046.T01: remote claims enforce mandatory attribution and explicit uncertainty", async () => {
      // Missing attribution fails explicitly
      const invalidClaimAttempt = await Effect.runPromiseExit(
        service.recordRemoteClaim({
          attribution: {
            assertedAt: "",
            sourceAuthority: "",
            sourceCellId: "",
          },
          claimType: "INVENTORY_AVAILABILITY",
          payload: { available: 50 },
          subjectEntityId: "sku-100",
          targetCellId: "cell-company-alpha",
          uncertainty: { status: "FRESH" },
        })
      );

      expect(Exit.isFailure(invalidClaimAttempt)).toBe(true);
      if (Exit.isFailure(invalidClaimAttempt)) {
        const failReason = invalidClaimAttempt.cause.reasons.find(
          Cause.isFailReason
        );
        expect(failReason?.error).toBeInstanceOf(
          FederationAttributionMissingError
        );
      }

      // Valid claim succeeds with full attribution and status
      const validClaim = await Effect.runPromise(
        service.recordRemoteClaim({
          attribution: {
            assertedAt: "2026-09-11T10:00:00.000Z",
            sourceAuthority: "sec-auth-partner-beta",
            sourceCellId: "cell-partner-beta",
            sourceSignature: "sig-rsa-ed25519-abc123",
          },
          claimType: "INVENTORY_AVAILABILITY",
          payload: { available: 50 },
          subjectEntityId: "sku-100",
          targetCellId: "cell-company-alpha",
          uncertainty: {
            freshnessDeadlineMs: 3600000,
            lastVerifiedAt: "2026-09-11T10:00:00.000Z",
            status: "FRESH",
          },
        })
      );

      expect(validClaim.claimId).toBeDefined();
      expect(validClaim.attribution.sourceCellId).toBe("cell-partner-beta");
      expect(validClaim.uncertainty.status).toBe("FRESH");
    });
  });

  describe("Multi-Cell Saga Execution & Compensation Without Fictional Global Commit (OPR-FULL-046, FULL-ACC-046)", () => {
    it("FULL-ACC-046.T02: executes all steps across multiple cells successfully", async () => {
      const plan: MultiCellOperationPlan = {
        coordinatorCellId: "cell-warehouse-local",
        operationId: "op-multicell-001",
        steps: [
          {
            actionName: "reserveWarehouseInventory",
            cellId: "cell-warehouse-local",
            compensatingAction: {
              actionName: "releaseWarehouseReservation",
              payload: { sku: "SKU-99", units: 5 },
            },
            payload: { sku: "SKU-99", units: 5 },
            stepId: "step-1-local-reservation",
          },
          {
            actionName: "bookCarrierDelivery",
            cellId: "cell-logistics-remote",
            compensatingAction: {
              actionName: "cancelCarrierBooking",
              payload: { bookingRef: "BK-44" },
            },
            payload: { destination: "Building 4, Dock 2", sku: "SKU-99" },
            stepId: "step-2-remote-booking",
          },
        ],
        tenantId: "tenant-enterprise-shared",
        timeoutMs: 5000,
      };

      const outcome = await Effect.runPromise(
        service.executeMultiCellSaga(plan, {
          "cell-logistics-remote": {
            executeStep: () => Effect.succeed("receipt-remote-book-99"),
          },
          "cell-warehouse-local": {
            executeStep: () => Effect.succeed("receipt-local-reserve-42"),
          },
        })
      );

      expect(outcome.status).toBe("COMPLETED");
      expect(outcome.globalCommitPromised).toBe(false);
      expect(outcome.stepResults).toHaveLength(2);
      expect(outcome.stepResults[0]?.status).toBe("COMMITTED");
      expect(outcome.stepResults[1]?.status).toBe("COMMITTED");
      expect(outcome.remotePendingClaims).toHaveLength(0);
    });

    it("FULL-ACC-046.T03: handles remote cell unreachable after first cell reservation: compensates first cell and records remote pending uncertainty without inventing global commit", async () => {
      let warehouseReservationCompensated = false;

      const plan: MultiCellOperationPlan = {
        coordinatorCellId: "cell-warehouse-local",
        operationId: "op-multicell-002",
        steps: [
          {
            actionName: "reserveWarehouseInventory",
            cellId: "cell-warehouse-local",
            compensatingAction: {
              actionName: "releaseWarehouseReservation",
              payload: { sku: "SKU-99", units: 5 },
            },
            payload: { sku: "SKU-99", units: 5 },
            stepId: "step-1-local-reservation",
          },
          {
            actionName: "bookCarrierDelivery",
            cellId: "cell-logistics-remote",
            compensatingAction: {
              actionName: "cancelCarrierBooking",
              payload: { bookingRef: "BK-44" },
            },
            payload: { destination: "Building 4, Dock 2", sku: "SKU-99" },
            stepId: "step-2-remote-booking",
          },
        ],
        tenantId: "tenant-enterprise-shared",
        timeoutMs: 5000,
      };

      const outcome = await Effect.runPromise(
        service.executeMultiCellSaga(plan, {
          "cell-logistics-remote": {
            // Second cell is unreachable / times out
            executeStep: () =>
              Effect.fail(
                new RemoteCellExecutionError({
                  cellId: "cell-logistics-remote",
                  message: "Remote cell logistics unreachable (timeout)",
                })
              ),
          },
          "cell-warehouse-local": {
            executeCompensation: () => {
              warehouseReservationCompensated = true;
              return Effect.succeed("receipt-wh-compensation-88");
            },
            executeStep: () => Effect.succeed("receipt-local-reserve-42"),
          },
        })
      );

      // Outcome algebra guarantees:
      // 1. No fictional global commit promised
      expect(outcome.globalCommitPromised).toBe(false);
      // 2. Status reflects partial failure with compensation
      expect(outcome.status).toBe("PARTIALLY_FAILED_COMPENSATED");
      // 3. Compensation was executed on first cell
      expect(warehouseReservationCompensated).toBe(true);
      expect(outcome.stepResults[0]?.status).toBe("COMPENSATED");
      expect(outcome.stepResults[0]?.receiptId).toBe(
        "receipt-wh-compensation-88"
      );
      // 4. Remote step marked as UNREACHABLE
      expect(outcome.stepResults[1]?.status).toBe("UNREACHABLE");
      // 5. Remote pending claim recorded with attributed uncertainty
      expect(outcome.remotePendingClaims).toHaveLength(1);
      expect(outcome.remotePendingClaims[0]?.uncertainty.status).toBe(
        "UNREACHABLE"
      );
      expect(outcome.remotePendingClaims[0]?.attribution.sourceCellId).toBe(
        "cell-logistics-remote"
      );
    });

    it("FULL-ACC-046.T04: reports COMPENSATION_FAILED when compensation execution fails", async () => {
      const plan: MultiCellOperationPlan = {
        coordinatorCellId: "cell-warehouse-local",
        operationId: "op-multicell-003",
        steps: [
          {
            actionName: "reserveWarehouseInventory",
            cellId: "cell-warehouse-local",
            compensatingAction: {
              actionName: "releaseWarehouseReservation",
              payload: { sku: "SKU-99", units: 5 },
            },
            payload: { sku: "SKU-99", units: 5 },
            stepId: "step-1-local-reservation",
          },
          {
            actionName: "bookCarrierDelivery",
            cellId: "cell-logistics-remote",
            payload: { sku: "SKU-99" },
            stepId: "step-2-remote-booking",
          },
        ],
        tenantId: "tenant-enterprise-shared",
        timeoutMs: 5000,
      };

      const outcome = await Effect.runPromise(
        service.executeMultiCellSaga(plan, {
          "cell-logistics-remote": {
            executeStep: () =>
              Effect.fail(
                new RemoteCellExecutionError({
                  cellId: "cell-logistics-remote",
                  message: "Downstream service failure",
                })
              ),
          },
          "cell-warehouse-local": {
            executeCompensation: () =>
              Effect.fail(
                new RemoteCellCompensationError({
                  cellId: "cell-warehouse-local",
                  message: "Warehouse lock contention during rollback",
                })
              ),
            executeStep: () => Effect.succeed("receipt-local-reserve-42"),
          },
        })
      );

      expect(outcome.status).toBe("COMPENSATION_FAILED");
      expect(outcome.globalCommitPromised).toBe(false);
      expect(outcome.stepResults[0]?.status).toBe("COMPENSATION_FAILED");
      expect(outcome.stepResults[0]?.error).toContain(
        "Warehouse lock contention"
      );
    });
  });
});
