import { createHash, randomUUID } from "node:crypto";

import { serializeJson } from "@operon/schema";
import type {
  SovereignExportBundle,
  SovereignExportedDecision,
  SovereignExportedDossier,
  SovereignExportedEntity,
  SovereignExportedReceipt,
  SovereignRestoreReport,
} from "@operon/schema";
import { Clock, Effect } from "effect";

import {
  ExportSecretLeakageError,
  RestoreIntegrityMismatchError,
  RestoreSideEffectReplayForbiddenError,
} from "../actions-errors.js";

/**
 * Storage interface for sovereign restore operations (OPR-FULL-045)
 */
export interface ExportRestoreTargetStorage {
  readonly getEntity: (
    id: string
  ) => Effect.Effect<SovereignExportedEntity | undefined, never>;
  readonly saveDecision: (
    decision: SovereignExportedDecision
  ) => Effect.Effect<void, never>;
  readonly saveEntity: (
    entity: SovereignExportedEntity
  ) => Effect.Effect<void, never>;
  readonly saveReceipt: (
    receipt: SovereignExportedReceipt
  ) => Effect.Effect<void, never>;
}

/**
 * In-memory storage implementation for testing and ephemeral sovereign restore
 */
export class InMemoryExportRestoreStorage implements ExportRestoreTargetStorage {
  private readonly entities = new Map<string, SovereignExportedEntity>();
  private readonly decisions = new Map<string, SovereignExportedDecision>();
  private readonly receipts = new Map<string, SovereignExportedReceipt>();

  saveEntity(entity: SovereignExportedEntity): Effect.Effect<void, never> {
    this.entities.set(entity.id, entity);
    return Effect.void;
  }

  getEntity(
    id: string
  ): Effect.Effect<SovereignExportedEntity | undefined, never> {
    return Effect.succeed(this.entities.get(id));
  }

  saveDecision(
    decision: SovereignExportedDecision
  ): Effect.Effect<void, never> {
    this.decisions.set(decision.decisionRecordId, decision);
    return Effect.void;
  }

  saveReceipt(receipt: SovereignExportedReceipt): Effect.Effect<void, never> {
    this.receipts.set(receipt.receiptDigest, receipt);
    return Effect.void;
  }

  getAllEntities(): readonly SovereignExportedEntity[] {
    return [...this.entities.values()];
  }

  getAllDecisions(): readonly SovereignExportedDecision[] {
    return [...this.decisions.values()];
  }

  getAllReceipts(): readonly SovereignExportedReceipt[] {
    return [...this.receipts.values()];
  }
}

/**
 * Keywords identifying secret and credential fields that must never be exported (S15)
 */
const SENSITIVE_KEY_PATTERN =
  /(?:secret|password|bearer|private_?key|api_?key|token|credentials)/iu;

/**
 * SovereignExportService (S15, OPR-FULL-045, FULL-ACC-045):
 * Manages secret-free sovereign export bundling, integrity verification,
 * and clean replay-free restoration with zero historical side-effects.
 */
/**
 * Sanitizes entity properties, stripping any sensitive keys/credentials.
 */
export function sanitizeProperties(properties: Record<string, unknown>): {
  readonly sanitized: Record<string, unknown>;
  readonly strippedKeys: readonly string[];
} {
  const sanitized: Record<string, unknown> = {};
  const strippedKeys: string[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      strippedKeys.push(key);
    } else {
      sanitized[key] = value;
    }
  }

  return { sanitized, strippedKeys };
}

/**
 * Computes a deterministic SHA-256 checksum over the bundle content
 */
