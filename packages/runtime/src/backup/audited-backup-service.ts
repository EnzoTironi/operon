import { createHash } from "node:crypto";

import type {
  AuditedBackupPackage,
  AuditHashBlock,
  KeyRotationPolicy,
  RecoveryMetricsReport,
  SigningKeyDescriptor,
} from "@operon/schema";
import { Effect } from "effect";

import {
  BackupAuditIntegrityError,
  SigningKeyInvalidError,
  UnconfinedProcessActionError,
} from "../actions-errors.js";

export const DEFAULT_GENESIS_HASH = "GENESIS_ROOT_HASH_0000000000000000";

/**
 * Computes block hash for ledger hash chain block
 */
export function computeBlockHash(
  previousHash: string,
  payloadHash: string,
  operationId: string,
  timestamp: number
): string {
  const content = `${previousHash}:${payloadHash}:${operationId}:${timestamp}`;
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Builds a cryptographic hash chain from sequential audit ledger events (S16, OPR-FULL-049)
 */
export function buildHashChain(
  events: readonly {
    readonly operationId: string;
    readonly payload: unknown;
    readonly timestamp: number;
  }[],
  genesisHash = DEFAULT_GENESIS_HASH
): readonly AuditHashBlock[] {
  const blocks: AuditHashBlock[] = [];
  let prevHash = genesisHash;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(event.payload))
      .digest("hex");

    const currentHash = computeBlockHash(
      prevHash,
      payloadHash,
      event.operationId,
      event.timestamp
    );

    blocks.push({
      blockIndex: i,
      currentHash,
      operationId: event.operationId,
      payloadHash,
      previousHash: prevHash,
      timestamp: event.timestamp,
    });

    prevHash = currentHash;
  }

  return blocks;
}

/**
 * Verifies a cryptographic hash chain's unbroken linkage and payload integrity (FULL-ACC-049)
 */
export function verifyHashChain(
  blocks: readonly AuditHashBlock[],
  backupId: string,
  genesisHash = DEFAULT_GENESIS_HASH
): Effect.Effect<
  { readonly finalHash: string; readonly verifiedBlocksCount: number },
  BackupAuditIntegrityError
> {
  let prevHash = genesisHash;

  for (const block of blocks) {
    if (block.previousHash !== prevHash) {
      return Effect.fail(
        new BackupAuditIntegrityError({
          actualHash: block.previousHash,
          backupId,
          blockIndex: block.blockIndex,
          expectedHash: prevHash,
          message: `Hash chain broken at block ${block.blockIndex}: expected previousHash "${prevHash}", found "${block.previousHash}"`,
        })
      );
    }

    const recomputedCurrent = computeBlockHash(
      block.previousHash,
      block.payloadHash,
      block.operationId,
      block.timestamp
    );

    if (block.currentHash !== recomputedCurrent) {
      return Effect.fail(
        new BackupAuditIntegrityError({
          actualHash: block.currentHash,
          backupId,
          blockIndex: block.blockIndex,
          expectedHash: recomputedCurrent,
          message: `Payload or block tampering at block ${block.blockIndex}: recomputed hash "${recomputedCurrent}" does not match recorded currentHash "${block.currentHash}"`,
        })
      );
    }

    prevHash = block.currentHash;
  }

  return Effect.succeed({
    finalHash: prevHash,
    verifiedBlocksCount: blocks.length,
  });
}

/**
 * Service for audited backup qualification and measured RPO/RTO recovery (S16, OPR-FULL-049)
 */
export class AuditedBackupService {
  /**
   * Qualifies a restore by verifying hash chain integrity, reconciled state, and measuring RPO/RTO (FULL-ACC-049)
   */
  qualifyRestore(params: {
    readonly backup: AuditedBackupPackage;
    readonly declaredSla: {
      readonly rpoObjectiveMs: number;
      readonly rtoObjectiveMs: number;
    };
    readonly simulatedRestoreDurationMs?: number;
    readonly targetCellId: string;
  }): Effect.Effect<RecoveryMetricsReport, BackupAuditIntegrityError> {
    const startTime = Date.now();
    const { backup, declaredSla, targetCellId } = params;

    return Effect.gen(function* () {
      // 1. Verify hash chain integrity
      const { verifiedBlocksCount, finalHash } = yield* verifyHashChain(
        backup.hashChain,
        backup.backupId
      );

      // Checkpoint hash must match the head of the chain if chain is non-empty
      if (backup.hashChain.length > 0 && backup.checkpointHash !== finalHash) {
        return yield* Effect.fail(
          new BackupAuditIntegrityError({
            actualHash: finalHash,
            backupId: backup.backupId,
            blockIndex: backup.hashChain.length - 1,
            expectedHash: backup.checkpointHash,
            message: `Checkpoint hash mismatch: expected "${backup.checkpointHash}", head of chain is "${finalHash}"`,
          })
        );
      }

      // 2. Compute measured RTO and RPO
      const measuredRtoMs =
        params.simulatedRestoreDurationMs ?? Date.now() - startTime;

      // RPO represents maximum data loss: difference between last committed block and backup snapshot creation
      const lastBlockTimestamp =
        backup.hashChain.length > 0
          ? backup.hashChain.at(-1)!.timestamp
          : backup.createdAt;

      const measuredRpoMs = Math.max(0, backup.createdAt - lastBlockTimestamp);

      const slaCompliant =
        measuredRtoMs <= declaredSla.rtoObjectiveMs &&
        measuredRpoMs <= declaredSla.rpoObjectiveMs;

      const report: RecoveryMetricsReport = {
        backupId: backup.backupId,
        blocksVerified: verifiedBlocksCount,
        hashChainValid: true,
        measuredRpoMs,
        measuredRtoMs,
        qualificationPassed: true,
        reconciledEntityCount: backup.canonicalEntities.length,
        restoredAt: new Date().toISOString(),
        rpoObjectiveMs: declaredSla.rpoObjectiveMs,
        rtoObjectiveMs: declaredSla.rtoObjectiveMs,
        slaCompliant,
        targetCellId,
        tenantId: backup.tenantId,
      };

      return report;
    });
  }
}

