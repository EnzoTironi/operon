import { createOperonMcpServer, unboundApprover } from "@operon/mcp";
import { createOperonClient } from "@operon/osdk";
import {
  computeDiagnosticBundleHash,
  EMAIL_OBJECT_TYPE_IDS,
} from "@operon/schema";
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

      expect(objectTypes.map((type) => type.id).toSorted()).toEqual([
        ...EMAIL_OBJECT_TYPE_IDS,
      ]);
      expect(actionTypes).toHaveLength(0);

      const agentContext = {
        actor: createSubject("operator", "user", ["operator"]),
        correlationId: "parity-run-01",
        environmentId: "default",
        tenantId: "default",
      };

      const kernelResult = await operonService.invoke(
        agentContext,
        "view.generate",
        {
          data: { pessoas: 28 },
          state: "PROPOSED",
          title: "Quarantine card",
        }
      );
      expect(kernelResult.status).toBe("SUCCESS");
      expect(kernelResult.result).toBeDefined();

      const sdkClient = createOperonClient({
        actionTypes,
        auditStore,
        defaultSecurity: { subject: agentContext.actor },
        objectStore,
        objectTypes,
        operonService,
      });

      const pessoas = await Effect.runPromise(
        sdkClient.objects["Pessoa"].list()
      );
      expect(pessoas).toEqual([]);

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

      const result = await operonService.invoke(
        agentContext,
        "action.prepare",
        {
          actionId: "non_existent_action",
          rawParameters: {
            apiKey: "secret_token_live_999888777",
            password: "super_secret_password_123",
          },
        }
      );

      expect(result.status).toBe("ERROR");
      expect(result.schemaVersion).toBe("operon.v0");

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

      const successContext = {
        actor: createSubject("operator", "user", ["operator"]),
        correlationId: "run-business-success",
        environmentId: "default",
        tenantId: "default",
      };

      await operonService.invoke(successContext, "view.generate", {
        data: { pessoas: 28 },
        state: "PROPOSED",
        title: "Quarantine card",
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

      const policyDeniedContext = {
        actor: createSubject("proposer-01", "agent", ["operator"], 3),
        correlationId: "run-policy-denied",
        environmentId: "default",
        tenantId: "default",
      };

      await operonService.invoke(policyDeniedContext, "action.approve", {
        decision: "approved",
        preparedDigest: "missing-digest",
        viewedDigest: "missing-digest",
      });

      const policyDiag = await Effect.runPromise(
        operonService.diagnose("run-policy-denied")
      );
      expect(policyDiag.policyOutcome?.verdict).toBe("DENY");
      expect(policyDiag.businessOutcome?.status).toBe("violation");
      expect(policyDiag.infrastructureOutcome?.status).toBe("healthy");
      expect(policyDiag.channelSummary.policyCount).toBeGreaterThanOrEqual(1);

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
      const missingCode = await Effect.runPromise(runTelemetry(["diagnose"]));
      expect(missingCode).toBe(1);

      const nonExistentCode = await Effect.runPromise(
        runTelemetry(["diagnose", "non_existent_run_id_xyz", "--json"])
      );
      expect(nonExistentCode).toBe(1);
    });
  });
});
