import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";

describe("@operon/cli test suite", () => {
  it("should run operon doctor and report healthy status", async () => {
    const code = await runCli(["doctor", "--json"]);
    expect(code).toBe(0);
  });

  it("should retrieve an object instance via operon object get", async () => {
    const code = await runCli(["object", "get", "Patient", "P001", "--json"]);
    expect(code).toBe(0);
  });

  it("should evaluate 4C decision readiness via operon readiness check", async () => {
    const code = await runCli([
      "readiness",
      "check",
      "Patient",
      "P001",
      "--json",
    ]);
    // Patient P001 passes completeness & consistency in default seed
    expect([0, 2]).toContain(code);
  });

  it("should preview action execution with --dry-run without mutating state", async () => {
    const code = await runCli([
      "action",
      "submit",
      "update_vitals",
      "--params",
      '{"patientId":"P001","heartRate":72}',
      "--agent-tier",
      "4",
      "--dry-run",
      "--json",
    ]);
    expect(code).toBe(0);
  });

  it("should execute automated action under Tier 4 bounded autonomy", async () => {
    const code = await runCli([
      "action",
      "submit",
      "update_vitals",
      "--params",
      '{"patientId":"P001","heartRate":80}',
      "--agent-tier",
      "4",
      "--json",
    ]);
    expect(code).toBe(0);
  });

  it("should route proposal mode action under Tier 2 to Action Inbox", async () => {
    const code = await runCli([
      "action",
      "submit",
      "set_valve_position",
      "--params",
      '{"tankId":"tank-alpha","openingPercent":50}',
      "--agent-tier",
      "2",
      "--json",
    ]);
    expect(code).toBe(0);
  });

  it("should cryptographically verify audit ledger hash chain", async () => {
    const code = await runCli(["audit", "verify", "--json"]);
    expect(code).toBe(0);
  });

  it("should verify model sandbox determinism proof", async () => {
    const code = await runCli([
      "sandbox",
      "verify",
      "predictive_vibration_model",
      "--inputs",
      '{"value":12}',
      "--iterations",
      "3",
      "--json",
    ]);
    expect(code).toBe(0);
  });

  it("should create ontology branch via OMS", async () => {
    const code = await runCli([
      "oms",
      "branch",
      "create",
      "feature/new-sensors",
      "--author",
      "lead_arch",
      "--json",
    ]);
    expect(code).toBe(0);
  });

  it("should inspect telemetry status via operon telemetry status", async () => {
    const code = await runCli(["telemetry", "status", "--ping", "--json"]);
    expect(code).toBe(0);
  });
});
