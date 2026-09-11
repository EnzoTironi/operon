import { createSign, generateKeyPairSync } from "node:crypto";

import type {
  ActionSubmission,
  LinkTypeId,
  ObjectInstance,
  ObjectTypeId,
  OntologyProposal,
  Subject,
} from "@operon/schema";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Duration, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ApprovalsEngine } from "./approvals.js";
import { InMemoryAuditStore } from "./audit.js";
import { HttpAuthMiddleware, OidcTokenVerifier } from "./auth.js";
import { BitemporalObjectStore } from "./bitemporal-store.js";
import { DistributedLockManager } from "./cluster.js";
import { ColumnarBatchEncoder } from "./columnar-store.js";
import { KafkaCdcConnector, WarehouseBatchConnector } from "./connectors.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConcurrentModificationError,
  FreshnessBudgetExceededError,
  LockAcquisitionError,
  NotFoundError,
  ProposalExecutionStateError,
  ProposalNotFoundError,
  SandboxExecutionError,
  SideEffectExecutionError,
  StaleFencingTokenError,
  StorageError,
  SubmissionCriteriaFailedError,
  ValidationError,
} from "./errors.js";
import { FunnelIngestionError, FunnelService } from "./funnel.js";
import { ActionInbox } from "./inbox.js";
import { MigrationEngine } from "./migration.js";
import { InMemoryObjectStore } from "./object-store.js";
import {
  ApprovalsPolicyViolationError,
  BranchNotFoundError,
  OntologyMetadataService,
} from "./oms.js";
import { ObjectSetService } from "./oss.js";
import { evaluateDecisionReadiness } from "./readiness.js";
import {
  DegradeModeManager,
  DegradedModeViolationError,
  SystemHealthMap,
} from "./resilience.js";
import { SandboxedModelRunner } from "./sandbox.js";
import { DynamicSecurityEngine } from "./security-views.js";
import { EmbeddedSqlDriver, SqlBitemporalStore } from "./sql-store.js";
import {
  CROVEngine,
  StructuralVerificationError,
  VEDOVerifier,
} from "./verification.js";
import { executeWritePipeline } from "./write-pipeline.js";

