import type { AuditedBackupPackage, KeyRotationPolicy } from "@operon/schema";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  BackupAuditIntegrityError,
  SigningKeyInvalidError,
  UnconfinedProcessActionError,
} from "../actions-errors.js";
import {
  AuditedBackupService,
  buildHashChain,
  cleanupOwnedResources,
  KeyRotationManager,
  verifyHashChain,
} from "./audited-backup-service.js";

describe("V3-05 Audited Backup, Qualified Restore & Key Rotation (S16, OPR-FULL-049)", () => {
  const backupService = new AuditedBackupService();

  const sampleEvents = [
    {
      operationId: "op-1",
      payload: { action: "CREATE_ACCOUNT", id: "acc-1" },
      timestamp: 1000,
    },
    {
      operationId: "op-2",
      payload: { action: "DEPOSIT", amount: 500 },
      timestamp: 2000,
    },
    {
      operationId: "op-3",
      payload: { action: "UPDATE_STATUS", status: "ACTIVE" },
      timestamp: 3000,
    },
  ];

  it("FULL-ACC-049.T01: qualifies restore with verified hash chain, reconciled entities, and measured RPO/RTO against SLA", async () => {
    const chain = buildHashChain(sampleEvents);
    expect(chain.length).toBe(3);

    const checkpointHash = chain.at(-1)!.currentHash;
    const backup: AuditedBackupPackage = {
      backupId: "bk-qualified-01",
      canonicalEntities: [
        { id: "entity-1", type: "Account", state: "ACTIVE" },
        { id: "entity-2", type: "Ledger", balance: 500 },
      ],
      checkpointHash,
      createdAt: 3500,
      decisions: [],
      definitions: [],
      hashChain: chain,
      receipts: [{ receiptId: "rcpt-1", status: "COMMITTED" }],
      sourceCellId: "cell-us-east-1",
      tenantId: "tenant-enterprise-alpha",
    };

    const declaredSla = {
      rpoObjectiveMs: 1000,
      rtoObjectiveMs: 5000,
    };

    const report = await Effect.runPromise(
      backupService.qualifyRestore({
        backup,
        declaredSla,
        simulatedRestoreDurationMs: 250,
        targetCellId: "cell-eu-central-1",
      })
    );

    expect(report.qualificationPassed).toBe(true);
    expect(report.hashChainValid).toBe(true);
    expect(report.blocksVerified).toBe(3);
    expect(report.reconciledEntityCount).toBe(2);
    expect(report.measuredRpoMs).toBe(500); // 3500 - 3000 = 500ms <= 1000ms SLA
    expect(report.measuredRtoMs).toBe(250); // 250ms <= 5000ms SLA
    expect(report.slaCompliant).toBe(true);
    expect(report.targetCellId).toBe("cell-eu-central-1");
    expect(report.tenantId).toBe("tenant-enterprise-alpha");
  });

  it("FULL-ACC-049.T02: rejects tampered or broken hash chain with BackupAuditIntegrityError", async () => {
    const chain = buildHashChain(sampleEvents);
    // Tamper with second block's payload hash
    const tamperedChain = [
      chain[0]!,
      {
        ...chain[1]!,
        payloadHash:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      chain[2]!,
    ];

    const verifyExit = await Effect.runPromiseExit(
      verifyHashChain(tamperedChain, "bk-tampered-01")
    );

    expect(Exit.isFailure(verifyExit)).toBe(true);
    if (Exit.isFailure(verifyExit)) {
      const error = verifyExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(error).toBeInstanceOf(BackupAuditIntegrityError);
      expect((error as BackupAuditIntegrityError).blockIndex).toBe(1);
    }

    // Also verify that qualifyRestore rejects broken chains
    const backup: AuditedBackupPackage = {
      backupId: "bk-tampered-01",
      canonicalEntities: [],
      checkpointHash: chain[2]!.currentHash,
      createdAt: 4000,
      decisions: [],
      definitions: [],
      hashChain: tamperedChain,
      receipts: [],
      sourceCellId: "cell-1",
      tenantId: "tenant-1",
    };

    const restoreExit = await Effect.runPromiseExit(
      backupService.qualifyRestore({
        backup,
        declaredSla: { rpoObjectiveMs: 1000, rtoObjectiveMs: 1000 },
        targetCellId: "cell-2",
      })
    );

    expect(Exit.isFailure(restoreExit)).toBe(true);
  });

  it("FULL-ACC-049.T03: supports zero-downtime key rotation with continuous historical signature verification", async () => {
    const initialPolicy: KeyRotationPolicy = {
      activeKeyId: "key-v1",
      recognizedKeys: [
        {
          algorithm: "sha256-hmac-simulated",
          createdAt: 1000,
          keyId: "key-v1",
          publicKey: "pubkey-v1-secret-signature-anchor",
          revoked: false,
        },
      ],
      tenantId: "tenant-crypto-test",
    };

    const manager = new KeyRotationManager(initialPolicy);

    // 1. Sign receipt with key-v1
    const receipt1Payload = { action: "SETTLEMENT", amount: 10000 };
    const signResult1 = await Effect.runPromise(
      manager.signPayload(receipt1Payload)
    );
    expect(signResult1.keyId).toBe("key-v1");

    const validBeforeRotation = await Effect.runPromise(
      manager.verifySignature(
        signResult1.keyId,
        signResult1.signature,
        receipt1Payload
      )
    );
    expect(validBeforeRotation).toBe(true);

    // 2. Rotate to key-v2 without downtime
    manager.rotateKey({
      algorithm: "sha256-hmac-simulated",
      createdAt: 2000,
      keyId: "key-v2",
      publicKey: "pubkey-v2-upgraded-security-anchor",
      revoked: false,
    });
    expect(manager.getActiveKeyId()).toBe("key-v2");

    // 3. New writes use key-v2
    const receipt2Payload = { action: "TRANSFER", amount: 2500 };
    const signResult2 = await Effect.runPromise(
      manager.signPayload(receipt2Payload)
    );
    expect(signResult2.keyId).toBe("key-v2");

    // 4. Old receipts signed with key-v1 remain valid
    const oldReceiptValid = await Effect.runPromise(
      manager.verifySignature(
        signResult1.keyId,
        signResult1.signature,
        receipt1Payload
      )
    );
    expect(oldReceiptValid).toBe(true);

    // 5. New receipt verified with key-v2
    const newReceiptValid = await Effect.runPromise(
      manager.verifySignature(
        signResult2.keyId,
        signResult2.signature,
        receipt2Payload
      )
    );
    expect(newReceiptValid).toBe(true);
  });

  it("FULL-ACC-049.T04: fails verification with SigningKeyInvalidError when key is revoked or unknown", async () => {
    const policy: KeyRotationPolicy = {
      activeKeyId: "key-active",
      recognizedKeys: [
        {
          algorithm: "sha256",
          createdAt: 1000,
          keyId: "key-active",
          publicKey: "pubkey-active",
          revoked: false,
        },
        {
          algorithm: "sha256",
          createdAt: 500,
          keyId: "key-compromised",
          publicKey: "pubkey-compromised",
          revoked: true,
        },
      ],
      tenantId: "tenant-revocation-test",
    };

    const manager = new KeyRotationManager(policy);

    // Unknown key fails
    const unknownExit = await Effect.runPromiseExit(
      manager.verifySignature("key-nonexistent", "sig-123", { data: 1 })
    );
    expect(Exit.isFailure(unknownExit)).toBe(true);
    if (Exit.isFailure(unknownExit)) {
      const err = unknownExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(SigningKeyInvalidError);
      expect((err as SigningKeyInvalidError).reason).toBe("UNKNOWN_KEY");
    }

    // Revoked key fails
    const revokedExit = await Effect.runPromiseExit(
      manager.verifySignature("key-compromised", "sig-123", { data: 1 })
    );
    expect(Exit.isFailure(revokedExit)).toBe(true);
    if (Exit.isFailure(revokedExit)) {
      const err = revokedExit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(err).toBeInstanceOf(SigningKeyInvalidError);
      expect((err as SigningKeyInvalidError).reason).toBe("REVOKED_KEY");
    }
  });

  it("FULL-ACC-049.T05: safely confines process cleanup to tracked owned resources, rejecting broad wildcards", async () => {
    const ownedResources = [
      "res-tenantA-001",
      "res-tenantA-002",
      "res-tenantB-001",
    ];

    // Targeted prefix cleanup succeeds
    const targetedResult = await Effect.runPromise(
      cleanupOwnedResources(ownedResources, "res-tenantA")
    );
    expect(targetedResult.cleanedCount).toBe(2);
    expect(targetedResult.cleanedIds).toEqual([
      "res-tenantA-001",
      "res-tenantA-002",
    ]);

    // Wildcard cleanup is strictly prohibited
    const wildcardPatterns = ["*", "all", "**", "res-**", "%"];
    const exits = await Promise.all(
      wildcardPatterns.map((pattern) =>
        Effect.runPromiseExit(cleanupOwnedResources(ownedResources, pattern))
      )
    );
    for (const wildcardExit of exits) {
      expect(Exit.isFailure(wildcardExit)).toBe(true);
      if (Exit.isFailure(wildcardExit)) {
        const err = wildcardExit.cause.reasons.find(Cause.isFailReason)?.error;
        expect(err).toBeInstanceOf(UnconfinedProcessActionError);
        expect((err as UnconfinedProcessActionError).action).toBe("CLEANUP");
      }
    }
  });
});
