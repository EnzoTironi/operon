import type {
  SovereignExportedDecision,
  SovereignExportedDossier,
  SovereignExportedEntity,
  SovereignExportedReceipt,
} from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  ExportSecretLeakageError,
  RestoreIntegrityMismatchError,
  RestoreSideEffectReplayForbiddenError,
} from "../actions-errors.js";
import {
  InMemoryExportRestoreStorage,
  SovereignExportService,
} from "./sovereign-export-service.js";

describe("SovereignExportService (S15, OPR-FULL-045, FULL-ACC-045)", () => {
  const service = new SovereignExportService();

  const sampleEntities: readonly SovereignExportedEntity[] = [
    {
      id: "patient-1001",
      lastModifiedAt: 1789000000000,
      properties: {
        api_token: "tok_live_super_secret_credentials_xyz",
        currentDoseMg: 12.5,
        db_password: "super-secure-internal-db-password",
        egfr: 55,
        name: "Elena Rostova",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...",
        room: "ICU-2",
      },
      typeId: "healthcare.Patient",
      version: 4,
    },
    {
      id: "order-5001",
      lastModifiedAt: 1789000050000,
      properties: {
        amountUsd: 1450,
        carrierSecret: "sk_carrier_api_secret_449",
        orderStatus: "COMPLETED",
      },
      typeId: "order.Order",
      version: 2,
    },
  ];

  const sampleDecisions: readonly SovereignExportedDecision[] = [
    {
      actionId: "healthcare.adjustDosage",
      decisionRecordId: "dec-adjust-1001",
      evaluatedAt: 1789000010000,
      operationId: "op-dosage-adjust-1",
      result: "ALLOW",
    },
  ];

  const sampleReceipts: readonly SovereignExportedReceipt[] = [
    {
      actionId: "healthcare.adjustDosage",
      committedAt: 1789000015000,
      operationId: "op-dosage-adjust-1",
      receiptDigest: "sha256:abcd1234efgh5678committedreceiptdigest",
      status: "COMMITTED",
    },
  ];

  const sampleDossiers: readonly SovereignExportedDossier[] = [
    {
      dossierId: "dossier-op-dosage-adjust-1",
      evidenceItems: [
        {
          confidence: 0.98,
          observation: "Renal clearance stable",
          source: "lab-panel-992",
        },
      ],
      operationId: "op-dosage-adjust-1",
      sealedAt: "2026-09-11T09:00:00.000Z",
    },
  ];

  describe("Sovereign Export Without Secret Leakage (OPR-FULL-045)", () => {
    it("FULL-ACC-045.T01: export strips secrets, tokens, and private keys while preserving canonical entities", async () => {
      const bundle = await Effect.runPromise(
        service.createExportBundle({
          decisions: sampleDecisions,
          entities: sampleEntities,
          evidenceDossiers: sampleDossiers,
          receipts: sampleReceipts,
          sourceCellId: "cell-primary-eu",
          strictRejectOnSecret: false,
          tenantId: "tenant-hospital-metro",
        })
      );

      expect(bundle.secretsSanitized).toBe(true);
      expect(bundle.entities).toHaveLength(2);
      expect(bundle.metadata.entityCount).toBe(2);
      expect(bundle.metadata.decisionCount).toBe(1);
      expect(bundle.metadata.receiptCount).toBe(1);
      expect(bundle.metadata.checksum).toBeDefined();

      const patient = bundle.entities.find((e) => e.id === "patient-1001");
      expect(patient).toBeDefined();
      expect(patient?.properties.name).toBe("Elena Rostova");
      expect(patient?.properties.currentDoseMg).toBe(12.5);

      // Verify all sensitive keys were stripped
      expect(patient?.properties.api_token).toBeUndefined();
      expect(patient?.properties.db_password).toBeUndefined();
      expect(patient?.properties.private_key).toBeUndefined();

      const order = bundle.entities.find((e) => e.id === "order-5001");
      expect(order?.properties.orderStatus).toBe("COMPLETED");
      expect(order?.properties.carrierSecret).toBeUndefined();
    });

    it("FULL-ACC-045.T01b: strict mode aborts export with ExportSecretLeakageError if secrets are detected", async () => {
      const exit = await Effect.runPromiseExit(
        service.createExportBundle({
          decisions: sampleDecisions,
          entities: sampleEntities,
          receipts: sampleReceipts,
          sourceCellId: "cell-primary-eu",
          strictRejectOnSecret: true,
          tenantId: "tenant-hospital-metro",
        })
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find(Cause.isFailReason);
        const err = failReason?.error;
        expect(err).toBeInstanceOf(ExportSecretLeakageError);
        if (err instanceof ExportSecretLeakageError) {
          expect(err._tag).toBe("ExportSecretLeakageError");
          expect(err.detectedKeys).toContain("api_token");
          expect(err.detectedKeys).toContain("private_key");
          expect(err.detectedKeys).toContain("carrierSecret");
        }
      }
    });
  });

  describe("Clean Replay-Free Restore (OPR-FULL-045, FULL-ACC-045)", () => {
    it("FULL-ACC-045.T02: clean restore into target cell matches queries and dossiers from source cell with 100% fidelity", async () => {
      const bundle = await Effect.runPromise(
        service.createExportBundle({
          decisions: sampleDecisions,
          entities: sampleEntities,
          evidenceDossiers: sampleDossiers,
          receipts: sampleReceipts,
          sourceCellId: "cell-primary-eu",
          strictRejectOnSecret: false,
          tenantId: "tenant-hospital-metro",
        })
      );

      const cleanStorage = new InMemoryExportRestoreStorage();

      const report = await Effect.runPromise(
        service.restoreBundle({
          bundle,
          targetCellId: "cell-isolated-dr-us",
          targetStorage: cleanStorage,
        })
      );

      expect(report.targetCellId).toBe("cell-isolated-dr-us");
      expect(report.sourceCellId).toBe("cell-primary-eu");
      expect(report.entitiesRestored).toBe(2);
      expect(report.decisionsRestored).toBe(1);
      expect(report.receiptsRestored).toBe(1);
      expect(report.queryVerificationPassed).toBe(true);
      expect(report.dossiersMatchSource).toBe(true);

      // Verify queries in clean target storage match perfectly
      const patient = await Effect.runPromise(
        cleanStorage.getEntity("patient-1001")
      );
      expect(patient).toBeDefined();
      expect(patient?.name).toBeUndefined(); // properties is the container
      expect(patient?.properties.name).toBe("Elena Rostova");
      expect(patient?.properties.currentDoseMg).toBe(12.5);
      expect(patient?.version).toBe(4);
      expect(patient?.lastModifiedAt).toBe(1789000000000);

      const order = await Effect.runPromise(
        cleanStorage.getEntity("order-5001")
      );
      expect(order).toBeDefined();
      expect(order?.properties.orderStatus).toBe("COMPLETED");
      expect(order?.version).toBe(2);
    });

    it("FULL-ACC-045.T03: clean restore strictly suppresses historical side-effects (zero notifications re-sent, zero outbox dispatches)", async () => {
      const bundle = await Effect.runPromise(
        service.createExportBundle({
          decisions: sampleDecisions,
          entities: sampleEntities,
          evidenceDossiers: sampleDossiers,
          receipts: sampleReceipts,
          sourceCellId: "cell-primary-eu",
          strictRejectOnSecret: false,
          tenantId: "tenant-hospital-metro",
        })
      );

      const cleanStorage = new InMemoryExportRestoreStorage();

      // Successful clean restore reports strictly 0 replayed side-effects
      const report = await Effect.runPromise(
        service.restoreBundle({
          bundle,
          targetCellId: "cell-isolated-dr-us",
          targetStorage: cleanStorage,
        })
      );

      expect(report.historicalNotificationsReplayed).toBe(0);
      expect(report.outboxSideEffectsDispatched).toBe(0);

      // If an unauthorized runner attempts to re-dispatch side-effects during restore, it fails explicitly
      const replayAttempt = await Effect.runPromiseExit(
        service.restoreBundle({
          attemptSideEffectReplay: true,
          bundle,
          targetCellId: "cell-isolated-dr-us",
          targetStorage: cleanStorage,
        })
      );

      expect(Exit.isFailure(replayAttempt)).toBe(true);
      if (Exit.isFailure(replayAttempt)) {
        const failReason = replayAttempt.cause.reasons.find(Cause.isFailReason);
        const err = failReason?.error;
        expect(err).toBeInstanceOf(RestoreSideEffectReplayForbiddenError);
        if (err instanceof RestoreSideEffectReplayForbiddenError) {
          expect(err._tag).toBe("RestoreSideEffectReplayForbiddenError");
          expect(err.attemptedEffectType).toBe(
            "HISTORICAL_NOTIFICATION_REPLAY"
          );
        }
      }
    });

    it("FULL-ACC-045.T04: restore rejects corrupted or tampered export bundle with RestoreIntegrityMismatchError", async () => {
      const bundle = await Effect.runPromise(
        service.createExportBundle({
          decisions: sampleDecisions,
          entities: sampleEntities,
          evidenceDossiers: sampleDossiers,
          receipts: sampleReceipts,
          sourceCellId: "cell-primary-eu",
          strictRejectOnSecret: false,
          tenantId: "tenant-hospital-metro",
        })
      );

      // Tamper with entity property without updating checksum
      const tamperedBundle = {
        ...bundle,
        entities: [
          {
            ...bundle.entities[0]!,
            properties: {
              ...bundle.entities[0]!.properties,
              tamperedField: "forged_data_injection",
            },
          },
          ...bundle.entities.slice(1),
        ],
      };

      const cleanStorage = new InMemoryExportRestoreStorage();

      const exit = await Effect.runPromiseExit(
        service.restoreBundle({
          bundle: tamperedBundle,
          targetCellId: "cell-isolated-dr-us",
          targetStorage: cleanStorage,
        })
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find(Cause.isFailReason);
        const err = failReason?.error;
        expect(err).toBeInstanceOf(RestoreIntegrityMismatchError);
        if (err instanceof RestoreIntegrityMismatchError) {
          expect(err._tag).toBe("RestoreIntegrityMismatchError");
          expect(err.expectedChecksum).toBe(bundle.metadata.checksum);
        }
      }
    });
  });
});