export function computeChecksum(payload: {
  readonly canonicalDefinitions: readonly unknown[];
  readonly decisions: readonly SovereignExportedDecision[];
  readonly entities: readonly SovereignExportedEntity[];
  readonly evidenceDossiers: readonly SovereignExportedDossier[];
  readonly receipts: readonly SovereignExportedReceipt[];
  readonly tenantId: string;
}): string {
  const serialized = JSON.stringify({
    canonicalDefinitions: payload.canonicalDefinitions,
    decisions: payload.decisions,
    entities: payload.entities,
    evidenceDossiers: payload.evidenceDossiers,
    receipts: payload.receipts,
    tenantId: payload.tenantId,
  });
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * SovereignExportService (S15, OPR-FULL-045, FULL-ACC-045):
 * Manages secret-free sovereign export bundling, integrity verification,
 * and clean replay-free restoration with zero historical side-effects.
 */
export class SovereignExportService {
  /**
   * Sanitizes entity properties, stripping any sensitive keys/credentials.
   */
  sanitizeProperties(properties: Record<string, unknown>): {
    readonly sanitized: Record<string, unknown>;
    readonly strippedKeys: readonly string[];
  } {
    return sanitizeProperties(properties);
  }

  /**
   * Creates a sovereign export bundle, stripping all secrets and credentials (OPR-FULL-045)
   * Fails with ExportSecretLeakageError if strictMode is enabled and sensitive keys were present.
   */
  readonly createExportBundle = Effect.fn(
    "SovereignExportService.createExportBundle"
  )(function* (
    this: SovereignExportService,
    params: {
      readonly canonicalDefinitions?: readonly unknown[];
      readonly decisions: readonly SovereignExportedDecision[];
      readonly entities: readonly SovereignExportedEntity[];
      readonly evidenceDossiers?: readonly SovereignExportedDossier[];
      readonly receipts: readonly SovereignExportedReceipt[];
      readonly sourceCellId: string;
      readonly strictRejectOnSecret?: boolean;
      readonly tenantId: string;
    }
  ): Effect.fn.Return<SovereignExportBundle, ExportSecretLeakageError> {
    const sanitizedEntities: SovereignExportedEntity[] = [];
    const allStrippedKeys: string[] = [];

    for (const entity of params.entities) {
      const { sanitized, strippedKeys } = sanitizeProperties(entity.properties);
      allStrippedKeys.push(...strippedKeys);
      sanitizedEntities.push({
        id: entity.id,
        lastModifiedAt: entity.lastModifiedAt,
        properties: sanitized,
        typeId: entity.typeId,
        version: entity.version,
      });
    }

    if (params.strictRejectOnSecret && allStrippedKeys.length > 0) {
      return yield* new ExportSecretLeakageError({
        detectedKeys: allStrippedKeys,
        message: `Sovereign export aborted: sensitive keys detected in source entities: ${allStrippedKeys.join(", ")}`,
        tenantId: params.tenantId,
      });
    }

    const definitions = params.canonicalDefinitions ?? [];
    const dossiers = params.evidenceDossiers ?? [];

    const checksum = computeChecksum({
      canonicalDefinitions: definitions,
      decisions: params.decisions,
      entities: sanitizedEntities,
      evidenceDossiers: dossiers,
      receipts: params.receipts,
      tenantId: params.tenantId,
    });

    const exportId = `export-${randomUUID()}`;
    const now = yield* Clock.currentTimeMillis;
    const exportedAt = new Date(now).toISOString();

    const bundle: SovereignExportBundle = {
      canonicalDefinitions: definitions,
      decisions: params.decisions,
      entities: sanitizedEntities,
      evidenceDossiers: dossiers,
      metadata: {
        checksum,
        decisionCount: params.decisions.length,
        entityCount: sanitizedEntities.length,
        exportedAt,
        exportId,
        formatVersion: "1.0.0",
        receiptCount: params.receipts.length,
        sourceCellId: params.sourceCellId,
        tenantId: params.tenantId,
      },
      receipts: params.receipts,
      secretsSanitized: true,
    };

    return bundle;
  });

  /**
   * Restores a sovereign export bundle into a clean target cell (OPR-FULL-045, FULL-ACC-045)
   * Verifies checksum integrity, preserves canonical identities, and strictly forbids side-effect replay.
   */
  readonly restoreBundle = Effect.fn("SovereignExportService.restoreBundle")(
    function* (
      this: SovereignExportService,
      params: {
        readonly attemptSideEffectReplay?: boolean;
        readonly bundle: SovereignExportBundle;
        readonly targetCellId: string;
        readonly targetStorage: ExportRestoreTargetStorage;
      }
    ): Effect.fn.Return<
      SovereignRestoreReport,
      RestoreIntegrityMismatchError | RestoreSideEffectReplayForbiddenError
    > {
      const { bundle, targetCellId, targetStorage } = params;

      // Check integrity
      const expectedChecksum = computeChecksum({
        canonicalDefinitions: bundle.canonicalDefinitions,
        decisions: bundle.decisions,
        entities: bundle.entities,
        evidenceDossiers: bundle.evidenceDossiers,
        receipts: bundle.receipts,
        tenantId: bundle.metadata.tenantId,
      });

      if (bundle.metadata.checksum !== expectedChecksum) {
        return yield* new RestoreIntegrityMismatchError({
          actualChecksum: expectedChecksum,
          expectedChecksum: bundle.metadata.checksum,
          exportId: bundle.metadata.exportId,
          message: `Restore aborted: bundle checksum mismatch. Expected "${bundle.metadata.checksum}", computed "${expectedChecksum}"`,
        });
      }

      // Prohibit side effect replay (FULL-ACC-045: "nenhuma notificação histórica é reenviada")
      if (params.attemptSideEffectReplay) {
        return yield* new RestoreSideEffectReplayForbiddenError({
          attemptedEffectType: "HISTORICAL_NOTIFICATION_REPLAY",
          message:
            "Restore pipeline strictly forbids re-dispatching historical side effects or notifications",
          restoreId: `restore-${randomUUID()}`,
        });
      }

      // Restore entities
      yield* Effect.forEach(
        bundle.entities,
        (entity) => targetStorage.saveEntity(entity),
        { concurrency: 1 }
      );

      // Restore decisions
      yield* Effect.forEach(
        bundle.decisions,
        (decision) => targetStorage.saveDecision(decision),
        { concurrency: 1 }
      );

      // Restore receipts
      yield* Effect.forEach(
        bundle.receipts,
        (receipt) => targetStorage.saveReceipt(receipt),
        { concurrency: 1 }
      );

      // Verification of queries: check every entity matches in the target storage
      let queryVerificationPassed = true;
      yield* Effect.forEach(
        bundle.entities,
        Effect.fn("SovereignExportService.verifyEntity")(
          function* (expectedEntity) {
            if (!queryVerificationPassed) return;
            const stored = yield* targetStorage.getEntity(expectedEntity.id);
            if (
              !stored ||
              stored.version !== expectedEntity.version ||
              stored.lastModifiedAt !== expectedEntity.lastModifiedAt ||
              serializeJson(stored.properties) !==
                serializeJson(expectedEntity.properties)
            ) {
              queryVerificationPassed = false;
            }
          }
        ),
        { concurrency: 1 }
      );

      const dossiersMatchSource = bundle.evidenceDossiers.every((d) =>
        Boolean(d.dossierId && d.operationId)
      );

      const report: SovereignRestoreReport = {
        decisionsRestored: bundle.decisions.length,
        dossiersMatchSource,
        entitiesRestored: bundle.entities.length,
        historicalNotificationsReplayed: 0,
        outboxSideEffectsDispatched: 0,
        queryVerificationPassed,
        receiptsRestored: bundle.receipts.length,
        restoredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        restoreId: `restore-${randomUUID()}`,
        sourceCellId: bundle.metadata.sourceCellId,
        targetCellId,
        tenantId: bundle.metadata.tenantId,
      };

      return report;
    }
  );
}
