import { createWorldView } from "@operon/schema";
import type {
  FieldProvenance,
  ObjectInstance,
  ObjectTypeId,
} from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { BitemporalObjectStore } from "./bitemporal-store.js";
import { ReconciliationService } from "./reconciliation.js";

describe("ReconciliationService (V0-CH-06 / S03 / S04)", () => {
  const mockProvenance: FieldProvenance = {
    batchId: "batch-1",
    digest: "sha256:abc1234",
    fieldPath: "email",
    locator: "s3://lake/crm/customers.json",
    sourceId: "src-crm-1",
  };

  it("leaves ambiguous identities unresolved when confidence is below threshold (S03)", async () => {
    const service = ReconciliationService.make({ confidenceThreshold: 0.85 });

    const proposal = await Effect.runPromise(
      service.proposeIdentityResolution({
        action: "merge",
        confidence: 0.72, // Below 0.85 threshold!
        evidence: [mockProvenance],
        proposalId: "prop-ambiguous-1",
        sourceKey: "crm:user-alice-1",
        sourceSystem: "salesforce",
        splitDetails: null,
        targetCanonicalId: "canonical-customer-42",
      })
    );

    expect(proposal.status).toBe("proposed");

    // Resolve without force override: must remain unresolved_ambiguous
    const receipt = await Effect.runPromise(
      service.resolveIdentity("prop-ambiguous-1", "dec-ai-matcher-1")
    );

    expect(receipt.status).toBe("unresolved_ambiguous");
    expect(receipt.historicalReferences).toHaveLength(0);
    expect(receipt.invalidatedProjections).toHaveLength(0);

    const retrievedProposal = await Effect.runPromise(
      service.getProposal("prop-ambiguous-1")
    );
    expect(retrievedProposal.status).toBe("unresolved_ambiguous");

    // With explicit human override, resolution succeeds
    const overrideReceipt = await Effect.runPromise(
      service.resolveIdentity("prop-ambiguous-1", "dec-human-supervisor-1", {
        forceOverride: true,
      })
    );

    expect(overrideReceipt.status).toBe("resolved");
    expect(overrideReceipt.canonicalId).toBe("canonical-customer-42");
    expect(overrideReceipt.invalidatedProjections).toContain(
      "projection:salesforce:crm:user-alice-1"
    );
  });

  it("merge/split correction preserves history and invalidates affected projections (S03)", async () => {
    const service = ReconciliationService.make();

    // 1. Initial Merge: Merge crm:cust-1 into canonical-100
    await Effect.runPromise(
      service.proposeIdentityResolution({
        action: "merge",
        confidence: 0.95,
        evidence: [mockProvenance],
        proposalId: "prop-merge-1",
        sourceKey: "crm:cust-1",
        sourceSystem: "crm",
        splitDetails: null,
        targetCanonicalId: "canonical-100",
      })
    );

    const mergeReceipt = await Effect.runPromise(
      service.resolveIdentity("prop-merge-1", "dec-merge-1")
    );
    expect(mergeReceipt.status).toBe("resolved");
    expect(mergeReceipt.historicalReferences).toContain("crm:cust-1");
    expect(mergeReceipt.invalidatedProjections).toContain(
      "projection:crm:crm:cust-1"
    );

    // 2. Correction Split: Split mistakenly merged entity per S03
    await Effect.runPromise(
      service.proposeIdentityResolution({
        action: "split",
        confidence: 1,
        evidence: [mockProvenance],
        proposalId: "prop-split-1",
        sourceKey: "crm:cust-1",
        sourceSystem: "crm",
        splitDetails: {
          originalIds: ["crm:cust-1", "canonical-100"],
          reason: "Customers share phone number but have different tax IDs",
        },
        targetCanonicalId: "canonical-100",
      })
    );

    const splitReceipt = await Effect.runPromise(
      service.resolveIdentity("prop-split-1", "dec-supervisor-split-1")
    );

    expect(splitReceipt.status).toBe("resolved");
    expect(splitReceipt.action).toBe("split");
    // Historical references preserve original IDs and the split event trace
    expect(splitReceipt.historicalReferences).toContain("crm:cust-1");
    expect(splitReceipt.historicalReferences).toContain("canonical-100");
    expect(
      splitReceipt.historicalReferences.some((ref) =>
        ref.startsWith("split_event:prop-split-1")
      )
    ).toBe(true);

    // Invalidation of affected projections
    expect(splitReceipt.invalidatedProjections).toContain(
      "projection:crm:crm:cust-1"
    );
    expect(splitReceipt.invalidatedProjections).toContain(
      "projection:canonical:canonical-100"
    );
    expect(splitReceipt.invalidatedProjections).toContain(
      "projection:split:prop-split-1"
    );
  });

  it("marks derived answer as stale when dependencies exceed freshness budget (S04)", async () => {
    const service = ReconciliationService.make();
    const objectStore = new BitemporalObjectStore();

    const patientId = "patient-fresh-1";
    const patientObj: ObjectInstance = {
      id: patientId,
      lastModifiedAt: Date.now() - 20000,
      properties: { name: "Alice", status: "admitted" },
      typeId: "Patient" as ObjectTypeId,
      version: 1,
    };
    await Effect.runPromise(
      objectStore.putObject(patientObj, Date.now() - 20000)
    );

    const worldView = createWorldView({
      definitionReleaseRef: "rel-v1-hash",
      environmentId: "production",
      evidenceCoverage: ["digest-art-1"],
      knowledgeRevision: 1,
      ontologyId: "clinical.core",
      pinnedAt: Date.now(),
      policyContext: {},
      tenantId: "tenant-hospital-1",
      validTime: Date.now() - 15000, // 15 seconds ago
    });

    // Query with maxStalenessMs of 5000 (5s): 15s age exceeds 5s budget
    const resultStale = await Effect.runPromise(
      service.query(
        {
          cursor: null,
          params: {},
          queryId: "Patient",
          releaseRef: "rel-v1-hash",
          worldView,
        },
        objectStore,
        { maxStalenessMs: 5000 }
      )
    );

    expect(resultStale.coverage.isStale).toBe(true);
    expect(resultStale.coverage.completeness).toBe("stale");
    expect(resultStale.rows).toHaveLength(1);
    expect(resultStale.worldView.digest).toBe(worldView.digest);

    // With failOnStale, should fail with StaleDependencyError
    const failureExit = await Effect.runPromiseExit(
      service.query(
        {
          cursor: null,
          params: {},
          queryId: "Patient",
          releaseRef: "rel-v1-hash",
          worldView,
        },
        objectStore,
        { failOnStale: true, maxStalenessMs: 5000 }
      )
    );

    expect(failureExit._tag).toBe("Failure");
    if (failureExit._tag === "Failure") {
      const error = failureExit.cause;
      expect(JSON.stringify(error)).toContain("StaleDependencyError");
    }

    // Query with generous budget (30s): stays fresh
    const resultFresh = await Effect.runPromise(
      service.query(
        {
          cursor: null,
          params: {},
          queryId: "Patient",
          releaseRef: "rel-v1-hash",
          worldView,
        },
        objectStore,
        { maxStalenessMs: 30000 }
      )
    );
    expect(resultFresh.coverage.isStale).toBe(false);
    expect(resultFresh.coverage.completeness).toBe("complete");
  });

  it("does not disclose existence when tenant does not match", async () => {
    const service = ReconciliationService.make({ tenantId: "tenant-corp-a" });

    await Effect.runPromise(
      service.proposeIdentityResolution({
        action: "link",
        confidence: 0.99,
        evidence: [mockProvenance],
        proposalId: "prop-secret-1",
        sourceKey: "sec-key-1",
        sourceSystem: "system-a",
        splitDetails: null,
        targetCanonicalId: "canonical-secret-1",
        tenantId: "tenant-corp-a",
      })
    );

    // Call from tenant-corp-b
    const getExit = await Effect.runPromiseExit(
      service.getProposal("prop-secret-1", "tenant-corp-b")
    );
    expect(getExit._tag).toBe("Failure");
    if (getExit._tag === "Failure") {
      expect(JSON.stringify(getExit.cause)).toContain(
        "IdentityResolutionNotFoundError"
      );
    }

    const resolveExit = await Effect.runPromiseExit(
      service.resolveIdentity("prop-secret-1", "dec-1", {
        tenantId: "tenant-corp-b",
      })
    );
    expect(resolveExit._tag).toBe("Failure");
    if (resolveExit._tag === "Failure") {
      expect(JSON.stringify(resolveExit.cause)).toContain(
        "IdentityResolutionNotFoundError"
      );
    }
  });

  it("enforces idempotency: replays on identical payload and conflicts on altered payload", async () => {
    const service = ReconciliationService.make();

    await Effect.runPromise(
      service.proposeIdentityResolution({
        action: "merge",
        confidence: 0.95,
        evidence: [mockProvenance],
        proposalId: "prop-idem-1",
        sourceKey: "crm:key-99",
        sourceSystem: "crm",
        splitDetails: null,
        targetCanonicalId: "canonical-99",
      })
    );

    // First call with idempotencyKey
    const receipt1 = await Effect.runPromise(
      service.resolveIdentity("prop-idem-1", "dec-alpha", {
        idempotencyKey: "idem-res-1",
      })
    );
    expect(receipt1.status).toBe("resolved");

    // Replay with exact same parameters
    const receipt2 = await Effect.runPromise(
      service.resolveIdentity("prop-idem-1", "dec-alpha", {
        idempotencyKey: "idem-res-1",
      })
    );
    expect(receipt2.resolutionId).toBe(receipt1.resolutionId);

    // Replay with DIFFERENT decisionRef on same key: must fail with IdempotencyConflictError
    const conflictExit = await Effect.runPromiseExit(
      service.resolveIdentity("prop-idem-1", "dec-CONFLICTING-BETA", {
        idempotencyKey: "idem-res-1",
      })
    );

    expect(conflictExit._tag).toBe("Failure");
    if (conflictExit._tag === "Failure") {
      expect(JSON.stringify(conflictExit.cause)).toContain(
        "IdempotencyConflictError"
      );
    }
  });

  it("preserves state across export and import snapshots (crash recovery)", async () => {
    const service1 = ReconciliationService.make();

    await Effect.runPromise(
      service1.proposeIdentityResolution({
        action: "link",
        confidence: 0.99,
        evidence: [mockProvenance],
        proposalId: "prop-recovery-1",
        sourceKey: "legacy:id-77",
        sourceSystem: "legacy_db",
        splitDetails: null,
        targetCanonicalId: "canonical-77",
      })
    );

    await Effect.runPromise(
      service1.resolveIdentity("prop-recovery-1", "dec-recovery-1", {
        idempotencyKey: "idem-rec-1",
      })
    );

    const snapshot = service1.exportSnapshot();

    // Create a new instance (simulating restart)
    const service2 = ReconciliationService.make();
    service2.importSnapshot(snapshot);

    const prop = await Effect.runPromise(
      service2.getProposal("prop-recovery-1")
    );
    expect(prop.status).toBe("resolved");

    const replayed = await Effect.runPromise(
      service2.resolveIdentity("prop-recovery-1", "dec-recovery-1", {
        idempotencyKey: "idem-rec-1",
      })
    );
    expect(replayed.canonicalId).toBe("canonical-77");
  });

  it("compiles bitemporal explain query plan per S04", () => {
    const service = ReconciliationService.make();
    const plan = service.explainQuery({
      dialect: "sqlite",
      id: "P001",
      txTime: 1700000000,
      typeId: "Patient",
      validTime: 1700000000,
    });
    expect(plan.sql).toContain("SELECT");
    expect(plan.sql).toContain("FROM operon_objects");
    expect(plan.params).toEqual([
      "Patient",
      "P001",
      1700000000,
      1700000000,
      1700000000,
      1700000000,
    ]);
  });
});