describe("Kernel-Level Comprehensive & Non-Tautological Coverage", () => {
  describe("ActionInbox (inbox.ts)", () => {
    it("rejects approval of non-existent proposals with ProposalNotFoundError", async () => {
      const store = new InMemoryObjectStore();
      const audit = new InMemoryAuditStore();
      const inbox = new ActionInbox(audit, store);

      const human: Subject = {
        id: "doctor-1",
        name: "Dr. Zhang",
        roles: ["physician"],
        type: "user",
      };

      const res = await Effect.runPromise(
        inbox
          .approveProposal("non-existent-proposal-id", human)
          .pipe(Effect.result)
      );

      expect(res._tag).toBe("Failure");
      if (res._tag === "Failure") {
        expect(res.failure).toBeInstanceOf(ProposalNotFoundError);
      }
    });

    it("records structured human veto overrides in audit ledger and updates status", async () => {
      const store = new InMemoryObjectStore();
      const audit = new InMemoryAuditStore();
      const inbox = new ActionInbox(audit, store);

      const PatientType = defineObjectType({
        description: "Patient",
        id: "Patient",
        name: "Patient",
        primaryKey: "id",
        properties: {
          dose: defineProperty({ description: "Dose", schema: Schema.Number }),
          id: defineProperty({ description: "ID", schema: Schema.String }),
        },
        typology: "master",
      });

      await Effect.runPromise(
        store.putObject({
          id: "P1",
          lastModifiedAt: Date.now(),
          properties: { dose: 10, id: "P1" },
          typeId: PatientType.id,
          version: 1,
        })
      );

      const Action = defineActionType({
        defaultExecutionMode: "proposal",
        description: "Change dose",
        id: "change_dose",
        minimumAgentTier: 2,
        name: "Change Dose",
        parametersSchema: Schema.Struct({
          newDose: Schema.Number,
          patientId: Schema.String,
        }),
        riskTier: "medium",
      });

      const submission = {
        actionType: Action,
        rawParameters: { newDose: 14, patientId: "P1" },
        security: {
          correlationId: "corr-1",
          subject: {
            agentTier: 2 as const,
            id: "agent-opt",
            name: "OptAgent",
            roles: [],
            type: "agent" as const,
          },
          timestamp: Date.now(),
        },
      };

      const result = await Effect.runPromise(
        executeWritePipeline(submission, store, audit)
      );
      expect(result.status).toBe("proposed");

      const proposalItem = inbox.addProposal(submission, result.decisionRecord);
      expect(inbox.getPendingProposals().length).toBe(1);

      // Human expert exercises structured veto
      const human: Subject = {
        id: "specialist-1",
        name: "Dr. Henderson",
        roles: ["endocrinologist"],
        type: "user",
      };

      const override = await Effect.runPromise(
        inbox.rejectProposal(
          proposalItem.id,
          human,
          "clinical_discretion",
          "Patient has high hypoglycemia risk based on recent meals"
        )
      );

      expect(override.reasonCategory).toBe("clinical_discretion");
      expect(override.humanSubject.id).toBe("specialist-1");
      expect(inbox.getPendingProposals().length).toBe(0);

      // Rejecting already rejected proposal fails
      const reReject = await Effect.runPromise(
        inbox
          .rejectProposal(
            proposalItem.id,
            human,
            "clinical_discretion",
            "duplicate"
          )
          .pipe(Effect.result)
      );
      expect(reReject._tag).toBe("Failure");
    });
  });

  describe("Authentication & Token Claims (auth.ts)", () => {
    it("verifies RS256 RSA signatures end-to-end", async () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { format: "pem", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
      });

      const verifier = new OidcTokenVerifier({
        expectedAudience: "operon-api",
        expectedIssuer: "https://auth.operon.internal",
        secretOrPublicKey: publicKey,
      });

      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT" })
      ).toString("base64url");
      const claims = {
        aud: "operon-api",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://auth.operon.internal",
        roles: ["analyst"],
        sub: "user-rsa-100",
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");

      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      const sig = signer.sign(privateKey).toString("base64url");
      const validJwt = `${header}.${payload}.${sig}`;

      const verifiedClaims = await Effect.runPromise(
        verifier.verifyToken(validJwt)
      );
      expect(verifiedClaims.sub).toBe("user-rsa-100");
      expect(verifiedClaims.roles).toContain("analyst");
    });

    it("rejects expired tokens, future nbf, issuer mismatch, and audience mismatch", async () => {
      const secret = "shared-symmetric-secret-key-12345";
      const verifier = new OidcTokenVerifier({
        clockToleranceSeconds: 5,
        expectedAudience: "expected-aud",
        expectedIssuer: "https://trusted-issuer",
        secretOrPublicKey: secret,
      });

      // 1. Expired Token
      const expClaims = {
        aud: "expected-aud",
        exp: Math.floor(Date.now() / 1000) - 100,
        iss: "https://trusted-issuer",
        sub: "user-exp",
      };
      const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
        "base64url"
      );
      const expPayload = Buffer.from(JSON.stringify(expClaims)).toString(
        "base64url"
      );
      const { createHmac } = await import("node:crypto");
      const expSig = createHmac("sha256", secret)
        .update(`${h}.${expPayload}`)
        .digest("base64url");
      const expRes = await Effect.runPromise(
        verifier.verifyToken(`${h}.${expPayload}.${expSig}`).pipe(Effect.result)
      );
      expect(expRes._tag).toBe("Failure");

      // 2. Future nbf
      const nbfClaims = {
        aud: "expected-aud",
        iss: "https://trusted-issuer",
        nbf: Math.floor(Date.now() / 1000) + 200,
        sub: "user-nbf",
      };
      const nbfPayload = Buffer.from(JSON.stringify(nbfClaims)).toString(
        "base64url"
      );
      const nbfSig = createHmac("sha256", secret)
        .update(`${h}.${nbfPayload}`)
        .digest("base64url");
      const nbfRes = await Effect.runPromise(
        verifier.verifyToken(`${h}.${nbfPayload}.${nbfSig}`).pipe(Effect.result)
      );
      expect(nbfRes._tag).toBe("Failure");

      // 3. Issuer mismatch
      const issClaims = {
        aud: "expected-aud",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://untrusted-issuer",
        sub: "user-iss",
      };
      const issPayload = Buffer.from(JSON.stringify(issClaims)).toString(
        "base64url"
      );
      const issSig = createHmac("sha256", secret)
        .update(`${h}.${issPayload}`)
        .digest("base64url");
      const issRes = await Effect.runPromise(
        verifier.verifyToken(`${h}.${issPayload}.${issSig}`).pipe(Effect.result)
      );
      expect(issRes._tag).toBe("Failure");

      // 4. Audience mismatch
      const audClaims = {
        aud: "wrong-aud",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://trusted-issuer",
        sub: "user-aud",
      };
      const audPayload = Buffer.from(JSON.stringify(audClaims)).toString(
        "base64url"
      );
      const audSig = createHmac("sha256", secret)
        .update(`${h}.${audPayload}`)
        .digest("base64url");
      const audRes = await Effect.runPromise(
        verifier.verifyToken(`${h}.${audPayload}.${audSig}`).pipe(Effect.result)
      );
      expect(audRes._tag).toBe("Failure");
    });

    it("rejects missing or non-Bearer authorization headers in HttpAuthMiddleware", async () => {
      const verifier = new OidcTokenVerifier({ secretOrPublicKey: "secret" });
      const middleware = new HttpAuthMiddleware(verifier);

      const missingRes = await Effect.runPromise(
        middleware.authenticateHeader().pipe(Effect.result)
      );
      expect(missingRes._tag).toBe("Failure");

      const basicRes = await Effect.runPromise(
        middleware.authenticateHeader("Basic dXNlcjpwYXNz").pipe(Effect.result)
      );
      expect(basicRes._tag).toBe("Failure");

      const malformedRes = await Effect.runPromise(
        verifier.verifyToken("not.enough.parts.really").pipe(Effect.result)
      );
      expect(malformedRes._tag).toBe("Failure");
    });
  });

  describe("Distributed Lock Manager (cluster.ts)", () => {
    it("enforces fencing token uniqueness, renewal, and lease expiration", async () => {
      const dlm = new DistributedLockManager();

      // Acquire initial lock
      const lock1 = await Effect.runPromise(
        dlm.acquire("resource:aeration-tank", "worker-1", 100)
      );
      expect(lock1.ownerId).toBe("worker-1");
      expect(lock1.fencingToken).toBe(1);

      // Renew with valid credentials
      const renewed = await Effect.runPromise(dlm.renew(lock1, 200));
      expect(renewed.leaseExpiresAt).toBeGreaterThan(lock1.leaseExpiresAt);

      // Renew with fraudulent ownerId fails
      const badOwnerLock = { ...renewed, ownerId: "impostor" };
      const badOwnerRes = await Effect.runPromise(
        dlm.renew(badOwnerLock).pipe(Effect.result)
      );
      expect(badOwnerRes._tag).toBe("Failure");
      if (badOwnerRes._tag === "Failure") {
        expect(badOwnerRes.failure).toBeInstanceOf(LockAcquisitionError);
      }

      // Renew with stale fencing token fails
      const badTokenLock = { ...renewed, fencingToken: 999 };
      const badTokenRes = await Effect.runPromise(
        dlm.renew(badTokenLock).pipe(Effect.result)
      );
      expect(badTokenRes._tag).toBe("Failure");

      // Release lock successfully
      await Effect.runPromise(dlm.release(renewed));

      // Re-acquiring yields next incremented fencing token
      const lock2 = await Effect.runPromise(
        dlm.acquire("resource:aeration-tank", "worker-2", 500)
      );
      expect(lock2.ownerId).toBe("worker-2");
      expect(lock2.fencingToken).toBe(2);
    });
  });

  describe("Bitemporal Store (bitemporal-store.ts)", () => {
    it("handles object deletion, reverse links, and historical time intervals", async () => {
      const bStore = new BitemporalObjectStore();
      const typeId = "Aircraft" as ObjectTypeId;

      // 1. Put object
      await Effect.runPromise(
        bStore.putObject({
          id: "AC-100",
          lastModifiedAt: 1000,
          properties: { status: "active" },
          typeId,
          validFrom: 1000,
          version: 1,
        })
      );

      const objBefore = await Effect.runPromise(
        bStore.getObject(typeId, "AC-100")
      );
      expect(objBefore?.id).toBe("AC-100");

      // 2. Delete object
      await Effect.runPromise(bStore.deleteObject(typeId, "AC-100"));
      const objAfter = await Effect.runPromise(
        bStore.getObject(typeId, "AC-100")
      );
      expect(objAfter).toBeUndefined();

      // 3. Reverse links
      const linkType = "FlightToAircraft" as LinkTypeId;
      await Effect.runPromise(
        bStore.linkObjects({
          createdAt: Date.now(),
          linkTypeId: linkType,
          sourceId: "FLIGHT-1",
          targetId: "AC-100",
        })
      );

      const reverse = await Effect.runPromise(
        bStore.getReverseLinks(linkType, "AC-100")
      );
      expect(reverse.length).toBe(1);
      expect(reverse[0].sourceId).toBe("FLIGHT-1");
    });
  });

  describe("Saga Orchestration & Reverse Compensation (write-pipeline.ts)", () => {
    it("rolls back previously executed side effects in reverse order upon downstream failure", async () => {
      const store = new InMemoryObjectStore();
      const audit = new InMemoryAuditStore();

      const callOrder: string[] = [];

      const SagaAction = defineActionType({
        defaultExecutionMode: "automated",
        description: "Multi-step saga action",
        id: "multi_step_saga",
        minimumAgentTier: 1,
        name: "Multi-step Saga",
        parametersSchema: Schema.Struct({ paramVal: Schema.String }),
        riskTier: "high",
        sideEffects: [
          {
            compensate: () =>
              Effect.sync(() => {
                callOrder.push("compensate_step_1");
              }),
            description: "Step 1",
            execute: () =>
              Effect.sync(() => {
                callOrder.push("execute_step_1");
              }),
            id: "step_1",
          },
          {
            compensate: () =>
              Effect.sync(() => {
                callOrder.push("compensate_step_2");
              }),
            description: "Step 2",
            execute: () =>
              Effect.sync(() => {
                callOrder.push("execute_step_2");
              }),
            id: "step_2",
          },
          {
            description: "Step 3 (Fails)",
            execute: () =>
              Effect.fail(
                new StorageError({ message: "Downstream service unreachable" })
              ),
            id: "step_3_fail",
          },
        ],
      });

      const res = await Effect.runPromise(
        executeWritePipeline(
          {
            actionType: SagaAction,
            rawParameters: { paramVal: "test" },
            security: {
              correlationId: "saga-corr-1",
              subject: {
                id: "admin",
                name: "Admin",
                roles: ["admin"],
                type: "user",
              },
              timestamp: Date.now(),
            },
          },
          store,
          audit
        ).pipe(Effect.result)
      );

      expect(res._tag).toBe("Failure");
      if (res._tag === "Failure") {
        expect(res.failure).toBeInstanceOf(SideEffectExecutionError);
      }

      // Invariant: Reverse compensation must execute steps 2 then 1
      expect(callOrder).toEqual([
        "execute_step_1",
        "execute_step_2",
        "compensate_step_2",
        "compensate_step_1",
      ]);

      // Invariant: Audit log must contain the compensation record
      const decisions = await Effect.runPromise(audit.listDecisions());
      const compRecord = decisions.find((d) => d.outcome === "compensated");
      expect(compRecord).toBeDefined();
      expect(compRecord?.reason).toContain("Downstream service unreachable");
    });
  });

  describe("Connectors & Funnel Conflicts (connectors.ts & funnel.ts)", () => {
    it("handles Debezium CDC delete operations and property transform errors", async () => {
      const store = new InMemoryObjectStore();
      const funnel = new FunnelService(store);
      const cdc = new KafkaCdcConnector(funnel);

      await Effect.runPromise(
        funnel.registerPipeline({
          conflictPolicy: "source_wins",
          id: "pipe-patients",
          mode: "streaming",
          name: "Patient Pipeline",
          primaryKeyField: "id",
          propertyMappings: [
            { sourceField: "id", targetPropertyName: "id" },
            { sourceField: "name", targetPropertyName: "name" },
          ],
          sourceDatasetId: "legacy-db",
          targetObjectTypeId: "Patient",
        })
      );

      cdc.registerTableMapping("patients", {
        pipelineId: "pipe-patients",
        primaryKeyField: "id",
        targetTypeId: "Patient" as ObjectTypeId,
      });

      // Initial create record
      await Effect.runPromise(
        cdc.consumeMessage({
          payload: {
            after: { id: "P-10", name: "Alice" },
            before: null,
            op: "c",
            source: { lsn: 100, table: "patients", ts_ms: 1000 },
          },
        })
      );

      const stats = cdc.getStats();
      expect(stats.processedCount).toBe(1);
      expect(stats.lastLsn).toBe(100);

      // Process CDC delete event
      await Effect.runPromise(
        cdc.consumeMessage({
          payload: {
            after: null,
            before: { id: "P-10" },
            op: "d",
            source: { lsn: 101, table: "patients", ts_ms: 1050 },
          },
        })
      );

      expect(cdc.getStats().lastLsn).toBe(101);

      // Warehouse Batch Ingestion in chunks
      const batchConnector = new WarehouseBatchConnector(funnel);
      const report = await Effect.runPromise(
        batchConnector.ingestBatch(
          [
            { id: "P-1", name: "Alice" },
            { id: "P-2", name: "Bob" },
          ],
          {
            chunkSize: 1,
            pipelineId: "pipe-patients",
            sourceSystem: "snowflake",
            targetTypeId: "Patient" as ObjectTypeId,
          }
        )
      );
      expect(report.totalRecords).toBe(2);
      expect(report.chunksProcessed).toBe(2);
      expect(report.errors.length).toBe(0);
    });

    it("enforces user_edit_wins and timestamp_wins conflict resolution policies", async () => {
      const store = new InMemoryObjectStore();
      const funnel = new FunnelService(store);

      // 1. user_edit_wins: Version > 1 (edited by human) is protected from pipeline overwrite
      await Effect.runPromise(
        funnel.registerPipeline({
          conflictPolicy: "user_edit_wins",
          id: "pipe-user-edit-wins",
          mode: "streaming",
          name: "Asset Pipeline",
          primaryKeyField: "id",
          propertyMappings: [
            { sourceField: "id", targetPropertyName: "id" },
            { sourceField: "title", targetPropertyName: "title" },
          ],
          sourceDatasetId: "sap",
          targetObjectTypeId: "Asset",
        })
      );

      await Effect.runPromise(
        store.putObject({
          id: "AST-1",
          lastModifiedAt: 5000,
          properties: { id: "AST-1", title: "Human Edited Name" },
          typeId: "Asset" as ObjectTypeId,
          version: 2, // version > 1 protects against overwrite
        })
      );

      await Effect.runPromise(
        funnel.ingestStreamRecord("pipe-user-edit-wins", {
          id: "AST-1",
          title: "SAP Overwrite Attempt",
        })
      );

      const objAfter = await Effect.runPromise(
        store.getObject("Asset" as ObjectTypeId, "AST-1")
      );
      expect(objAfter?.properties.title).toBe("Human Edited Name"); // Preserved!

      // 2. timestamp_wins: Stale timestamps rejected
      await Effect.runPromise(
        funnel.registerPipeline({
          conflictPolicy: "timestamp_wins",
          id: "pipe-ts-wins",
          mode: "streaming",
          name: "Sensor Pipeline",
          primaryKeyField: "id",
          propertyMappings: [
            { sourceField: "id", targetPropertyName: "id" },
            { sourceField: "val", targetPropertyName: "val" },
          ],
          sourceDatasetId: "scada",
          targetObjectTypeId: "Sensor",
        })
      );

      const now = Date.now();
      await Effect.runPromise(
        store.putObject({
          id: "SNS-1",
          lastModifiedAt: now,
          properties: { id: "SNS-1", val: 50 },
          typeId: "Sensor" as ObjectTypeId,
          version: 1,
        })
      );

      // Stale record with timestamp (now - 10000) < now
      await Effect.runPromise(
        funnel.ingestStreamRecord("pipe-ts-wins", {
          id: "SNS-1",
          timestamp: now - 10000,
          val: 99,
        })
      );
      const snsAfterStale = await Effect.runPromise(
        store.getObject("Sensor" as ObjectTypeId, "SNS-1")
      );
      expect(snsAfterStale?.properties.val).toBe(50); // Unchanged

      // Fresh record with timestamp (now + 10000) >= now
      await Effect.runPromise(
        funnel.ingestStreamRecord("pipe-ts-wins", {
          id: "SNS-1",
          timestamp: now + 10000,
          val: 99,
        })
      );
      const snsAfterFresh = await Effect.runPromise(
        store.getObject("Sensor" as ObjectTypeId, "SNS-1")
      );
      expect(snsAfterFresh?.properties.val).toBe(99); // Updated!
    });
  });

  describe("Execution Sandbox (sandbox.ts)", () => {
    it("enforces input validation and execution timeouts", async () => {
      const sandbox = new SandboxedModelRunner();

      // 1. Unregistered model fails with ValidationError
      const unkRes = await Effect.runPromise(
        sandbox.execute("unknown_model", {}).pipe(Effect.result)
      );
      expect(unkRes._tag).toBe("Failure");
      if (unkRes._tag === "Failure") {
        expect(unkRes.failure).toBeInstanceOf(ValidationError);
      }

      // 2. Missing required input fails with ValidationError
      sandbox.registerModel({
        compute: () => Effect.succeed({ ok: true }),
        isDeterministic: true,
        modelId: "risk_scoring",
        requiredInputs: ["creditScore", "annualIncome"],
        version: "1.0",
      });

      const missingRes = await Effect.runPromise(
        sandbox
          .execute("risk_scoring", { creditScore: 720 })
          .pipe(Effect.result)
      );
      expect(missingRes._tag).toBe("Failure");
      if (missingRes._tag === "Failure") {
        expect(missingRes.failure).toBeInstanceOf(ValidationError);
        expect((missingRes.failure as ValidationError).details).toContain(
          "annualIncome"
        );
      }

      // 3. Execution timeout fails with SandboxExecutionError
      sandbox.registerModel({
        compute: () =>
          Effect.sleep(Duration.millis(500)).pipe(Effect.as({ done: true })),
        isDeterministic: true,
        modelId: "slow_model",
        requiredInputs: [],
        timeoutMs: 50,
        version: "1.0",
      });

      const timeoutRes = await Effect.runPromise(
        sandbox.execute("slow_model", {}).pipe(Effect.result)
      );
      expect(timeoutRes._tag).toBe("Failure");
      if (timeoutRes._tag === "Failure") {
        expect(timeoutRes.failure).toBeInstanceOf(SandboxExecutionError);
        expect((timeoutRes.failure as SandboxExecutionError).reason).toContain(
          "timed out"
        );
      }
    });
  });

  describe("Strangler Migration & Cutover (migration.ts)", () => {
    it("detects shadow property divergences and gates cutover readiness", async () => {
      const bStore = new BitemporalObjectStore();
      const coord = new MigrationEngine(bStore);

      await Effect.runPromise(
        bStore.putObject({
          id: "ACC-1",
          lastModifiedAt: Date.now(),
          properties: { balance: 1000, status: "active" },
          typeId: "Account" as ObjectTypeId,
          version: 1,
        })
      );

      // Divergent shadow comparison
      const shadowDivergent = await Effect.runPromise(
        coord.compareShadowRecord("Account", "ACC-1", {
          _internalMeta: "ignored",
          balance: 900, // Divergence!
          status: "active",
        })
      );

      expect(shadowDivergent.match).toBe(false);
      expect(shadowDivergent.divergentKeys).toContain("balance");
      expect(shadowDivergent.divergentKeys).not.toContain("_internalMeta"); // ignored

      // Cutover metrics evaluation
      const metrics = coord.getCutoverMetrics();
      expect(metrics.readyForCutover).toBe(false);
    });
  });

  describe("Resilience Health Monitor (resilience.ts)", () => {
    it("classifies overall system health as healthy, degraded, or critical", async () => {
      const degradeMgr = new DegradeModeManager();
      const monitor = new SystemHealthMap(degradeMgr);

      monitor.registerProbe("database", () =>
        Effect.succeed({
          latencyMs: 5,
          message: "OK",
          status: "healthy" as const,
        })
      );
      const healthyReport = await Effect.runPromise(monitor.evaluateHealth());
      expect(healthyReport.overall).toBe("healthy");

      // Degraded probe
      monitor.registerProbe("cache", () =>
        Effect.succeed({
          latencyMs: 250,
          message: "High latency",
          status: "degraded" as const,
        })
      );
      const degradedReport = await Effect.runPromise(monitor.evaluateHealth());
      expect(degradedReport.overall).toBe("degraded");

      // Unhealthy probe triggers critical
      monitor.registerProbe("auth_idp", () =>
        Effect.succeed({
          message: "IdP unreachable",
          status: "unhealthy" as const,
        })
      );
      const criticalReport = await Effect.runPromise(monitor.evaluateHealth());
      expect(criticalReport.overall).toBe("critical");
    });
  });

  describe("4C Decision Readiness (readiness.ts)", () => {
    it("detects temporal inconsistencies where validFrom > validTo", () => {
      const ObjectType = defineObjectType({
        description: "Asset",
        id: "Asset",
        name: "Asset",
        primaryKey: "id",
        properties: {
          id: defineProperty({ description: "ID", schema: Schema.String }),
        },
        typology: "master",
      });

      const badInstance: ObjectInstance = {
        id: "AST-ERR",
        lastModifiedAt: 1000,
        properties: { id: "AST-ERR" },
        typeId: ObjectType.id,
        validFrom: 2000, // Paradox: from > to
        validTo: 1000,
        version: 1,
      };

      const readiness = evaluateDecisionReadiness(badInstance, ObjectType);
      expect(readiness.isReady).toBe(false);
      expect(readiness.consistent.passed).toBe(false);
      expect(readiness.consistent.contradictions[0]).toContain(
        "validFrom (2000) cannot be after validTo (1000)"
      );
    });
  });

  describe("Governance Approvals (approvals.ts)", () => {
    it("prevents merging proposals with active rejections or insufficient approvals", () => {
      const approver = new ApprovalsEngine({
        requireComplianceReview: false,
        requiredMinApprovals: 2,
        requireDomainSpecialist: true,
      });

      const baseProposal: OntologyProposal = {
        author: { id: "u1", name: "User 1", roles: [], type: "user" },
        changeSet: {
          addedActionTypes: [],
          addedLinkTypes: [],
          addedObjectTypes: [],
          deletedActionTypeIds: [],
          deletedLinkTypeIds: [],
          deletedObjectTypeIds: [],
          modifiedActionTypes: [],
          modifiedLinkTypes: [],
          modifiedObjectTypes: [],
        },
        createdAt: Date.now(),
        description: "Test proposal",
        id: "prop-1",
        reviews: [],
        sourceBranch: "feature",
        status: "open",
        targetBranch: "main",
        title: "Test",
        updatedAt: Date.now(),
      };

      // 1. Rejected proposal blocks merge
      const reviewRejected = approver.evaluateProposal({
        ...baseProposal,
        reviews: [
          {
            notes: "Security flaw in schema",
            reviewedAt: Date.now(),
            reviewer: {
              id: "sec-1",
              name: "Security Officer",
              roles: ["admin"],
              type: "user",
            },
            verdict: "reject",
          },
          {
            notes: "Looks fine to me",
            reviewedAt: Date.now(),
            reviewer: {
              id: "eng-1",
              name: "Engineer",
              roles: ["lead_engineer"],
              type: "user",
            },
            verdict: "approve",
          },
        ],
      });

      expect(reviewRejected.canMerge).toBe(false);
      expect(reviewRejected.reasons[0]).toContain("active rejection(s)");

      // 2. Insufficient approvals blocks merge
      const insufficient = approver.evaluateProposal({
        ...baseProposal,
        reviews: [
          {
            notes: "Approved",
            reviewedAt: Date.now(),
            reviewer: {
              id: "eng-1",
              name: "Engineer",
              roles: ["lead_engineer"],
              type: "user",
            },
            verdict: "approve",
          },
        ],
      });
      expect(insufficient.canMerge).toBe(false);
      expect(insufficient.reasons[0]).toContain(
        "Requires at least 2 approval(s)"
      );
    });
  });

  describe("Runtime Verification Boundaries (verification.ts)", () => {
    it("halts writes that violate registered min and max property bounds", async () => {
      const verifier = new VEDOVerifier();
      const typeId = "BoilerPressure" as ObjectTypeId;

      verifier.registerSuite({
        boundaries: [{ max: 100, min: 10, property: "pressurePsi" }],
        objectTypeId: typeId,
      });

      // Below min bound
      const belowRes = await Effect.runPromise(
        verifier.verifyMutation(typeId, { pressurePsi: 5 }).pipe(Effect.result)
      );
      expect(belowRes._tag).toBe("Failure");

      // Above max bound
      const aboveRes = await Effect.runPromise(
        verifier
          .verifyMutation(typeId, { pressurePsi: 150 })
          .pipe(Effect.result)
      );
      expect(aboveRes._tag).toBe("Failure");

      // Within bound succeeds
      const okRes = await Effect.runPromise(
        verifier.verifyMutation(typeId, { pressurePsi: 50 }).pipe(Effect.result)
      );
      expect(okRes._tag).toBe("Success");
    });
  });

  describe("SQL Store Links & Bitemporal (sql-store.ts)", () => {
    it("persists and queries links and historical snapshots in SQLite", async () => {
      const driver = new EmbeddedSqlDriver();
      const store = new SqlBitemporalStore(driver, "sqlite");

      const linkType = "PatientToRoom" as LinkTypeId;
      await Effect.runPromise(
        store.linkObjects({
          createdAt: 1000,
          linkTypeId: linkType,
          metadata: { assignedBed: "A-1" },
          sourceId: "PAT-10",
          targetId: "ROOM-101",
        })
      );

      const links = await Effect.runPromise(store.getLinks(linkType, "PAT-10"));
      expect(links.length).toBe(1);
      expect(links[0].targetId).toBe("ROOM-101");
      expect(links[0].metadata?.assignedBed).toBe("A-1");
    });
  });

  describe("OMS Proposals (oms.ts)", () => {
    it("returns ProposalNotFoundError for missing proposals and lists all created proposals", async () => {
      const oms = new OntologyMetadataService();

      const notFoundRes = await Effect.runPromise(
        oms.getProposal("non-existent").pipe(Effect.result)
      );
      expect(notFoundRes._tag).toBe("Failure");
      if (notFoundRes._tag === "Failure") {
        expect(notFoundRes.failure).toBeInstanceOf(ProposalNotFoundError);
      }

      await Effect.runPromise(
        oms.createBranch("feature-telemetry", {
          id: "eng-1",
          name: "Dev",
          roles: ["developer"],
          type: "user",
        })
      );

      const proposal = await Effect.runPromise(
        oms.createProposal({
          author: {
            id: "eng-1",
            name: "Dev",
            roles: ["developer"],
            type: "user",
          },
          changeSet: {
            addedActionTypes: [],
            addedLinkTypes: [],
            addedObjectTypes: [],
            deletedActionTypeIds: [],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: [],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: "Add telemetry sensor types",
          sourceBranch: "feature-telemetry",
          title: "Telemetry sensors",
        })
      );

      const listed = await Effect.runPromise(oms.listProposals());
      expect(listed.some((p) => p.id === proposal.id)).toBe(true);
    });
  });

  describe("ObjectSet Aggregations & Reverse Traversals (oss.ts)", () => {
    it("computes min, max, avg, sum aggregates and traverses reverse links", async () => {
      const bStore = new BitemporalObjectStore();
      const oss = new ObjectSetService(bStore);
      const typeId = "Turbine" as ObjectTypeId;

      await Effect.runPromise(
        Effect.all(
          [
            bStore.putObject({
              id: "T1",
              lastModifiedAt: 1000,
              properties: { rpm: 1000 },
              typeId,
              version: 1,
            }),
            bStore.putObject({
              id: "T2",
              lastModifiedAt: 1000,
              properties: { rpm: 2000 },
              typeId,
              version: 1,
            }),
            bStore.putObject({
              id: "T3",
              lastModifiedAt: 1000,
              properties: { rpm: 3000 },
              typeId,
              version: 1,
            }),
          ],
          { concurrency: 3 }
        )
      );

      const turbineSet = oss.getSet(typeId);

      const minRes = await Effect.runPromise(
        turbineSet.aggregate({ metric: "min", propertyName: "rpm" })
      );
      expect(minRes.value).toBe(1000);

      const maxRes = await Effect.runPromise(
        turbineSet.aggregate({ metric: "max", propertyName: "rpm" })
      );
      expect(maxRes.value).toBe(3000);

      const sumRes = await Effect.runPromise(
        turbineSet.aggregate({ metric: "sum", propertyName: "rpm" })
      );
      expect(sumRes.value).toBe(6000);

      const avgRes = await Effect.runPromise(
        turbineSet.aggregate({ metric: "avg", propertyName: "rpm" })
      );
      expect(avgRes.value).toBe(2000);

      const countRes = await Effect.runPromise(
        turbineSet.aggregate({ metric: "count", propertyName: "rpm" })
      );
      expect(countRes.value).toBe(3);

      // Reverse traversal across links
      const windFarmType = "WindFarm" as ObjectTypeId;
      await Effect.runPromise(
        bStore.putObject({
          id: "WF-1",
          lastModifiedAt: 1000,
          properties: { name: "North Sea" },
          typeId: windFarmType,
          version: 1,
        })
      );

      const farmToTurbineLink = "FarmToTurbine" as LinkTypeId;
      await Effect.runPromise(
        bStore.linkObjects({
          createdAt: 1000,
          linkTypeId: farmToTurbineLink,
          sourceId: "WF-1",
          targetId: "T1",
        })
      );

      // Starting from T1, traverse reverse link to find parent WindFarm
      const t1Set = oss.getSet(typeId).filter((t) => t.id === "T1");
      const parentFarmSet = t1Set.traverseLink(
        farmToTurbineLink,
        windFarmType,
        "reverse"
      );
      const parentFarms = await Effect.runPromise(parentFarmSet.all());

      expect(parentFarms.length).toBe(1);
      expect(parentFarms[0].id).toBe("WF-1");
      expect(parentFarms[0].properties.name).toBe("North Sea");
    });
  });

  describe("ActionInbox Full Approval Cycle (inbox.ts)", () => {
    it("routes high-risk action to inbox proposal, then executes successfully upon human approval", async () => {
      const store = new InMemoryObjectStore();
      const audit = new InMemoryAuditStore();
      const inbox = new ActionInbox(audit, store);

      const HighRiskAction = defineActionType({
        defaultExecutionMode: "proposed",
        description: "Emergency override action",
        id: "emergency_override",
        name: "Emergency Override",
        parametersSchema: Schema.Struct({
          notes: Schema.String,
          targetId: Schema.String,
        }),
        riskTier: "critical",
        submissionCriteria: [
          {
            description: "Enforce human authorization",
            evaluate: () =>
              Effect.succeed({
                passed: false,
                reason: "Requires physician authorization",
                verdict: "route_to_inbox" as const,
              }),
            id: "human_gate",
          },
        ],
      });

      const submission: ActionSubmission = {
        actionType: HighRiskAction,
        rawParameters: { notes: "Urgent intervention", targetId: "PAT-12" },
        security: {
          correlationId: "corr-inbox-1",
          subject: {
            id: "agent-ai",
            name: "Autonomous Agent",
            roles: ["agent"],
            type: "agent",
          },
          timestamp: Date.now(),
        },
      };

      const pipeRes = await Effect.runPromise(
        executeWritePipeline(submission, store, audit)
      );
      expect(pipeRes.status).toBe("proposed");
      if (pipeRes.status !== "proposed") {
        return;
      }

      const propItem = inbox.addProposal(submission, pipeRes.decisionRecord);

      const pending = inbox.getPendingProposals();
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(propItem.id);

      const humanDoc: Subject = {
        id: "dr-smith",
        name: "Dr. Smith",
        roles: ["physician"],
        type: "user",
      };

      const approvedDecision = await Effect.runPromise(
        inbox.approveProposal(propItem.id, humanDoc)
      );

      expect(approvedDecision.outcome).toBe("executed");
      expect(approvedDecision.actionTypeId).toBe("emergency_override");
      expect(inbox.getPendingProposals().length).toBe(0);

      const missingApproval = await Effect.runPromise(
        inbox.approveProposal("non-existent-prop", humanDoc).pipe(Effect.result)
      );
      expect(missingApproval._tag).toBe("Failure");
      if (missingApproval._tag === "Failure") {
        expect(missingApproval.failure).toBeInstanceOf(ProposalNotFoundError);
      }

      const missingReject = await Effect.runPromise(
        inbox
          .rejectProposal(
            "non-existent-prop",
            humanDoc,
            "clinical_discretion",
            "Veto"
          )
          .pipe(Effect.result)
      );
      expect(missingReject._tag).toBe("Failure");
      if (missingReject._tag === "Failure") {
        expect(missingReject.failure).toBeInstanceOf(ProposalNotFoundError);
      }
    });
  });

  describe("OMS Branching, Schema & Proposal Lifecycle (oms.ts)", () => {
    it("manages branches, action types, schema inspection, reviews, and merges with compliance enforcement", async () => {
      const oms = new OntologyMetadataService();
      const dev: Subject = {
        id: "dev-1",
        name: "Developer",
        roles: ["engineer"],
        type: "user",
      };
      const complianceOfficer: Subject = {
        id: "comp-1",
        name: "Compliance Officer",
        roles: ["compliance_officer"],
        type: "user",
      };

      await Effect.runPromise(oms.createBranch("staging", dev, "main"));

      const SampleAction = defineActionType({
        description: "Test Action",
        id: "test_action",
        name: "Test Action",
        parametersSchema: Schema.Struct({ val: Schema.String }),
      });

      await Effect.runPromise(oms.registerActionType("staging", SampleAction));

      const stagingSchema = await Effect.runPromise(oms.getSchema("staging"));
      expect(stagingSchema.actionTypes.has("test_action")).toBe(true);

      const missingBranchRes = await Effect.runPromise(
        oms.getSchema("unknown-branch").pipe(Effect.result)
      );
      expect(missingBranchRes._tag).toBe("Failure");
      if (missingBranchRes._tag === "Failure") {
        expect(missingBranchRes.failure).toBeInstanceOf(BranchNotFoundError);
      }

      const invalidPropRes = await Effect.runPromise(
        oms
          .createProposal({
            author: dev,
            changeSet: {
              addedActionTypes: [],
              addedLinkTypes: [],
              addedObjectTypes: [],
              deletedActionTypeIds: [],
              deletedLinkTypeIds: [],
              deletedObjectTypeIds: [],
              modifiedActionTypes: [],
              modifiedLinkTypes: [],
              modifiedObjectTypes: [],
            },
            description: "Invalid branch proposal",
            sourceBranch: "nonexistent-source",
            title: "Invalid",
          })
          .pipe(Effect.result)
      );
      expect(invalidPropRes._tag).toBe("Failure");
      if (invalidPropRes._tag === "Failure") {
        expect(invalidPropRes.failure).toBeInstanceOf(BranchNotFoundError);
      }

      const newObjectType = defineObjectType({
        description: "Sensor",
        id: "Sensor",
        name: "Sensor",
        primaryKey: "id",
        properties: {
          id: defineProperty({ description: "ID", schema: Schema.String }),
        },
      });

      const proposal = await Effect.runPromise(
        oms.createProposal({
          author: dev,
          changeSet: {
            addedActionTypes: [SampleAction],
            addedLinkTypes: [],
            addedObjectTypes: [newObjectType],
            deletedActionTypeIds: [],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: [],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: "Promote sensor to main",
          sourceBranch: "staging",
          targetBranch: "main",
          title: "Promote Sensor",
        })
      );

      const rejectedProp = await Effect.runPromise(
        oms.reviewProposal(proposal.id, {
          comments: "Need security audit",
          reviewedAt: Date.now(),
          reviewer: { ...dev, id: "reviewer-audit" },
          verdict: "reject",
        })
      );
      expect(rejectedProp.status).toBe("rejected");

      const proposal2 = await Effect.runPromise(
        oms.createProposal({
          author: dev,
          changeSet: {
            addedActionTypes: [SampleAction],
            addedLinkTypes: [],
            addedObjectTypes: [newObjectType],
            deletedActionTypeIds: [],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: [],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: "Promote sensor to main (v2)",
          sourceBranch: "staging",
          targetBranch: "main",
          title: "Promote Sensor v2",
        })
      );

      const reviewedProp = await Effect.runPromise(
        oms.reviewProposal(proposal2.id, {
          notes: "Approved after compliance audit",
          reviewedAt: Date.now(),
          reviewer: complianceOfficer,
          verdict: "approve",
        })
      );
      expect(reviewedProp.status).toBe("under_review");

      const policyFailRes = await Effect.runPromise(
        oms
          .mergeProposal(proposal2.id, dev, {
            requireComplianceReview: true,
            requireDomainSpecialistReview: false,
            requiredMinApprovals: 5,
          })
          .pipe(Effect.result)
      );
      expect(policyFailRes._tag).toBe("Failure");
      if (policyFailRes._tag === "Failure") {
        expect(policyFailRes.failure).toBeInstanceOf(
          ApprovalsPolicyViolationError
        );
      }

      const mergedProp = await Effect.runPromise(
        oms.mergeProposal(proposal2.id, dev, {
          requireComplianceReview: true,
          requireDomainSpecialistReview: false,
          requiredMinApprovals: 1,
        })
      );
      expect(mergedProp.status).toBe("merged");

      const mainSchema = await Effect.runPromise(oms.getSchema("main"));
      expect(mainSchema.objectTypes.has("Sensor")).toBe(true);
      expect(mainSchema.actionTypes.has("test_action")).toBe(true);

      const deleteProposal = await Effect.runPromise(
        oms.createProposal({
          author: dev,
          changeSet: {
            addedActionTypes: [],
            addedLinkTypes: [],
            addedObjectTypes: [],
            deletedActionTypeIds: ["test_action"],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: ["Sensor"],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: "Deprecate Sensor and test_action",
          sourceBranch: "staging",
          targetBranch: "main",
          title: "Deprecate",
        })
      );

      await Effect.runPromise(
        oms.reviewProposal(deleteProposal.id, {
          comments: "Approved deletion",
          reviewedAt: Date.now(),
          reviewer: { ...dev, id: "reviewer-audit" },
          verdict: "approve",
        })
      );

      await Effect.runPromise(
        oms.mergeProposal(deleteProposal.id, dev, {
          requireComplianceReview: false,
          requireDomainSpecialistReview: false,
          requiredMinApprovals: 1,
        })
      );

      const mainSchemaAfterDel = await Effect.runPromise(oms.getSchema("main"));
      expect(mainSchemaAfterDel.objectTypes.has("Sensor")).toBe(false);
      expect(mainSchemaAfterDel.actionTypes.has("test_action")).toBe(false);
    });
  });

  describe("ObjectStore Invariants & Predicates (object-store.ts)", () => {
    it("handles findObjects with and without predicates, object deletion, and concurrency errors", async () => {
      const store = new InMemoryObjectStore();
      const typeId = "Telemetry" as ObjectTypeId;

      await Effect.runPromise(
        store.putObject({
          id: "T-1",
          lastModifiedAt: 1000,
          properties: { status: "active", val: 10 },
          typeId,
          version: 1,
        })
      );

      await Effect.runPromise(
        store.putObject({
          id: "T-2",
          lastModifiedAt: 1000,
          properties: { status: "inactive", val: 20 },
          typeId,
          version: 1,
        })
      );

      const allObjs = await Effect.runPromise(store.findObjects(typeId));
      expect(allObjs.length).toBe(2);

      const activeObjs = await Effect.runPromise(
        store.findObjects(typeId, (obj) => obj.properties.status === "active")
      );
      expect(activeObjs.length).toBe(1);
      expect(activeObjs[0].id).toBe("T-1");

      await Effect.runPromise(store.deleteObject(typeId, "T-1"));
      const remaining = await Effect.runPromise(store.findObjects(typeId));
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe("T-2");

      const linkType = "TelemetryToDevice" as LinkTypeId;
      await Effect.runPromise(
        store.linkObjects({
          createdAt: 1000,
          linkTypeId: linkType,
          sourceId: "T-2",
          targetId: "DEV-1",
        })
      );
      await Effect.runPromise(
        store.linkObjects({
          createdAt: 1000,
          linkTypeId: linkType,
          sourceId: "T-2",
          targetId: "DEV-1",
        })
      );
      const links = await Effect.runPromise(store.getLinks(linkType, "T-2"));
      expect(links.length).toBe(1);

      const revLinks = await Effect.runPromise(
        store.getReverseLinks(linkType, "DEV-1")
      );
      expect(revLinks.length).toBe(1);
      expect(revLinks[0].sourceId).toBe("T-2");

      const concRes = await Effect.runPromise(
        store
          .putObject({
            id: "T-2",
            lastModifiedAt: 2000,
            properties: { status: "active", val: 30 },
            typeId,
            version: 5,
          })
          .pipe(Effect.result)
      );
      expect(concRes._tag).toBe("Failure");
      if (concRes._tag === "Failure") {
        expect(concRes.failure).toBeInstanceOf(ConcurrentModificationError);
      }
    });
  });

  describe("Bitemporal Store Transaction Time & Concurrency (bitemporal-store.ts)", () => {
    it("queries asOfTransactionTime and enforces optimistic concurrency version matching", async () => {
      const bStore = new BitemporalObjectStore();
      const typeId = "Account" as ObjectTypeId;

      const v1 = await Effect.runPromise(
        bStore.putObject({
          id: "ACC-55",
          lastModifiedAt: 1000,
          properties: { balance: 500 },
          typeId,
          version: 1,
        })
      );
      expect(v1.version).toBe(1);

      const hist = await Effect.runPromise(
        bStore.asOfTransactionTime(typeId, "ACC-55", Date.now())
      );
      expect(hist).toBeDefined();
      expect(hist?.properties.balance).toBe(500);

      const missing = await Effect.runPromise(
        bStore.asOfTransactionTime(typeId, "NONEXISTENT", Date.now())
      );
      expect(missing).toBeUndefined();

      const concRes = await Effect.runPromise(
        bStore
          .putObject({
            id: "ACC-55",
            lastModifiedAt: 2000,
            properties: { balance: 600 },
            typeId,
            version: 99,
          })
          .pipe(Effect.result)
      );
      expect(concRes._tag).toBe("Failure");
      if (concRes._tag === "Failure") {
        expect(concRes.failure).toBeInstanceOf(ConcurrentModificationError);
      }

      const found = await Effect.runPromise(
        bStore.findObjects(typeId, (obj) => obj.properties.balance === 500)
      );
      expect(found.length).toBe(1);
      expect(found[0].id).toBe("ACC-55");
    });
  });

  describe("VEDO State Transitions & CROV Engine (verification.ts)", () => {
    it("enforces valid state transition graphs and verifies proposal structural readiness", async () => {
      const verifier = new VEDOVerifier();
      const typeId = "Document" as ObjectTypeId;

      verifier.registerSuite({
        objectTypeId: typeId,
        transitions: [
          {
            allowedTransitions: {
              draft: ["review"],
              review: ["approved", "rejected"],
            },
            property: "state",
          },
        ],
      });

      const okRes = await Effect.runPromise(
        verifier
          .verifyMutation(typeId, { state: "review" }, { state: "draft" })
          .pipe(Effect.result)
      );
      expect(okRes._tag).toBe("Success");

      const badRes = await Effect.runPromise(
        verifier
          .verifyMutation(typeId, { state: "approved" }, { state: "draft" })
          .pipe(Effect.result)
      );
      expect(badRes._tag).toBe("Failure");
      if (badRes._tag === "Failure") {
        expect(badRes.failure).toBeInstanceOf(StructuralVerificationError);
        expect(
          (badRes.failure as StructuralVerificationError).issues[0]
        ).toContain("Illegal state transition");
      }

      const crov = new CROVEngine();
      const docType = defineObjectType({
        description: "Doc",
        id: "Document",
        name: "Document",
        primaryKey: "id",
        properties: {
          id: defineProperty({ description: "ID", schema: Schema.String }),
        },
      });

      const badProposal: OntologyProposal = {
        author: { id: "u1", name: "User", roles: [], type: "user" },
        changeSet: {
          addedActionTypes: [],
          addedLinkTypes: [
            defineLinkType({
              cardinality: "one-to-many",
              description: "Link pointing to missing type",
              id: "BadLink",
              sourceToTargetName: "target",
              sourceTypeId: "Document",
              targetToSourceName: "source",
              targetTypeId: "NonExistentType",
            }),
          ],
          addedObjectTypes: [],
          deletedActionTypeIds: [],
          deletedLinkTypeIds: [],
          deletedObjectTypeIds: [],
          modifiedActionTypes: [],
          modifiedLinkTypes: [],
          modifiedObjectTypes: [],
        },
        createdAt: Date.now(),
        description: "Broken proposal",
        id: "prop-bad",
        reviews: [],
        sourceBranch: "feature",
        status: "open",
        targetBranch: "main",
        title: "Broken",
        updatedAt: Date.now(),
      };

      const crovRes = await Effect.runPromise(
        crov.verifyProposal(badProposal, [docType], []).pipe(Effect.result)
      );
      expect(crovRes._tag).toBe("Failure");
      if (crovRes._tag === "Failure") {
        expect(crovRes.failure).toBeInstanceOf(StructuralVerificationError);
      }
    });
  });

  describe("OSS GroupBy & Forward Traversal (oss.ts)", () => {
    it("computes groupByProperty metrics, handles empty numeric aggregates, and traverses forward links", async () => {
      const bStore = new BitemporalObjectStore();
      const oss = new ObjectSetService(bStore);
      const plantType = "Plant" as ObjectTypeId;
      const deviceType = "Device" as ObjectTypeId;
      const plantToDeviceLink = "PlantToDevice" as LinkTypeId;

      await Effect.runPromise(
        Effect.all(
          [
            bStore.putObject({
              id: "P1",
              lastModifiedAt: 1000,
              properties: { region: "APAC" },
              typeId: plantType,
              version: 1,
            }),
            bStore.putObject({
              id: "P2",
              lastModifiedAt: 1000,
              properties: { region: "APAC" },
              typeId: plantType,
              version: 1,
            }),
            bStore.putObject({
              id: "P3",
              lastModifiedAt: 1000,
              properties: { region: "EMEA" },
              typeId: plantType,
              version: 1,
            }),
            bStore.putObject({
              id: "D1",
              lastModifiedAt: 1000,
              properties: { model: "Sens-A" },
              typeId: deviceType,
              version: 1,
            }),
          ],
          { concurrency: 2 }
        )
      );

      await Effect.runPromise(
        bStore.linkObjects({
          createdAt: 1000,
          linkTypeId: plantToDeviceLink,
          sourceId: "P1",
          targetId: "D1",
        })
      );

      const plantSet = oss.getSet(plantType);

      const groupRes = await Effect.runPromise(
        plantSet.aggregate({ groupByProperty: "region", metric: "count" })
      );
      expect(groupRes.value).toBe(3);
      expect(groupRes.groups?.["APAC"]).toBe(2);
      expect(groupRes.groups?.["EMEA"]).toBe(1);

      const emptySum = await Effect.runPromise(
        plantSet.aggregate({ metric: "sum", propertyName: "nonExistentProp" })
      );
      expect(emptySum.value).toBe(0);

      const p1Set = plantSet.filter((p) => p.id === "P1");
      const traversed = p1Set.traverseLink(
        plantToDeviceLink,
        deviceType,
        "forward"
      );
      const devices = await Effect.runPromise(traversed.all());
      expect(devices.length).toBe(1);
      expect(devices[0].id).toBe("D1");
      expect(devices[0].properties.model).toBe("Sens-A");

      const apacSet = plantSet.filter((p) => p.properties.region === "APAC");
      const emeaSet = plantSet.filter((p) => p.properties.region === "EMEA");

      const unionSet = apacSet.union(emeaSet);
      const unionItems = await Effect.runPromise(unionSet.all());
      expect(unionItems.length).toBe(3);

      const intersectSet = plantSet.intersect(apacSet);
      const intersectItems = await Effect.runPromise(intersectSet.all());
      expect(intersectItems.length).toBe(2);

      const diffSet = plantSet.difference(apacSet);
      const diffItems = await Effect.runPromise(diffSet.all());
      expect(diffItems.length).toBe(1);
      expect(diffItems[0].id).toBe("P3");

      const sortedDesc = plantSet.sortBy("region", "desc");
      const sortedItems = await Effect.runPromise(sortedDesc.all());
      expect(sortedItems[0].properties.region).toBe("EMEA");

      const top1 = plantSet.take(1);
      const top1Items = await Effect.runPromise(top1.all());
      expect(top1Items.length).toBe(1);
    });
  });

  describe("Resilience Degraded Modes (resilience.ts)", () => {
    it("rejects non-critical or non-veto actions when system is degraded", async () => {
      const mgr = new DegradeModeManager();

      await Effect.runPromise(mgr.setMode("critical_only"));

      const nonCritRes = await Effect.runPromise(
        mgr
          .assertActionPermitted({ isCritical: false, isVetoOrOverride: false })
          .pipe(Effect.result)
      );
      expect(nonCritRes._tag).toBe("Failure");
      if (nonCritRes._tag === "Failure") {
        expect(nonCritRes.failure).toBeInstanceOf(DegradedModeViolationError);
      }

      const critRes = await Effect.runPromise(
        mgr
          .assertActionPermitted({ isCritical: true, isVetoOrOverride: false })
          .pipe(Effect.result)
      );
      expect(critRes._tag).toBe("Success");

      await Effect.runPromise(mgr.setMode("veto_only"));

      const blockedAction = await Effect.runPromise(
        mgr
          .assertActionPermitted({ isCritical: true, isVetoOrOverride: false })
          .pipe(Effect.result)
      );
      expect(blockedAction._tag).toBe("Failure");
      if (blockedAction._tag === "Failure") {
        expect(blockedAction.failure).toBeInstanceOf(
          DegradedModeViolationError
        );
      }

      const allowedVeto = await Effect.runPromise(
        mgr
          .assertActionPermitted({ isCritical: false, isVetoOrOverride: true })
          .pipe(Effect.result)
      );
      expect(allowedVeto._tag).toBe("Success");

      await Effect.runPromise(mgr.setMode("read_only"));
      const roRes = await Effect.runPromise(
        mgr
          .assertActionPermitted({ isCritical: true, isVetoOrOverride: true })
          .pipe(Effect.result)
      );
      expect(roRes._tag).toBe("Failure");
      if (roRes._tag === "Failure") {
        expect(roRes.failure).toBeInstanceOf(DegradedModeViolationError);
        expect(roRes.failure.message).toContain("read_only");
      }
    });
  });

  describe("Audit Store Filtering & Overrides (audit.ts)", () => {
    it("filters decision records by actionTypeId and limit, and manages overrides", async () => {
      const audit = new InMemoryAuditStore();

      await Effect.runPromise(
        audit.appendDecision({
          actionTypeId: "action_alpha",
          correlationId: "c1",
          id: "dec-1",
          outcome: "executed",
          parameters: {},
          ruleVersion: "1.0",
          stateSnapshot: { postState: [], preState: [] },
          subject: { id: "u1", name: "User", roles: [], type: "user" },
          timestamp: 1000,
        })
      );

      await Effect.runPromise(
        audit.appendDecision({
          actionTypeId: "action_beta",
          correlationId: "c2",
          id: "dec-2",
          outcome: "executed",
          parameters: {},
          ruleVersion: "1.0",
          stateSnapshot: { postState: [], preState: [] },
          subject: { id: "u1", name: "User", roles: [], type: "user" },
          timestamp: 2000,
        })
      );

      const alphaDecisions = await Effect.runPromise(
        audit.listDecisions({
          actionTypeId: "action_alpha",
        })
      );
      expect(alphaDecisions.length).toBe(1);
      expect(alphaDecisions[0].id).toBe("dec-1");

      const limited = await Effect.runPromise(
        audit.listDecisions({ limit: 1 })
      );
      expect(limited.length).toBe(1);
      expect(limited[0].id).toBe("dec-2");

      const missing = await Effect.runPromise(
        audit.getDecision("non-existent-id")
      );
      expect(Option.isNone(missing)).toBe(true);

      await Effect.runPromise(
        audit.appendOverride({
          decisionRecordId: "dec-1",
          finalDecision: { action: "override", status: "rejected" },
          humanSubject: {
            id: "doc-1",
            name: "Doc",
            roles: ["physician"],
            type: "user",
          },
          id: "ovr-1",
          originalProposal: {},
          reasonCategory: "clinical_discretion",
          structuredReason: "Patient vitals shifted",
          timestamp: 3000,
        })
      );

      const overrides = await Effect.runPromise(audit.listOverrides());
      expect(overrides.length).toBe(1);
      expect(overrides[0].id).toBe("ovr-1");
      expect(overrides[0].reasonCategory).toBe("clinical_discretion");
    });
  });

  describe("Funnel Ingestion Edge Cases & CDC Errors (funnel.ts & connectors.ts)", () => {
    it("skips records with missing primary key, applies property transformations, and tracks connector errors", async () => {
      const store = new InMemoryObjectStore();
      const funnel = new FunnelService(store);
      const cdc = new KafkaCdcConnector(funnel);

      await Effect.runPromise(
        funnel.registerPipeline({
          conflictPolicy: "source_wins",
          id: "pipe-custom",
          mode: "batch",
          name: "Custom Pipeline",
          primaryKeyField: "sku",
          propertyMappings: [
            {
              sourceField: "rawCost",
              targetPropertyName: "cost",
              transform: (val) => Math.round(Number(val) * 1.1),
            },
          ],
          sourceDatasetId: "erp",
          targetObjectTypeId: "Product",
        })
      );

      const result = await Effect.runPromise(
        funnel.ingestBatch("pipe-custom", [
          { rawCost: 100, sku: "SKU-1" },
          { rawCost: 200 },
        ])
      );

      expect(result.createdCount).toBe(1);
      expect(result.skippedCount).toBe(1);

      const prod = await Effect.runPromise(
        store.getObject("Product" as ObjectTypeId, "SKU-1")
      );
      expect(prod?.properties.cost).toBe(110);

      cdc.registerTableMapping("invalid_table", {
        pipelineId: "nonexistent_pipeline",
        primaryKeyField: "sku",
        targetTypeId: "Product" as ObjectTypeId,
      });

      const cdcRes = await Effect.runPromise(
        cdc
          .consumeMessage({
            payload: {
              after: { sku: "SKU-9" },
              before: null,
              op: "c",
              source: { lsn: 50, table: "invalid_table", ts_ms: 1000 },
            },
          })
          .pipe(Effect.result)
      );
      expect(cdcRes._tag).toBe("Failure");
      expect(cdc.getStats().errorsCount).toBe(1);

      const batchConnector = new WarehouseBatchConnector(funnel);
      const batchReport = await Effect.runPromise(
        batchConnector.ingestBatch([{ sku: "SKU-1" }], {
          chunkSize: 1,
          pipelineId: "nonexistent-pipeline",
          sourceSystem: "snowflake",
          targetTypeId: "Product" as ObjectTypeId,
        })
      );
      expect(batchReport.errors.length).toBe(1);
      expect(batchReport.errors[0]).toContain("PipelineNotFoundError");
    });
  });

  describe("Strangler Dual-Run Cutover Gate (migration.ts)", () => {
    it("creates soft delete tombstones on delete events and certifies cutover readiness when dual-run meets consistency gate", async () => {
      const bStore = new BitemporalObjectStore();
      const coord = new MigrationEngine(bStore);

      await Effect.runPromise(
        coord.ingestCdcEvent(
          {
            afterState: null,
            beforeState: { balance: 500, id: "ACC-99" },
            capturedAt: 1000,
            id: "evt-del-1",
            operation: "delete",
            sequenceNumber: 1,
            sourceSystem: "legacy_core",
          },
          "Account",
          (row) => ({
            id: String(row.id),
            properties: { balance: row.balance },
          })
        )
      );

      const deletedObj = await Effect.runPromise(
        bStore.getObject("Account" as ObjectTypeId, "ACC-99")
      );
      expect(deletedObj?.properties._deleted).toBe(true);

      await Effect.runPromise(coord.setStage("dual_run"));
      await Effect.runPromise(
        Effect.all(
          [1, 2, 3, 4, 5].map((i) =>
            bStore.putObject({
              id: `ACC-${i}`,
              lastModifiedAt: 1000,
              properties: { balance: 100 * i },
              typeId: "Account" as ObjectTypeId,
              version: 1,
            })
          ),
          { concurrency: 5 }
        )
      );

      await Effect.runPromise(
        Effect.all(
          [1, 2, 3, 4, 5].map((i) =>
            coord.compareShadowRecord("Account", `ACC-${i}`, {
              balance: 100 * i,
            })
          ),
          { concurrency: 5 }
        )
      );

      const metrics = coord.getCutoverMetrics();
      expect(metrics.totalShadowComparisons).toBe(5);
      expect(metrics.consistencyRate).toBe(1);
      expect(metrics.readyForCutover).toBe(true);
    });
  });

  describe("SQL Bitemporal Store Queries & Historical Timelines (sql-store.ts)", () => {
    it("finds objects by predicate and queries historical states via asOfBitemporal in SQL", async () => {
      const driver = new EmbeddedSqlDriver();
      const store = new SqlBitemporalStore(driver, "sqlite");
      const typeId = "Vessel" as ObjectTypeId;

      await Effect.runPromise(
        store.putObject({
          id: "VES-1",
          lastModifiedAt: 1000,
          properties: { flag: "PANAMA", knots: 18 },
          typeId,
          validFrom: 1000,
          version: 1,
        })
      );

      const vessels = await Effect.runPromise(
        store.findObjects(typeId, (v) => (v.properties.knots as number) > 15)
      );
      expect(vessels.length).toBe(1);
      expect(vessels[0].id).toBe("VES-1");
      expect(vessels[0].properties.flag).toBe("PANAMA");

      const now = Date.now();
      const historical = await Effect.runPromise(
        store.asOfBitemporal(typeId, "VES-1", 1000, now + 10000)
      );
      expect(historical).toBeDefined();
      expect(historical?.id).toBe("VES-1");

      const nonexistent = await Effect.runPromise(
        store.asOfBitemporal(typeId, "NONEXISTENT", 1000, now + 10000)
      );
      expect(nonexistent).toBeUndefined();
    });
  });

  describe("Cluster Distributed Locking (cluster.ts)", () => {
    it("fails lock renewal on expired leases and rejects stale fencing tokens", async () => {
      const dlm = new DistributedLockManager();
      const resource = "resource:valve-controller";

      const lock = await Effect.runPromise(
        dlm.acquire(resource, "worker-alpha", 10)
      );

      await Effect.runPromise(Effect.sleep(Duration.millis(25)));

      const renewRes = await Effect.runPromise(
        dlm.renew(lock, 1000).pipe(Effect.result)
      );
      expect(renewRes._tag).toBe("Failure");
      if (renewRes._tag === "Failure") {
        expect(renewRes.failure).toBeInstanceOf(LockAcquisitionError);
      }

      await Effect.runPromise(dlm.acquire(resource, "worker-beta", 1000));
      const staleTokenRes = await Effect.runPromise(
        dlm.validateFencingToken(resource, 0).pipe(Effect.result)
      );
      expect(staleTokenRes._tag).toBe("Failure");
      if (staleTokenRes._tag === "Failure") {
        expect(staleTokenRes.failure).toBeInstanceOf(StaleFencingTokenError);
      }
    });
  });

  describe("Security Views, Columnar Store & Readiness Validation Edge Cases", () => {
    it("passes through objects when no RV/MDO mappings are defined", () => {
      const secEngine = new DynamicSecurityEngine();
      const instance: ObjectInstance = {
        id: "INST-1",
        lastModifiedAt: 1000,
        properties: { secret: "123" },
        typeId: "UnregisteredType" as ObjectTypeId,
        version: 1,
      };
      const subject: Subject = {
        id: "u1",
        name: "User",
        roles: [],
        type: "user",
      };

      const filtered = secEngine.filterInstances([instance], subject);
      expect(filtered.length).toBe(1);

      const projected = secEngine.projectInstance(instance, subject);
      expect(projected.properties.secret).toBe("123");
    });

    it("tracks null counts in ColumnarBatchTable statistics", () => {
      const table = ColumnarBatchEncoder.encode(
        [
          { reading: 42, sensorId: "S-1" },
          { reading: null, sensorId: "S-2" },
        ],
        { reading: "int32", sensorId: "string" }
      );

      const col = table.getColumn("reading");
      expect(col?.stats.nullCount).toBe(1);
      expect(col?.stats.rowCount).toBe(2);
    });

    it("flags validation failure when property data type violates schema in decision readiness", () => {
      const MetricType = defineObjectType({
        description: "Metric",
        id: "Metric",
        name: "Metric",
        primaryKey: "id",
        properties: {
          id: defineProperty({ description: "ID", schema: Schema.String }),
          numericValue: defineProperty({
            description: "Value",
            schema: Schema.Number,
          }),
        },
      });

      const badTypeInstance: ObjectInstance = {
        id: "MET-1",
        lastModifiedAt: 1000,
        properties: { id: "MET-1", numericValue: "NOT_A_NUMBER" },
        typeId: MetricType.id,
        version: 1,
      };

      const readiness = evaluateDecisionReadiness(badTypeInstance, MetricType);
      expect(readiness.isReady).toBe(false);
      expect(readiness.correct.passed).toBe(false);
      expect(readiness.correct.violations[0]).toContain("validation failed");
    });
  });

  describe("Write Pipeline Freshness Budget & Concurrency Errors (write-pipeline.ts)", () => {
    it("fails write pipeline when freshness budget is exceeded", async () => {
      const store = new InMemoryObjectStore();
      const audit = new InMemoryAuditStore();
      const assetType = "TurbineAsset" as ObjectTypeId;

      const oldTime = Date.now() - 10000;
      await Effect.runPromise(
        store.putObject({
          id: "TURB-1",
          lastModifiedAt: oldTime,
          properties: { vibration: 5.2 },
          provenance: {
            ingestedAt: oldTime,
            recordedAt: oldTime,
            sourceSystem: "scada",
          },
          typeId: assetType,
          version: 1,
        })
      );

      const StaleSensitiveAction = defineActionType({
        defaultExecutionMode: "automated",
        description: "Action requiring sub-second freshness",
        id: "adjust_blade_pitch",
        name: "Adjust Blade Pitch",
        parametersSchema: Schema.Struct({ targetId: Schema.String }),
        requiredFreshnessProperties: [
          {
            maxStalenessMs: 1000,
            objectTypeId: assetType,
            propertyName: "vibration",
          },
        ],
      });

      const res = await Effect.runPromise(
        executeWritePipeline(
          {
            actionType: StaleSensitiveAction,
            rawParameters: { targetId: "TURB-1" },
            security: {
              correlationId: "corr-fresh-1",
              subject: {
                id: "admin",
                name: "Admin",
                roles: ["admin"],
                type: "user",
              },
              timestamp: Date.now(),
            },
          },
          store,
          audit
        ).pipe(Effect.result)
      );

      expect(res._tag).toBe("Failure");
      if (res._tag === "Failure") {
        expect(res.failure).toBeInstanceOf(FreshnessBudgetExceededError);
      }
    });

    it("rejects staged logic edits that encounter optimistic concurrency conflicts", async () => {
      const store = new InMemoryObjectStore();
      const audit = new InMemoryAuditStore();
      const typeId = "Account" as ObjectTypeId;

      await Effect.runPromise(
        store.putObject({
          id: "ACC-CONF",
          lastModifiedAt: 1000,
          properties: { balance: 100 },
          typeId,
          version: 2,
        })
      );

      const ConcurrentAction = defineActionType({
        defaultExecutionMode: "automated",
        description: "Action with staged edits",
        id: "transfer_funds",
        name: "Transfer Funds",
        parametersSchema: Schema.Struct({ amount: Schema.Number }),
      });

      const res = await Effect.runPromise(
        executeWritePipeline(
          {
            actionType: ConcurrentAction,
            rawParameters: { amount: 50 },
            security: {
              correlationId: "corr-conc-1",
              subject: {
                id: "admin",
                name: "Admin",
                roles: ["admin"],
                type: "user",
              },
              timestamp: Date.now(),
            },
            stagedLogic: () =>
              Effect.succeed([
                {
                  id: "ACC-CONF",
                  lastModifiedAt: 2000,
                  properties: { balance: 50 },
                  typeId,
                  version: 10,
                },
              ]),
          },
          store,
          audit
        ).pipe(Effect.result)
      );

      expect(res._tag).toBe("Failure");
      if (res._tag === "Failure") {
        expect(res.failure).toBeInstanceOf(SubmissionCriteriaFailedError);
        expect((res.failure as SubmissionCriteriaFailedError).criterionId).toBe(
          "optimistic_concurrency"
        );
      }
    });
  });

  describe("Auth RS256, Audiences & Claims Verification (auth.ts)", () => {
    it("verifies RS256 signed JWTs and enforces nbf and audience claims", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const pubPem = publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      const privPem = privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString();

      const verifier = new OidcTokenVerifier({
        expectedAudience: "api://operon",
        expectedIssuer: "https://auth.operon.io",
        secretOrPublicKey: pubPem,
      });

      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT" })
      ).toString("base64url");
      const nowSec = Math.floor(Date.now() / 1000);

      const payload = Buffer.from(
        JSON.stringify({
          aud: ["api://operon", "api://other"],
          exp: nowSec + 3600,
          iat: nowSec,
          iss: "https://auth.operon.io",
          nbf: nowSec - 10,
          sub: "user-rsa",
        })
      ).toString("base64url");

      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      const sig = signer.sign(privPem).toString("base64url");
      const validJwt = `${header}.${payload}.${sig}`;

      const validClaims = await Effect.runPromise(
        verifier.verifyToken(validJwt)
      );
      expect(validClaims.sub).toBe("user-rsa");

      const futurePayload = Buffer.from(
        JSON.stringify({
          aud: "api://operon",
          exp: nowSec + 3600,
          iss: "https://auth.operon.io",
          nbf: nowSec + 5000,
          sub: "future-user",
        })
      ).toString("base64url");

      const futureSigner = createSign("RSA-SHA256");
      futureSigner.update(`${header}.${futurePayload}`);
      const futureSig = futureSigner.sign(privPem).toString("base64url");
      const futureJwt = `${header}.${futurePayload}.${futureSig}`;

      const futureRes = await Effect.runPromise(
        verifier.verifyToken(futureJwt).pipe(Effect.result)
      );
      expect(futureRes._tag).toBe("Failure");
      if (futureRes._tag === "Failure") {
        expect(futureRes.failure).toBeInstanceOf(AuthenticationError);
        expect((futureRes.failure as AuthenticationError).reason).toContain(
          "Token not valid before"
        );
      }

      const tamperedJwt = `${header}.${payload}.${sig.slice(0, -4)}AAAA`;
      const tamperedRes = await Effect.runPromise(
        verifier.verifyToken(tamperedJwt).pipe(Effect.result)
      );
      expect(tamperedRes._tag).toBe("Failure");
      if (tamperedRes._tag === "Failure") {
        expect(tamperedRes.failure).toBeInstanceOf(AuthenticationError);
        expect((tamperedRes.failure as AuthenticationError).reason).toContain(
          "Invalid RS256 JWT signature"
        );
      }

      const unsuppHeader = Buffer.from(
        JSON.stringify({ alg: "NONE", typ: "JWT" })
      ).toString("base64url");
      const unsuppJwt = `${unsuppHeader}.${payload}.fakesig`;
      const unsuppRes = await Effect.runPromise(
        verifier.verifyToken(unsuppJwt).pipe(Effect.result)
      );
      expect(unsuppRes._tag).toBe("Failure");
      if (unsuppRes._tag === "Failure") {
        expect(unsuppRes.failure).toBeInstanceOf(AuthenticationError);
        expect((unsuppRes.failure as AuthenticationError).reason).toContain(
          "Unsupported JWT algorithm"
        );
      }
    });
  });

  describe("Approvals Engine Status Transition (approvals.ts)", () => {
    it("sets proposal status to rejected when reviewer rejects", async () => {
      const approver = new ApprovalsEngine({
        requireComplianceReview: false,
        requiredMinApprovals: 1,
        requireDomainSpecialist: false,
      });

      const baseProposal: OntologyProposal = {
        author: { id: "u1", name: "User", roles: [], type: "user" },
        changeSet: {
          addedActionTypes: [],
          addedLinkTypes: [],
          addedObjectTypes: [],
          deletedActionTypeIds: [],
          deletedLinkTypeIds: [],
          deletedObjectTypeIds: [],
          modifiedActionTypes: [],
          modifiedLinkTypes: [],
          modifiedObjectTypes: [],
        },
        createdAt: Date.now(),
        description: "Test",
        id: "prop-review-test",
        reviews: [],
        sourceBranch: "feature",
        status: "open",
        targetBranch: "main",
        title: "Test",
        updatedAt: Date.now(),
      };

      const reviewer: Subject = {
        id: "rev-1",
        name: "Reviewer",
        roles: ["admin"],
        type: "user",
      };

      const rejected = await Effect.runPromise(
        approver.submitReview(
          baseProposal,
          reviewer,
          "reject",
          "Rejected due to flaws"
        )
      );
      expect(rejected.status).toBe("rejected");

      const approved = await Effect.runPromise(
        approver.submitReview(baseProposal, reviewer, "approve", "Looks good")
      );
      expect(approved.status).toBe("approved");

      await Effect.runPromise(approver.assertMergeable(approved));
      const failMergeRes = await Effect.runPromise(
        approver.assertMergeable(rejected).pipe(Effect.result)
      );
      expect(failMergeRes._tag).toBe("Failure");
      if (failMergeRes._tag === "Failure") {
        expect(failMergeRes.failure).toBeInstanceOf(
          ApprovalsPolicyViolationError
        );
      }
    });
  });

  describe("Tagged Error Constructors (errors.ts)", () => {
    it("instantiates AuthorizationError and NotFoundError with expected properties", () => {
      const authErr = new AuthorizationError({
        reason: "Insufficient RBAC tier",
      });
      expect(authErr._tag).toBe("AuthorizationError");
      expect(authErr.reason).toBe("Insufficient RBAC tier");

      const notFoundErr = new NotFoundError({
        entityId: "OBJ-404",
        message: "Entity missing",
      });
      expect(notFoundErr._tag).toBe("NotFoundError");
      expect(notFoundErr.entityId).toBe("OBJ-404");
      expect(notFoundErr.message).toBe("Entity missing");
    });
  });

  describe("Kernel Edge Cases & Defenses", () => {
    it("covers bitemporal asOfValidTime nonexistent branch", async () => {
      const bStore = new BitemporalObjectStore();
      const res = await Effect.runPromise(
        bStore.asOfValidTime("Account" as ObjectTypeId, "NONEXISTENT", 1000)
      );
      expect(res).toBeUndefined();
    });

    it("inspects models via getModel and catches model computation failures in sandbox", async () => {
      const sandbox = new SandboxedModelRunner();
      sandbox.registerModel({
        compute: () =>
          Effect.fail(
            new StorageError({
              message: "Math domain error: division by zero",
            })
          ),
        isDeterministic: true,
        modelId: "failing_math_model",
        requiredInputs: [],
        version: "1.0",
      });

      const modelDef = sandbox.getModel("failing_math_model");
      expect(modelDef?.version).toBe("1.0");

      const execRes = await Effect.runPromise(
        sandbox.execute("failing_math_model", {}).pipe(Effect.result)
      );
      expect(execRes._tag).toBe("Failure");
      if (execRes._tag === "Failure") {
        expect(execRes.failure).toBeInstanceOf(SandboxExecutionError);
        expect((execRes.failure as SandboxExecutionError).reason).toContain(
          "division by zero"
        );
      }
    });

    it("deletes objects in SQL bitemporal store", async () => {
      const driver = new EmbeddedSqlDriver();
      const store = new SqlBitemporalStore(driver, "sqlite");
      const typeId = "Vessel" as ObjectTypeId;

      await Effect.runPromise(
        store.putObject({
          id: "VES-DEL",
          lastModifiedAt: 1000,
          properties: { flag: "LIBERIA" },
          typeId,
          version: 1,
        })
      );

      await Effect.runPromise(store.deleteObject(typeId, "VES-DEL"));
      const remaining = await Effect.runPromise(store.findObjects(typeId));
      expect(remaining.length).toBe(0);
    });

    it("passes CROV verification when proposal change set is valid", async () => {
      const crov = new CROVEngine();
      const docType = defineObjectType({
        description: "Doc",
        id: "Document",
        name: "Document",
        primaryKey: "id",
        properties: {
          id: defineProperty({ description: "ID", schema: Schema.String }),
        },
      });

      const validProposal: OntologyProposal = {
        author: { id: "u1", name: "User", roles: [], type: "user" },
        changeSet: {
          addedActionTypes: [],
          addedLinkTypes: [],
          addedObjectTypes: [],
          deletedActionTypeIds: [],
          deletedLinkTypeIds: [],
          deletedObjectTypeIds: [],
          modifiedActionTypes: [],
          modifiedLinkTypes: [],
          modifiedObjectTypes: [],
        },
        createdAt: Date.now(),
        description: "Clean proposal",
        id: "prop-clean",
        reviews: [],
        sourceBranch: "feature",
        status: "open",
        targetBranch: "main",
        title: "Clean",
        updatedAt: Date.now(),
      };

      const readiness = await Effect.runPromise(
        crov.verifyProposal(validProposal, [docType], [])
      );
      expect(readiness.isReady).toBe(true);
      expect(readiness.issues.length).toBe(0);

      const verifier = new VEDOVerifier();
      const unmappedRes = await Effect.runPromise(
        verifier.verifyMutation("UnmappedType", { x: 1 }).pipe(Effect.result)
      );
      expect(unmappedRes._tag).toBe("Success");
    });

    it("raises FunnelIngestionError when stream record primary key is missing", async () => {
      const store = new InMemoryObjectStore();
      const funnel = new FunnelService(store);

      await Effect.runPromise(
        funnel.registerPipeline({
          conflictPolicy: "source_wins",
          id: "pipe-strict",
          mode: "streaming",
          name: "Strict Pipeline",
          primaryKeyField: "id",
          propertyMappings: [{ sourceField: "id", targetPropertyName: "id" }],
          sourceDatasetId: "iot",
          targetObjectTypeId: "Sensor",
        })
      );

      const streamRes = await Effect.runPromise(
        funnel
          .ingestStreamRecord("pipe-strict", { temp: 25 })
          .pipe(Effect.result)
      );
      expect(streamRes._tag).toBe("Failure");
      if (streamRes._tag === "Failure") {
        expect(streamRes.failure).toBeInstanceOf(FunnelIngestionError);
      }
    });

    it("fails authentication with invalid base64 JWT formatting", async () => {
      const verifier = new OidcTokenVerifier({
        expectedAudience: "api://operon",
        expectedIssuer: "https://auth.operon.io",
        secretOrPublicKey: "secret",
      });

      const badJwtRes = await Effect.runPromise(
        verifier.verifyToken("invalid base64").pipe(Effect.result)
      );
      expect(badJwtRes._tag).toBe("Failure");
      if (badJwtRes._tag === "Failure") {
        expect(badJwtRes.failure).toBeInstanceOf(AuthenticationError);
        expect((badJwtRes.failure as AuthenticationError).reason).toContain(
          "Invalid JWT format"
        );
      }

      const badJsonRes = await Effect.runPromise(
        verifier.verifyToken("notjson.notjson.notjson").pipe(Effect.result)
      );
      expect(badJsonRes._tag).toBe("Failure");
      if (badJsonRes._tag === "Failure") {
        expect(badJsonRes.failure).toBeInstanceOf(AuthenticationError);
        expect((badJsonRes.failure as AuthenticationError).reason).toContain(
          "Failed to decode JWT base64url"
        );
      }
    });

    it("handles OMS error branches for invalid target branch and nonexistent proposal review/merge", async () => {
      const oms = new OntologyMetadataService();
      const dev: Subject = {
        id: "dev-1",
        name: "Dev",
        roles: [],
        type: "user",
      };

      const badTargetRes = await Effect.runPromise(
        oms
          .createProposal({
            author: dev,
            changeSet: {
              addedActionTypes: [],
              addedLinkTypes: [],
              addedObjectTypes: [],
              deletedActionTypeIds: [],
              deletedLinkTypeIds: [],
              deletedObjectTypeIds: [],
              modifiedActionTypes: [],
              modifiedLinkTypes: [],
              modifiedObjectTypes: [],
            },
            description: "Bad target",
            sourceBranch: "main",
            targetBranch: "nonexistent-target",
            title: "Bad Target",
          })
          .pipe(Effect.result)
      );
      expect(badTargetRes._tag).toBe("Failure");
      if (badTargetRes._tag === "Failure") {
        expect(badTargetRes.failure).toBeInstanceOf(BranchNotFoundError);
      }

      const badReviewRes = await Effect.runPromise(
        oms
          .reviewProposal("nonexistent-prop", {
            notes: "None",
            reviewedAt: Date.now(),
            reviewer: dev,
            verdict: "approve",
          })
          .pipe(Effect.result)
      );
      expect(badReviewRes._tag).toBe("Failure");
      if (badReviewRes._tag === "Failure") {
        expect(badReviewRes.failure).toBeInstanceOf(ProposalNotFoundError);
      }

      const badMergeRes = await Effect.runPromise(
        oms.mergeProposal("nonexistent-prop", dev).pipe(Effect.result)
      );
      expect(badMergeRes._tag).toBe("Failure");
      if (badMergeRes._tag === "Failure") {
        expect(badMergeRes.failure).toBeInstanceOf(ProposalNotFoundError);
      }
    });

    it("instantiates ProposalExecutionStateError and SideEffectExecutionError with proper tags", () => {
      const execErr = new ProposalExecutionStateError({
        message: "State not resolved",
        proposalId: "prop-42",
      });
      expect(execErr._tag).toBe("ProposalExecutionStateError");
      expect(execErr.proposalId).toBe("prop-42");

      const sideErr = new SideEffectExecutionError({
        cause: "Network timeout",
        sideEffectId: "side-1",
      });
      expect(sideErr._tag).toBe("SideEffectExecutionError");
      expect(sideErr.sideEffectId).toBe("side-1");
    });
  });
});
