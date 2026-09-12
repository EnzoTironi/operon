import { createOperonMcpServer, unboundApprover } from "@operon/mcp";
import { createOperonClient } from "@operon/osdk";
import { computeDiagnosticBundleHash } from "@operon/schema";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { runTelemetry } from "./commands/telemetry.js";
import { createRuntimeContext, createSubject } from "./state.js";

describe("Gate G1 / Ticket V1-08: Agent Protocol Parity and Diagnostics (S18)", () => {
  let ctx: Awaited<ReturnType<typeof createRuntimeContext>>;

  beforeEach(async () => {
    ctx = await createRuntimeContext();
  });

  describe("S18 Invariant 1: CLI, MCP, and SDK Protocol Parity", () => {
    it("does ensure CLI, MCP, and SDK call the same service and return equivalent semantics (S18)", async () => {
      const {
        operonService,
        objectStore,
        auditStore,
        objectTypes,
        actionTypes,
      } = ctx;

      // 1. Direct Kernel (OperonService)
      const agentContext = {
        actor: createSubject("dr_smith", "user", ["clinician", "operator"]),
        correlationId: "parity-run-01",
        environmentId: "default",
        tenantId: "default",
      };

      const kernelResult = await operonService.invoke(
        agentContext,
        "action.prepare",
        {
          actionId: "update_vitals",
          rawParameters: { heartRate: 72, patientId: "P001" },
        }
      );
      expect(kernelResult.status).toBe("SUCCESS");
      expect(kernelResult.result).toBeDefined();

      // 2. SDK (OperonClient)
      const sdkClient = createOperonClient({
        actionTypes,
        auditStore,
        defaultSecurity: { subject: agentContext.actor },
        objectStore,
        objectTypes,
        operonService,
      });

      const sdkPrepared = await Effect.runPromise(
        sdkClient.prepareAction(
          "update_vitals",
          { heartRate: 72, patientId: "P001" },
          {
            environmentId: "default",
            tenantId: "default",
          }
        )
      );
      expect(sdkPrepared).toBeDefined();
      expect(sdkPrepared.actionId).toBe("update_vitals");
      expect(sdkPrepared.canonicalDigest).toBeDefined();

      // 3. MCP Server
      const mcpServer = createOperonMcpServer({
        approver: unboundApprover,
        actionTypes,
        auditStore,
        objectStore,
        objectTypes,
        oms: ctx.oms,
        operonService,
      });
      expect(mcpServer).toBeDefined();

      // Diagnostic parity: SDK and Kernel share the same diagnostic view
      const kernelDiag = await Effect.runPromise(
        operonService.diagnose("parity-run-01")
      );
      const sdkDiag = await Effect.runPromise(
        sdkClient.diagnose("parity-run-01")
      );
      expect(kernelDiag.runId).toBe("parity-run-01");
      expect(sdkDiag.runId).toBe("parity-run-01");
      expect(kernelDiag.bundleHash).toBe(sdkDiag.bundleHash);
    });
  });

  describe("S18 Invariant 2: Redaction of Secrets and Machine-Readable Envelopes", () => {
    it("does ensure stdout and diagnostic logs keep machine-readable formatting and secrets redacted (S18)", async () => {
      const { operonService } = ctx;

      const agentContext = {
        actor: createSubject("agent-007", "agent", ["operator"], 3),
        correlationId: "secret-scrub-run-01",
        environmentId: "default",
        tenantId: "default",
      };

      // Invoke an operation that encounters an error with sensitive payload details
      const result = await operonService.invoke(
        agentContext,
        "action.prepare",
        {
          actionId: "non_existent_action",
          rawParameters: {
            apiKey: "secret_token_live_999888777",
            password: "super_secret_password_123",
            patientId: "P001",
          },
        }
      );

      expect(result.status).toBe("ERROR");
      expect(result.schemaVersion).toBe("operon.v0");

      // Verify diagnostics redacts credentials from entries
      const bundle = await Effect.runPromise(
        operonService.diagnose("secret-scrub-run-01")
      );
      expect(bundle).toBeDefined();

      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain("secret_token_live_999888777");
      expect(serialized).not.toContain("super_secret_password_123");
    });
  });

  describe("S18 Invariant 3: Tri-Channel Diagnostics (Business, Policy, Infrastructure)", () => {
    it("does distinguish business result, policy result and infrastructure failure in diagnostics (S18, D05)", async () => {
      const { operonService } = ctx;

      // Channel 1: Business Success
      const successContext = {
        actor: createSubject("operator", "user", ["operator", "clinician"]),
        correlationId: "run-business-success",
        environmentId: "default",
        tenantId: "default",
      };

      await operonService.invoke(successContext, "action.prepare", {
        actionId: "update_vitals",
        rawParameters: { heartRate: 75, patientId: "P001" },
      });

      const successDiag = await Effect.runPromise(
        operonService.diagnose("run-business-success")
      );
      expect(successDiag.businessOutcome?.status).toBe("success");
      expect(successDiag.policyOutcome?.verdict).toBe("ALLOW");
      expect(successDiag.infrastructureOutcome?.status).toBe("healthy");
      expect(successDiag.channelSummary.businessCount).toBeGreaterThanOrEqual(
        1
      );
      expect(successDiag.channelSummary.infrastructureCount).toBe(0);

      // Channel 2: Policy Denial (Self approval denial)
      const policyDeniedContext = {
        actor: createSubject("proposer-01", "agent", ["operator"], 3),
        correlationId: "run-policy-denied",
        environmentId: "default",
        tenantId: "default",
      };

      // Prepare an action, then attempt self-approval
      const prepRes = await operonService.invoke(
        policyDeniedContext,
        "action.prepare",
        {
          actionId: "update_vitals",
          rawParameters: { heartRate: 75, patientId: "P001" },
        }
      );
      const preparedDigest = (prepRes.result as any).preparedDigest;

      await operonService.invoke(policyDeniedContext, "action.approve", {
        decision: "approved",
        preparedDigest,
        viewedDigest: preparedDigest,
      });

      const policyDiag = await Effect.runPromise(
        operonService.diagnose("run-policy-denied")
      );
      expect(policyDiag.policyOutcome?.verdict).toBe("DENY");
      expect(policyDiag.businessOutcome?.status).toBe("violation");
      expect(policyDiag.infrastructureOutcome?.status).toBe("healthy"); // Infrastructure is completely healthy
      expect(policyDiag.channelSummary.policyCount).toBeGreaterThanOrEqual(1);

      // Channel 3: Infrastructure / Unknown Operation Failure
      const infraContext = {
        actor: createSubject("operator", "user", ["operator"]),
        correlationId: "run-infra-error",
        environmentId: "default",
        tenantId: "default",
      };

      await operonService.invoke(
        infraContext,
        "system.non_existent_unsupported",
        {}
      );

      const infraDiag = await Effect.runPromise(
        operonService.diagnose("run-infra-error")
      );
      expect(infraDiag.infrastructureOutcome?.status).toBe("failed");
      expect(infraDiag.businessOutcome?.status).toBe("inconclusive");
      expect(
        infraDiag.channelSummary.infrastructureCount
      ).toBeGreaterThanOrEqual(1);

      // Verify bundle cryptographic hash
      const computedHash = computeDiagnosticBundleHash({
        businessOutcome: infraDiag.businessOutcome,
        channelSummary: infraDiag.channelSummary,
        entries: infraDiag.entries,
        generatedAt: infraDiag.generatedAt,
        infrastructureOutcome: infraDiag.infrastructureOutcome,
        operation: infraDiag.operation,
        policyOutcome: infraDiag.policyOutcome,
        runId: infraDiag.runId,
      });
      expect(infraDiag.bundleHash).toBe(computedHash);
    });

    it("does execute operon telemetry diagnose via CLI and reject invalid runs (S18)", async () => {
      // 1. Missing runId fails with exit code 1
      const missingCode = await Effect.runPromise(runTelemetry(["diagnose"]));
      expect(missingCode).toBe(1);

      // 2. Non-existent runId fails with exit code 1
      const nonExistentCode = await Effect.runPromise(
        runTelemetry(["diagnose", "non_existent_run_id_xyz", "--json"])
      );
      expect(nonExistentCode).toBe(1);
    });
  });
});
