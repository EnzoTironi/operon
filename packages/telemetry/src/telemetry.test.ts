import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { TelemetryDataScrubber } from "./scrubber.js";
import { OperonTelemetryService } from "./service.js";

class TestTelemetryError extends Data.TaggedError("TestTelemetryError")<{
  readonly message: string;
}> {}

describe("@operon/telemetry test suite", () => {
  describe("TelemetryDataScrubber", () => {
    it("should redact default sensitive keys like password, token, and mrn", () => {
      const scrubber = new TelemetryDataScrubber();
      const payload = {
        actionId: "adjust_dose",
        details: {
          mrn: "MRN-98765",
          password: "supersecretpassword",
          safeProp: "normal-value",
          token: "jwt-token-xyz",
        },
        patientId: "P001",
      };

      const scrubbed = scrubber.scrub(payload);

      expect(scrubbed.details.password).toBe("[REDACTED]");
      expect(scrubbed.details.token).toBe("[REDACTED]");
      expect(scrubbed.details.mrn).toBe("[REDACTED]");
      expect(scrubbed.details.safeProp).toBe("normal-value");
      expect(scrubbed.actionId).toBe("adjust_dose");
    });

    it("should pseudonymize sensitive identifiers cryptographically", () => {
      const scrubber = new TelemetryDataScrubber();
      const anon1 = scrubber.pseudonymize("patient_alpha");
      const anon2 = scrubber.pseudonymize("patient_alpha");
      const anon3 = scrubber.pseudonymize("patient_beta");

      expect(anon1).toMatch(/^anon_[a-f0-9]{12}$/u);
      expect(anon1).toBe(anon2); // Deterministic
      expect(anon1).not.toBe(anon3); // Unique per input
    });

    it("should handle circular references without infinite recursion", () => {
      const scrubber = new TelemetryDataScrubber();
      const circularObj: any = { name: "test" };
      circularObj.self = circularObj;

      const scrubbed = scrubber.scrub(circularObj);
      expect(scrubbed.name).toBe("test");
      expect(scrubbed.self).toBe("[CIRCULAR_REFERENCE]");
    });
  });

  describe("OperonTelemetryService", () => {
    it("should initialize safely in no-op mode without credentials", () => {
      const service = new OperonTelemetryService({ enabled: false });
      expect(service.isEnabled()).toBe(false);
      expect(service.isSentryActive()).toBe(false);
      expect(service.isPostHogActive()).toBe(false);

      // Should not throw
      service.addBreadcrumb("test", "test message", { foo: "bar" });
      service.captureError(new TestTelemetryError({ message: "sample error" }));
    });

    it("should track events into the recent events buffer", () => {
      const service = new OperonTelemetryService({ enabled: false });

      service.trackEvent({
        event: "operon_action_submitted",
        properties: {
          actionId: "update_vitals",
          correlationId: "corr_123",
          executionMode: "automated",
          riskTier: "low",
          subjectId: "agent_clinician",
          subjectType: "agent",
        },
      });

      const events = service.getRecentEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1).event).toBe("operon_action_submitted");
    });

    it("should wrap Effect workflows in spans seamlessly", async () => {
      const service = new OperonTelemetryService({ enabled: false });

      const effect = Effect.succeed({ result: "ok", value: 42 });
      const wrapped = service.withSpan(
        "operon.test_operation",
        { action: "test" },
        effect
      );

      const res = await Effect.runPromise(wrapped);
      expect(res.value).toBe(42);
      expect(res.result).toBe("ok");
    });

    it("should catch errors in withSpan and propagate the failure cleanly", async () => {
      const service = new OperonTelemetryService({ enabled: false });

      const failure = Effect.fail(
        new TestTelemetryError({ message: "simulated failure" })
      );
      const wrapped = service.withSpan("failing_op", { id: "1" }, failure);

      await expect(Effect.runPromise(wrapped)).rejects.toThrow(
        "simulated failure"
      );
    });

    it("should flush and close gracefully", async () => {
      const service = new OperonTelemetryService({ enabled: false });
      await expect(service.flushAndClose()).resolves.toBeUndefined();
    });
  });
});
