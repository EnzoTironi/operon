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

const pessoaProperties =
  '{"displayName":"Ana Silva","emails":["ana.silva@unimed.com.br"]}';

describe("@operon/cli test suite", () => {
  it("runs operon doctor and reports healthy status", async () => {
    const code = await Effect.runPromise(runCli(["doctor", "--json"]));
    expect(code).toBe(0);
  });

  it("writes and reads a Pessoa via operon object put and get", async () => {
    const dbFile = resolvePath(
      process.cwd(),
      `.operon-cli-pessoa-${Date.now()}.db`
    );
    try {
      const putCode = await Effect.runPromise(
        runCli([
          "object",
          "put",
          "--type",
          "Pessoa",
          "--id",
          "ana",
          "--properties",
          pessoaProperties,
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect(putCode).toBe(0);
      const getCode = await Effect.runPromise(
        runCli(["object", "get", "Pessoa", "ana", "--db", dbFile, "--json"])
      );
      expect(getCode).toBe(0);
      const missingCode = await Effect.runPromise(
        runCli(["object", "get", "Patient", "P001", "--db", dbFile, "--json"])
      );
      expect(missingCode).toBe(1);
    } finally {
      unlinkFileSync(dbFile);
      unlinkFileSync(`${dbFile}.state.json`);
    }
  });

  it("evaluates 4C decision readiness for a Pessoa the operator wrote", async () => {
    const dbFile = resolvePath(
      process.cwd(),
      `.operon-cli-readiness-${Date.now()}.db`
    );
    try {
      await Effect.runPromise(
        runCli([
          "object",
          "put",
          "--type",
          "Pessoa",
          "--id",
          "ana",
          "--properties",
          pessoaProperties,
          "--db",
          dbFile,
        ])
      );
      const code = await Effect.runPromise(
        runCli([
          "readiness",
          "check",
          "Pessoa",
          "ana",
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect([0, 2]).toContain(code);
    } finally {
      unlinkFileSync(dbFile);
      unlinkFileSync(`${dbFile}.state.json`);
    }
  });

  it("lists no Action Types on first boot", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
      origLog(msg);
    };
    try {
      const code = await Effect.runPromise(
        runCli(["action", "list", "--json"])
      );
      expect(code).toBe(0);
      expect(parseJson(logs.at(-1)!)).toEqual([]);
    } finally {
      console.log = origLog;
    }
  });

  it("refuses to prepare an Action Type that is not installed", async () => {
    const code = await Effect.runPromise(
      runCli([
        "action",
        "prepare",
        "update_vitals",
        "--params",
        '{"patientId":"P001","heartRate":72}',
        "--json",
      ])
    );
    expect(code).toBe(1);
  });

  it("refuses to submit an Action Type that is not installed", async () => {
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
    expect(code).toBe(1);
  });

  it("cryptographically verifies audit ledger hash chain", async () => {
    const code = await Effect.runPromise(runCli(["audit", "verify", "--json"]));
    expect(code).toBe(0);
  });

  it("fails sandbox verify when no model is registered", async () => {
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
    expect(code).toBe(1);
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

  it("polls a recorded Gmail mailbox into quarantine via operon source poll", async () => {
    const dbFile = resolvePath(
      process.cwd(),
      `.operon-cli-gmail-poll-${Date.now()}.db`
    );
    try {
      const pollCode = await Effect.runPromise(
        runCli([
          "source",
          "poll",
          "--tenant",
          "clinic",
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect(pollCode).toBe(0);
      const listCode = await Effect.runPromise(
        runCli([
          "source",
          "list",
          "--tenant",
          "clinic",
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect(listCode).toBe(0);
    } finally {
      unlinkFileSync(dbFile);
      unlinkFileSync(`${dbFile}.state.json`);
    }
  });

  it("executes exact bitemporal queries, explain plans, and identity reconciliation via CLI (V0-CH-06)", async () => {
    const dbFile = resolvePath(
      process.cwd(),
      `.operon-cli-query-${Date.now()}.db`
    );
    try {
      await Effect.runPromise(
        runCli([
          "object",
          "put",
          "--type",
          "Pessoa",
          "--id",
          "ana",
          "--properties",
          pessoaProperties,
          "--db",
          dbFile,
        ])
      );
      const now = Date.now();
      const queryCode = await Effect.runPromise(
        runCli([
          "object",
          "query",
          "Pessoa",
          "ana",
          "--valid-time",
          String(now),
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect(queryCode).toBe(0);

      const explainCode = await Effect.runPromise(
        runCli([
          "object",
          "explain",
          "Pessoa",
          "ana",
          "--valid-time",
          String(now),
          "--tx-time",
          String(now),
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect(explainCode).toBe(0);

      const proposeCode = await Effect.runPromise(
        runCli([
          "reconcile",
          "propose",
          "--source-system",
          "crm",
          "--source-key",
          "c-999",
          "--target-canonical",
          "ana",
          "--action",
          "merge",
          "--confidence",
          "0.70",
          "--db",
          dbFile,
          "--json",
        ])
      );
      expect(proposeCode).toBe(0);

      const listPropCode = await Effect.runPromise(
        runCli(["reconcile", "list", "--db", dbFile, "--json"])
      );
      expect(listPropCode).toBe(0);
    } finally {
      unlinkFileSync(dbFile);
      unlinkFileSync(`${dbFile}.state.json`);
    }
  });

  it("writes a Pessoa, refuses an uninstalled Action, and generates a disposable view", () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
        origLog(...args);
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          console.log = origLog;
        })
      );

      const dbFile = resolvePath(
        process.cwd(),
        `.operon-cli-view-${Date.now()}.db`
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unlinkFileSync(dbFile);
          unlinkFileSync(`${dbFile}.state.json`);
        })
      );

      logs.length = 0;
      const putCode = yield* runCli([
        "object",
        "put",
        "--type",
        "Pessoa",
        "--id",
        "ana",
        "--properties",
        pessoaProperties,
        "--db",
        dbFile,
        "--json",
      ]);
      expect(putCode).toBe(0);

      logs.length = 0;
      yield* runCli([
        "object",
        "get",
        "Pessoa",
        "ana",
        "--db",
        dbFile,
        "--json",
      ]);
      const person = parseJson(logs.at(-1)!);
      expect(person.properties.displayName).toBe("Ana Silva");

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
        "--db",
        dbFile,
        "--json",
      ]);
      expect(prepCode).toBe(1);

      logs.length = 0;
      const viewCode = yield* runCli([
        "view",
        "generate",
        "--title",
        "Quarantine card",
        "--state",
        "PROPOSED",
        "--data",
        '{"pessoas":28,"conversas":1204}',
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
      expect(help).toContain("Companion is the session host");
      expect(help).toContain("OPERON_SESSION=");
      expect(help).not.toContain("operon approver session");
    } finally {
      console.log = origLog;
    }
  });

  it("keeps approver session as a hidden operator issuer", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const top = await Effect.runPromise(runCli(["--help"]));
      expect(top).toBe(0);
      expect(logs.join("\n")).not.toContain("operon approver session");
      expect(logs.join("\n")).not.toMatch(/^\s+approver\s+/mu);

      logs.length = 0;
      const hidden = await Effect.runPromise(runCli(["approver", "--help"]));
      expect(hidden).toBe(0);
      const help = logs.join("\n");
      expect(help).toContain("Hidden operator issuer");
      expect(help).toContain("Companion is the session host");
    } finally {
      console.log = origLog;
    }
  });
});