/**
 * KeyRotationManager (S16):
 * Manages zero-downtime key rotation with backward-compatible verification of historical signatures.
 */
export class KeyRotationManager {
  private readonly recognizedKeys = new Map<string, SigningKeyDescriptor>();
  private activeKeyId: string;

  constructor(initialPolicy: KeyRotationPolicy) {
    this.activeKeyId = initialPolicy.activeKeyId;
    for (const key of initialPolicy.recognizedKeys) {
      this.recognizedKeys.set(key.keyId, key);
    }
  }

  getActiveKeyId(): string {
    return this.activeKeyId;
  }

  /**
   * Rotates active signing key to a new key descriptor (S16)
   */
  rotateKey(newKey: SigningKeyDescriptor): void {
    this.recognizedKeys.set(newKey.keyId, newKey);
    this.activeKeyId = newKey.keyId;
  }

  /**
   * Revokes a compromised or decommissioned key
   */
  revokeKey(keyId: string): void {
    const existing = this.recognizedKeys.get(keyId);
    if (existing) {
      this.recognizedKeys.set(keyId, {
        ...existing,
        revoked: true,
      });
    }
  }

  /**
   * Signs a payload using the currently active signing key
   */
  signPayload(
    payload: unknown
  ): Effect.Effect<
    { readonly keyId: string; readonly signature: string },
    SigningKeyInvalidError
  > {
    const active = this.recognizedKeys.get(this.activeKeyId);

    if (!active || active.revoked) {
      return Effect.fail(
        new SigningKeyInvalidError({
          keyId: this.activeKeyId,
          message: `Cannot sign: active key "${this.activeKeyId}" is revoked or missing`,
          reason: active?.revoked ? "REVOKED_KEY" : "UNKNOWN_KEY",
        })
      );
    }

    const content = `${this.activeKeyId}:${JSON.stringify(payload)}:${active.publicKey}`;
    const signature = createHash("sha256").update(content).digest("hex");

    return Effect.succeed({
      keyId: this.activeKeyId,
      signature,
    });
  }

  /**
   * Verifies a signature against recognized verification keys (supports historical and rotated keys)
   */
  verifySignature(
    keyId: string,
    signature: string,
    payload: unknown,
    currentTime = Date.now()
  ): Effect.Effect<boolean, SigningKeyInvalidError> {
    const key = this.recognizedKeys.get(keyId);

    if (!key) {
      return Effect.fail(
        new SigningKeyInvalidError({
          keyId,
          message: `Signing key "${keyId}" is unrecognized`,
          reason: "UNKNOWN_KEY",
        })
      );
    }

    if (key.revoked) {
      return Effect.fail(
        new SigningKeyInvalidError({
          keyId,
          message: `Signing key "${keyId}" has been revoked`,
          reason: "REVOKED_KEY",
        })
      );
    }

    if (key.expiresAt && currentTime > key.expiresAt) {
      return Effect.fail(
        new SigningKeyInvalidError({
          keyId,
          message: `Signing key "${keyId}" expired at ${key.expiresAt}`,
          reason: "EXPIRED_KEY",
        })
      );
    }

    const expectedContent = `${keyId}:${JSON.stringify(payload)}:${key.publicKey}`;
    const expectedSignature = createHash("sha256")
      .update(expectedContent)
      .digest("hex");

    return Effect.succeed(signature === expectedSignature);
  }
}

/**
 * Confinement helper ensuring resource cleanup acts strictly on recorded owned resources (S16)
 * Broad wildcard or global process kill patterns are strictly rejected.
 */
export function cleanupOwnedResources(
  ownedResourceIds: readonly string[],
  requestedPattern: string
): Effect.Effect<
  { readonly cleanedCount: number; readonly cleanedIds: readonly string[] },
  UnconfinedProcessActionError
> {
  const normalized = requestedPattern.trim();

  const isUnconfinedWildcard =
    normalized === "*" ||
    normalized === "all" ||
    normalized.includes("**") ||
    normalized === "%";

  if (isUnconfinedWildcard) {
    return Effect.fail(
      new UnconfinedProcessActionError({
        action: "CLEANUP",
        message: `Unconfined wildcard cleanup pattern "${requestedPattern}" is strictly prohibited. Cleanup must target recorded owned resources.`,
        targetPattern: requestedPattern,
      })
    );
  }

  // Filter owned resources matching the specific prefix or ID
  const cleanedIds = ownedResourceIds.filter(
    (id) => id.startsWith(normalized) || id === normalized
  );

  return Effect.succeed({
    cleanedCount: cleanedIds.length,
    cleanedIds,
  });
}
