import { defineLinkType, defineObjectType } from "@operon/schema";
import { Data, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ApprovalsEngine,
  ApprovalsPolicyViolationError,
  BitemporalObjectStore,
  CircuitBreaker,
  CircuitBreakerOpenError,
  CROVEngine,
  DegradeModeManager,
  evaluateStructuralReadinessL2,
  MigrationEngine,
  SystemHealthMap,
  VEDOVerifier,
} from "./index.js";

class TestNetworkError extends Data.TaggedError("TestNetworkError")<{
  readonly message: string;
}> {}

describe("Runtime Extended: Approvals, Migration, Verification & Resilience", () => {
  describe("ApprovalsEngine (The Palantir Impact Ch. 4-3)", () => {
    const approvalsEngine = new ApprovalsEngine({
      requiredMinApprovals: 2,
      requireComplianceReview: true,
      requireDomainSpecialistReview: true,
    });

    it("enforces multi-stakeholder approval policy and blocks merge until satisfied", async () => {
      const initialProposal: any = {
        id: "prop_101",
        title: "Add Telemetry Index",
        description: "Scale ingestion for high frequency sensor data",
        sourceBranch: "feat/telemetry",
        targetBranch: "main",
        author: { id: "eng_1", roles: ["fde"] },
        status: "open",
        changeSet: {
          addedObjectTypes: [],
          modifiedObjectTypes: [],
          deletedObjectTypeIds: [],
          addedLinkTypes: [],
          modifiedLinkTypes: [],
          deletedLinkTypeIds: [],
          addedActionTypes: [],
          modifiedActionTypes: [],
          deletedActionTypeIds: [],
        },
        reviews: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Check initial eligibility
      const initialEligibility =
        approvalsEngine.evaluateProposal(initialProposal);
      expect(initialEligibility.canMerge).toBe(false);
      expect(initialEligibility.reasons.length).toBeGreaterThan(0);

      // Review 1: Domain Specialist signs off
      const p1 = await Effect.runPromise(
        approvalsEngine.submitReview(
          initialProposal,
          { id: "lead_specialist", roles: ["domain_specialist"] },
          "approve",
          "Domain logic verified."
        )
      );
      expect(p1.status).toBe("under_review");

      // Attempt merge prematurely should fail
      const preMergeResult = await Effect.runPromise(
        approvalsEngine.assertMergeable(p1).pipe(Effect.flip)
      );
      expect(preMergeResult).toBeInstanceOf(ApprovalsPolicyViolationError);

      // Review 2: Compliance Officer signs off
      const p2 = await Effect.runPromise(
        approvalsEngine.submitReview(
          p1,
          { id: "compliance_lead", roles: ["compliance_officer"] },
          "approve",
          "Regulatory requirements checked."
        )
      );
      expect(p2.status).toBe("approved");

      // Now assertMergeable should succeed
      await Effect.runPromise(approvalsEngine.assertMergeable(p2));
    });
  });

  describe("MigrationEngine (Book Chapter 15: Migration & Coexistence)", () => {
    it("processes CDC streaming events and computes shadow consistency", async () => {
      const store = new BitemporalObjectStore();
      const migration = new MigrationEngine(store);

      expect(migration.getStage()).toBe("shadow_run");

      // 1. Ingest CDC event from legacy ERP
      await Effect.runPromise(
        migration.ingestCdcEvent(
          {
            id: "cdc_evt_1",
            sourceSystem: "SAP_ERP",
            table: "EQUIPMENT",
            operation: "insert",
            primaryKey: { EQ_ID: "PUMP-101" },
            afterState: {
              EQ_ID: "PUMP-101",
              STATUS: "ACTIVE",
              RATED_FLOW: 450,
            },
            capturedAt: Date.now(),
          },
          "Pump",
          (raw) => ({
            id: String(raw.EQ_ID),
            properties: {
              status: raw.STATUS,
              ratedFlowGpm: raw.RATED_FLOW,
            },
          })
        )
      );

      // Verify object exists in OSv2
      const pump = await Effect.runPromise(
        store.getObject("Pump" as any, "PUMP-101")
      );
      expect(pump?.properties.status).toBe("ACTIVE");

      // 2. Perform shadow comparison with legacy record
      const diffMatch = await Effect.runPromise(
        migration.compareShadowRecord("Pump", "PUMP-101", {
          status: "ACTIVE",
          ratedFlowGpm: 450,
        })
      );
      expect(diffMatch.match).toBe(true);

      const diffDivergence = await Effect.runPromise(
        migration.compareShadowRecord("Pump", "PUMP-101", {
          status: "INACTIVE",
          ratedFlowGpm: 400,
        })
      );
      expect(diffDivergence.match).toBe(false);
      expect(diffDivergence.divergentKeys).toContain("status");

      // 3. Check cutover metrics
      const metrics = migration.getCutoverMetrics();
      expect(metrics.totalEventsProcessed).toBe(1);
      expect(metrics.totalShadowComparisons).toBe(2);
      expect(metrics.matchingCount).toBe(1);
      expect(metrics.consistencyRate).toBe(0.5);
    });
  });

  describe("Verification: Two-Layer 4C Cascade L2, CROV & VEDO (Book Chapter 16)", () => {
    const PatientType = defineObjectType({
      id: "Patient",
      name: "Patient",
      description: "Clinical patient",
      typology: "master",
      primaryKey: "patientId",
      properties: {
        patientId: {
          schema: Schema.String,
          description: "ID",
        },
        status: {
          schema: Schema.String,
          description: "Clinical status",
        },
      },
    });

    it("evaluates Layer 2 Structural Readiness and detects dangling links", async () => {
      const invalidLink = defineLinkType({
        id: "treatedAt",
        description: "Patient treatment relation",
        sourceTypeId: "Patient",
        targetTypeId: "UnknownClinic", // Dangling!
        sourceToTargetName: "clinic",
        targetToSourceName: "patients",
        cardinality: "many-to-one",
      });

      const readiness = await Effect.runPromise(
        evaluateStructuralReadinessL2([PatientType], [invalidLink])
      );

      expect(readiness.isReady).toBe(false);
      expect(readiness.correctness.valid).toBe(false);
      expect(readiness.correctness.danglingLinkReferences.length).toBe(1);
    });

    it("collaboratively verifies proposals using CROVEngine", async () => {
      const crov = new CROVEngine();
      const validProposal: any = {
        id: "prop_crov_1",
        title: "Add Clinic Link",
        changeSet: {
          addedObjectTypes: [
            defineObjectType({
              id: "Clinic",
              name: "Clinic",
              description: "Hospital department clinic",
              typology: "master",
              primaryKey: "clinicId",
              properties: {
                clinicId: {
                  schema: Schema.String,
                  description: "Clinic ID",
                },
              },
            }),
          ],
          modifiedObjectTypes: [],
          deletedObjectTypeIds: [],
          addedLinkTypes: [
            defineLinkType({
              id: "patientClinic",
              description: "Patient to clinic relation",
              sourceTypeId: "Patient",
              targetTypeId: "Clinic",
              sourceToTargetName: "clinic",
              targetToSourceName: "patients",
              cardinality: "many-to-one",
            }),
          ],
          modifiedLinkTypes: [],
          deletedLinkTypeIds: [],
          addedActionTypes: [],
          modifiedActionTypes: [],
          deletedActionTypeIds: [],
        },
      };

      const result = await Effect.runPromise(
        crov.verifyProposal(validProposal, [PatientType], [])
      );
      expect(result.isReady).toBe(true);
    });

    it("verifies formal mathematical and state transition invariants with VEDO", async () => {
      const vedo = new VEDOVerifier();
      vedo.registerSuite({
        objectTypeId: "DosingPump",
        boundaries: [
          { property: "strokeRate", min: 0, max: 100 },
          { property: "chemicalFlowRateLph", min: 0, max: 50 },
        ],
        transitions: {
          property: "operatingMode",
          allowedTransitions: {
            standby: ["priming", "offline"],
            priming: ["dosing", "standby"],
            dosing: ["standby", "offline"],
            offline: ["standby"],
          },
        },
      });

      // Valid mutation
      await Effect.runPromise(
        vedo.verifyMutation(
          "DosingPump",
          { strokeRate: 50, chemicalFlowRateLph: 20, operatingMode: "priming" },
          { operatingMode: "standby" }
        )
      );

      // Boundary violation: rate > 100
      const boundaryFailure = await Effect.runPromise(
        vedo
          .verifyMutation("DosingPump", {
            strokeRate: 120,
            chemicalFlowRateLph: 20,
          })
          .pipe(Effect.flip)
      );
      expect(boundaryFailure.issues[0]).toContain("exceeds maximum bound 100");

      // Illegal transition: standby -> dosing directly
      const transitionFailure = await Effect.runPromise(
        vedo
          .verifyMutation(
            "DosingPump",
            {
              strokeRate: 50,
              chemicalFlowRateLph: 20,
              operatingMode: "dosing",
            },
            { operatingMode: "standby" }
          )
          .pipe(Effect.flip)
      );
      expect(transitionFailure.issues[0]).toContain("Illegal state transition");
    });
  });

  describe("Resilience: Circuit Breakers, Degrade Modes & Health Map (Book Chapter 17)", () => {
    it("trips circuit breaker after threshold failures and protects downstream systems", async () => {
      const breaker = new CircuitBreaker("ERP_Gateway", {
        failureThreshold: 2,
        recoveryTimeoutMs: 500,
        successThreshold: 1,
      });

      const failingTask = Effect.fail(
        new TestNetworkError({ message: "Network timeout" })
      );

      // Failure 1
      await Effect.runPromise(breaker.execute(failingTask).pipe(Effect.flip));
      expect(breaker.getState()).toBe("closed");

      // Failure 2 -> Trips open
      await Effect.runPromise(breaker.execute(failingTask).pipe(Effect.flip));
      expect(breaker.getState()).toBe("open");

      // While open, should fail immediately with CircuitBreakerOpenError without executing
      const callWhileOpen = await Effect.runPromise(
        breaker.execute(Effect.succeed(42)).pipe(Effect.flip)
      );
      expect(callWhileOpen).toBeInstanceOf(CircuitBreakerOpenError);
    });

    it("manages degrade modes and enforces operational constraints", async () => {
      const degradeManager = new DegradeModeManager();
      expect(degradeManager.getMode()).toBe("normal");

      // Allow all in normal
      await Effect.runPromise(degradeManager.assertActionPermitted({}));

      // Switch to veto_only
      await Effect.runPromise(degradeManager.setMode("veto_only"));

      // Standard action should be blocked
      const blockedAction = await Effect.runPromise(
        degradeManager
          .assertActionPermitted({ isVetoOrOverride: false })
          .pipe(Effect.flip)
      );
      expect(blockedAction._tag).toBe("DegradedModeViolationError");

      // Human veto should be allowed
      await Effect.runPromise(
        degradeManager.assertActionPermitted({ isVetoOrOverride: true })
      );
    });

    it("generates composite System Health Map", async () => {
      const degradeManager = new DegradeModeManager();
      const healthMap = new SystemHealthMap(degradeManager);

      healthMap.registerProbe("bitemporal_osv2", () =>
        Effect.succeed({
          name: "bitemporal_osv2",
          status: "healthy",
          details: "Store latency 0.8ms",
          lastChecked: Date.now(),
        })
      );

      healthMap.registerProbe("funnel_streaming", () =>
        Effect.succeed({
          name: "funnel_streaming",
          status: "healthy",
          details: "Kafka lag: 12ms",
          lastChecked: Date.now(),
        })
      );

      const health = await Effect.runPromise(healthMap.evaluateHealth());
      expect(health.overall).toBe("healthy");
      expect(health.components.bitemporal_osv2.status).toBe("healthy");
      expect(health.components.funnel_streaming.status).toBe("healthy");
    });
  });
});
