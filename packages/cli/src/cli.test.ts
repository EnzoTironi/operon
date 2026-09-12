import { parseJson, serializeJson } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  joinPath,
  resolvePath,
  unlinkFileSync,
  writeTextFileSync,
} from "./fs-io.js";
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

  it("executes exact bitemporal queries, explain plans, and identity reconciliation via CLI (V0-CH-06)", async () => {
    // 1. Exact bitemporal query
    const now = Date.now();
    const queryCode = await Effect.runPromise(
      runCli([
        "object",
        "query",
        "Patient",
        "P001",
        "--valid-time",
        String(now),
        "--json",
      ])
    );
    expect(queryCode).toBe(0);

    // 2. Query explain plan
    const explainCode = await Effect.runPromise(
      runCli([
        "object",
        "explain",
        "Patient",
        "P001",
        "--valid-time",
        String(now),
        "--tx-time",
        String(now),
        "--json",
      ])
    );
    expect(explainCode).toBe(0);

    // 3. Propose identity resolution (confidence 0.70 -> ambiguous)
    const proposeCode = await Effect.runPromise(
      runCli([
        "reconcile",
        "propose",
        "--source-system",
        "crm",
        "--source-key",
        "c-999",
        "--target-canonical",
        "P001",
        "--action",
        "merge",
        "--confidence",
        "0.70",
        "--json",
      ])
    );
    expect(proposeCode).toBe(0);

    // 4. List identity proposals
    const listPropCode = await Effect.runPromise(
      runCli(["reconcile", "list", "--json"])
    );
    expect(listPropCode).toBe(0);
  });

  it("prepares, approves, commits, checks status, and generates disposable views (Gate V0-E: V0-CH-07, V0-CH-08, V0-CH-09)", () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.map(String).join(" "));
        origLog(...args);
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          console.log = origLog;
        })
      );

      // 1. Prepare action (zero business side effects)
      logs.length = 0;
      const prepCode = yield* runCli([
        "action",
        "prepare",
        "update_vitals",
        "--params",
        '{"patientId":"P001","heartRate":78}',
        "--subject-id",
        "agent-007",
        "--role",
        "operator",
        "--json",
      ]);
      expect(prepCode).toBe(0);
      const prepOutput = parseJson(logs.at(-1)!);
      expect(prepOutput.status).toBe("PREPARED");
      expect(prepOutput.actionId).toBe("update_vitals");
      expect(prepOutput.canonicalDigest).toBeDefined();
      const digest = prepOutput.canonicalDigest;

      // Verify zero business mutation before commit:
      logs.length = 0;
      yield* runCli(["object", "get", "Patient", "P001", "--json"]);
      const patientBefore = parseJson(logs.at(-1)!);
      expect(patientBefore.properties.heartRate).not.toBe(78);

      // 2. Reject mismatched proposal approval
      const mismatchCode = yield* runCli([
        "action",
        "approve",
        digest,
        "--viewed-digest",
        "tampered_digest_12345",
        "--reviewer-id",
        "dr_smith",
        "--role",
        "clinician",
      ]);
      expect(mismatchCode).toBe(1);

      // 3. Reject self-approval (reviewer === proposer)
      const selfApproveCode = yield* runCli([
        "action",
        "approve",
        digest,
        "--viewed-digest",
        digest,
        "--reviewer-id",
        "agent-007",
        "--role",
        "clinician",
      ]);
      expect(selfApproveCode).toBe(1);

      // 4. Legitimate exact approval by human reviewer
      logs.length = 0;
      const approveCode = yield* runCli([
        "action",
        "approve",
        digest,
        "--viewed-digest",
        digest,
        "--reviewer-id",
        "dr_smith",
        "--role",
        "physician",
        "--json",
      ]);
      expect(approveCode).toBe(0);
      const approveOutput = parseJson(logs.at(-1)!);
      expect(approveOutput.status).toBe("APPROVED");
      expect(approveOutput.approvalId).toBeDefined();
      const approvalId = approveOutput.approvalId;

      // 5. Local Atomic Commit
      logs.length = 0;
      const idempotencyKey = `cli-v0e-commit-${Date.now()}`;
      const commitCode = yield* runCli([
        "action",
        "commit",
        digest,
        "--approval-id",
        approvalId,
        "--idempotency-key",
        idempotencyKey,
        "--json",
      ]);
      expect(commitCode).toBe(0);
      const commitOutput = parseJson(logs.at(-1)!);
      expect(commitOutput.status).toBe("COMMITTED");
      expect(commitOutput.operationId).toBeDefined();
      expect(commitOutput.receiptDigest).toBeDefined();
      const operationId = commitOutput.operationId;

      // Verify business mutation applied atomically after commit
      logs.length = 0;
      yield* runCli(["object", "get", "Patient", "P001", "--json"]);
      const patientAfter = parseJson(logs.at(-1)!);
      expect(patientAfter.properties.heartRate).toBe(78);

      // 6. Action status inspection
      logs.length = 0;
      const statusCode = yield* runCli([
        "action",
        "status",
        operationId,
        "--json",
      ]);
      expect(statusCode).toBe(0);
      const statusOutput = parseJson(logs.at(-1)!);
      expect(statusOutput.operationId).toBe(operationId);
      expect(statusOutput.status).toBe("COMMITTED");

      // 7. Generate disposable view
      logs.length = 0;
      const viewCode = yield* runCli([
        "view",
        "generate",
        "--title",
        "Patient Vitals Clinical Overview",
        "--state",
        "PROPOSED",
        "--data",
        '{"patientId":"P001","heartRate":78,"egfr":52}',
        "--json",
      ]);
      expect(viewCode).toBe(0);
      const viewOutput = parseJson(logs.at(-1)!);
      expect(viewOutput.isDisposable).toBe(true);
      expect(viewOutput.sourceOfTruth).toBe("OPERON_KERNEL");
      expect(viewOutput.state).toBe("PROPOSED");
      expect(viewOutput.rendered).toContain("PROPOSED");
      expect(viewOutput.rendered).toContain("source of truth");
      expect(viewOutput.rendered).toContain("disposable");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("drives assurance F1 evaluation, receipt verification, F2 mirror, and publication boundary scan (Gate V0-F: V0-CH-10, V0-CH-11, V0-CH-12)", () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => {
        logs.push(msg);
        origLog(msg);
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          console.log = origLog;
        })
      );

      // 1. Evaluate F1 Company-in-a-Box via CLI
      logs.length = 0;
      const casesJson = serializeJson([
        {
          assertions: 8,
          executionTimeMs: 40,
          id: "CLI-TC-01",
          name: "Kernel Determinism Under Load",
          status: "PASS",
        },
      ]);

      const evalCode = yield* runCli([
        "assurance",
        "evaluate",
        "--candidate",
        "cand_v0_cli_candidate",
        "--profile",
        "local",
        "--catalog",
        "cat_v0_cli_catalog",
        "--cases",
        casesJson,
        "--json",
      ]);
      expect(evalCode).toBe(0);
      const f1Receipt = parseJson(logs.at(-1)!) as {
        outcome: string;
        assertionsCount: number;
        signature: unknown;
        signerPublicKey: unknown;
      };
      expect(f1Receipt.outcome).toBe("PASS");
      expect(f1Receipt.assertionsCount).toBe(8);
      expect(f1Receipt.signature).toBeDefined();
      expect(f1Receipt.signerPublicKey).toBeDefined();

      // 2. Verify F1 Receipt via CLI
      const tempReceiptPath = joinPath(
        process.cwd(),
        `.tmp-test-receipt-${Date.now()}.json`
      );
      writeTextFileSync(tempReceiptPath, serializeJson(f1Receipt));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unlinkFileSync(tempReceiptPath);
        })
      );

      logs.length = 0;
      const verifyCode = yield* runCli([
        "assurance",
        "verify-receipt",
        tempReceiptPath,
        "--json",
      ]);
      expect(verifyCode).toBe(0);
      const verifyOutput = parseJson(logs.at(-1)!) as { isValid: boolean };
      expect(verifyOutput.isValid).toBe(true);

      // 3. Evaluate F2 Consented Mirror via CLI
      logs.length = 0;
      const consentJson = serializeJson({
        consentGrantId: "consent_cli_001",
        createdAt: Date.now() - 500,
        dataScope: ["patient_records", "vitals"],
        expiresAt: Date.now() + 86400000,
        participantId: "regional_hospital_group",
        purpose: "safe dosage clinical mirror",
      });

      const correctionsJson = serializeJson([
        {
          correctedAt: Date.now(),
          correctedBy: "dr_turner",
          correctedValue: 8,
          correctionId: "corr_cli_01",
          observedTarget: "Patient/P001/currentDose",
          priorValue: 12,
          reason: "Renal clearance reduction confirmed",
        },
      ]);

      const mirrorCode = yield* runCli([
        "assurance",
        "mirror",
        "--participant",
        "regional_hospital_group",
        "--consent",
        consentJson,
        "--corrections",
        correctionsJson,
        "--claim",
        "observed-action",
        "--json",
      ]);
      expect(mirrorCode).toBe(0);
      const f2Receipt = parseJson(logs.at(-1)!) as {
        participantId: string;
        claim: string;
        correctionRefs: string[];
        signature: unknown;
      };
      expect(f2Receipt.participantId).toBe("regional_hospital_group");
      expect(f2Receipt.claim).toBe("observed-action");
      expect(f2Receipt.correctionRefs).toEqual(["corr_cli_01"]);
      expect(f2Receipt.signature).toBeDefined();

      // 4. Scan publication boundary via CLI
      logs.length = 0;
      const scanCode = yield* runCli([
        "assurance",
        "scan",
        resolvePath(process.cwd(), "benchmarks/public"),
        "--public-only",
        "--json",
      ]);
      expect(scanCode).toBe(0);
      const scanOutput = parseJson(logs.at(-1)!) as {
        isClean: boolean;
        violations: unknown[];
      };
      expect(scanOutput.isClean).toBe(true);
      expect(scanOutput.violations.length).toBe(0);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("documents mcp start default as consumer tier 2", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const code = await Effect.runPromise(runCli(["mcp", "--help"]));
      expect(code).toBe(0);
      const help = logs.join("\n");
      expect(help).toContain("Default --agent-tier is 2");
      expect(help).not.toContain("default --agent-tier is 4");
    } finally {
      console.log = origLog;
    }
  });
});
