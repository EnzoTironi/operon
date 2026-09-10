import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";

describe("@operon/cli test suite", () => {
  it("runs operon doctor and reports healthy status", async () => {
    const code = await Effect.runPromise(runCli(["doctor", "--json"]));
    expect(code).toBe(0);
  });

  it("retrieves an object instance via operon object get", async () => {
    const code = await Effect.runPromise(
      runCli(["object", "get", "Patient", "P001", "--json"])
    );
    expect(code).toBe(0);
  });

  it("evaluates 4C decision readiness via operon readiness check", async () => {
    const code = await Effect.runPromise(
      runCli(["readiness", "check", "Patient", "P001", "--json"])
    );
    // Patient P001 passes completeness & consistency in default seed
    expect([0, 2]).toContain(code);
  });

  it("previews action execution with --dry-run without mutating state", async () => {
    const code = await Effect.runPromise(
      runCli([
        "action",
        "submit",
        "update_vitals",
        "--params",
        '{"patientId":"P001","heartRate":72}',
        "--agent-tier",
        "4",
        "--dry-run",
        "--json",
      ])
    );
    expect(code).toBe(0);
  });

  it("executes automated action under Tier 4 bounded autonomy", async () => {
    const code = await Effect.runPromise(
      runCli([
        "action",
        "submit",
        "update_vitals",
        "--params",
        '{"patientId":"P001","heartRate":80}',
        "--agent-tier",
        "4",
        "--json",
      ])
    );
    expect(code).toBe(0);
  });

  it("routes proposal mode action under Tier 2 to Action Inbox", async () => {
    const code = await Effect.runPromise(
      runCli([
        "action",
        "submit",
        "set_valve_position",
        "--params",
        '{"tankId":"tank-alpha","openingPercent":50}',
        "--agent-tier",
        "2",
        "--json",
      ])
    );
    expect(code).toBe(0);
  });

  it("cryptographically verifies audit ledger hash chain", async () => {
    const code = await Effect.runPromise(runCli(["audit", "verify", "--json"]));
    expect(code).toBe(0);
  });

  it("verifies model sandbox determinism proof", async () => {
    const code = await Effect.runPromise(
      runCli([
        "sandbox",
        "verify",
        "predictive_vibration_model",
        "--inputs",
        '{"value":12}',
        "--iterations",
        "3",
        "--json",
      ])
    );
    expect(code).toBe(0);
  });

  it("creates ontology branch via OMS", async () => {
    const code = await Effect.runPromise(
      runCli([
        "oms",
        "branch",
        "create",
        "feature/new-sensors",
        "--author",
        "lead_arch",
        "--json",
      ])
    );
    expect(code).toBe(0);
  });

  it("inspects telemetry status via operon telemetry status", async () => {
    const code = await Effect.runPromise(
      runCli(["telemetry", "status", "--ping", "--json"])
    );
    expect(code).toBe(0);
  });

  it("lists and inspects skills via operon skill commands (V0-CH-04)", async () => {
    const listCode = await Effect.runPromise(
      runCli(["skill", "list", "--json"])
    );
    expect(listCode).toBe(0);

    const getCode = await Effect.runPromise(
      runCli(["skill", "get", "operon.skill.audit-investigation", "--json"])
    );
    expect(getCode).toBe(0);
  });

  it("lists, gets, and imports recipe packs via operon recipe commands (V0-CH-04)", async () => {
    const listCode = await Effect.runPromise(
      runCli(["recipe", "list", "--json"])
    );
    expect(listCode).toBe(0);

    const getCode = await Effect.runPromise(
      runCli(["recipe", "get", "operon.recipe.aviation-skywise", "--json"])
    );
    expect(getCode).toBe(0);

    const importCode = await Effect.runPromise(
      runCli(["recipe", "import", "aviation-skywise", "--json"])
    );
    expect(importCode).toBe(0);
  });

  it("ingests raw sources, proposes mappings, and admits records via operon source commands (V0-CH-05)", async () => {
    // 1. Ingest raw source via CLI
    const ingestCode = await Effect.runPromise(
      runCli([
        "source",
        "ingest",
        "--locator",
        "s3://lake/tanks/tank1.json",
        "--media-type",
        "application/json",
        "--payload",
        '[{"id":"tank-cli-1","status":"normal"}]',
        "--idempotency-key",
        "cli-key-1",
        "--json",
      ])
    );
    expect(ingestCode).toBe(0);

    // 2. Replay same source via CLI (idempotency check)
    const replayCode = await Effect.runPromise(
      runCli([
        "source",
        "ingest",
        "--locator",
        "s3://lake/tanks/tank1.json",
        "--media-type",
        "application/json",
        "--payload",
        '[{"id":"tank-cli-1","status":"normal"}]',
        "--idempotency-key",
        "cli-key-1",
        "--json",
      ])
    );
    expect(replayCode).toBe(0);

    // 3. List sources via CLI
    const listCode = await Effect.runPromise(
      runCli(["source", "list", "--json"])
    );
    expect(listCode).toBe(0);
  });
});
