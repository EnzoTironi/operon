import { OperonTelemetryService } from "@operon/telemetry";
import { Effect } from "effect";

import { runAction } from "./commands/action.js";
import { runAudit } from "./commands/audit.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { runInbox } from "./commands/inbox.js";
import { runMcp } from "./commands/mcp.js";
import { runObject } from "./commands/object.js";
import { runOms } from "./commands/oms.js";
import { runReadiness } from "./commands/readiness.js";
import { runRecipe } from "./commands/recipe.js";
import { runReconcile } from "./commands/reconcile.js";
import { runSandbox } from "./commands/sandbox.js";
import { runSkill } from "./commands/skill.js";
import { runSource } from "./commands/source.js";
import { runTelemetry } from "./commands/telemetry.js";

export function printHelp(): void {
  console.log(`
Operon CLI — The Governed Operational Ontology & Decision Runtime for AI Agents

Usage:
  operon <command> [subcommand] [flags]

Commands:
  doctor              Run environment, storage, and cryptographic audit health checks
  object              Get, put, list, bitemporal exact query, and SQL plan explain (S04)
  readiness           Evaluate Level-1 4C Decision Readiness (Completeness, Correctness, Currentness, Consistency)
  action              List registered actions or submit an action through the 7-Step Write Pipeline
  inbox               Inspect pending proposals, approve, or reject with human override dossiers
  audit               List tamper-evident DecisionRecords and cryptographically verify SHA-256 chain
  oms                 Ontology Metadata Service: branch, propose, review, and merge ontology changes
  skill               List registered versioned skills or inspect schemas and digests
  recipe              List, get, or import declarative recipe packs (S14: grants no authority)
  source              Accountable raw source inventory, mapping proposals, and admission (S03, S15)
  reconcile           Identity resolution proposals, deterministic & ML matching, reversible merge/split (S03)
  sandbox             Execute sandboxed models with fiber timeouts and verify determinism proofs
  mcp                 Launch Model Context Protocol (MCP) server over stdio for Claude Desktop / Cursor
  telemetry           Inspect Sentry & PostHog telemetry status, privacy scrubber, and diagnostic ping
  demo                Run end-to-end domain simulations (healthcare, aviation, wastewater, sompo, education)

Global Flags:
  --json              Output structured machine-readable JSON
  --db <path>         Path to SQLite database (defaults to in-memory store)
  --help, -h          Print contextual help with copy-pasteable examples
  --version, -v       Print CLI version

Examples:
  operon doctor --json
  operon object get Patient P001 --json
  operon readiness check Patient P001
  operon action submit update_vitals --params '{"patientId":"P001","heartRate":72}' --agent-tier 4
  operon action submit adjust_dose --params '{"patientId":"P001","recommendedDose":10}' --agent-tier 2
  operon inbox list --json
  operon audit verify --json
  operon sandbox verify predictive_vibration_model --inputs '{"value":14.2}'
  operon demo healthcare
`);
}

function dispatchCommand(
  command: string,
  args: string[]
): Effect.Effect<number, unknown, never> {
  switch (command) {
    case "doctor": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage: operon doctor [--db <path>] [--json]

Examples:
  operon doctor
  operon doctor --json
  operon doctor --db ./operon.db
`);
        return Effect.succeed(0);
      }
      return runDoctor({
        dbPath: args.includes("--db")
          ? args[args.indexOf("--db") + 1]
          : undefined,
        json: args.includes("--json"),
      });
    }

    case "object": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon object get <typeId> <id> [--json] [--db <path>]
  operon object put --type <typeId> --id <id> --properties '<json>' [--version <n>] [--db <path>]
  operon object query <typeId> [id] [--valid-time <ms>] [--tx-time <ms>] [--json]
  operon object explain <typeId> <id> [--valid-time <ms>] [--tx-time <ms>] [--json]

Examples:
  operon object get Patient P001 --json
  operon object put --type Patient --id P002 --properties '{"name":"Alice","egfr":70}'
  operon object query Patient P001 --valid-time 1789000000000 --json
  operon object explain Patient P001 --valid-time 1789000000000
`);
        return Effect.succeed(0);
      }
      return runObject(args.slice(1));
    }

    case "readiness": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon readiness check <typeId> <id> [--json] [--db <path>]

Examples:
  operon readiness check Patient P001
  operon readiness check Patient P001 --json
`);
        return Effect.succeed(0);
      }
      return runReadiness(args.slice(1));
    }

    case "action": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon action list [--json]
  operon action submit <actionId> [--params '<json>' | --stdin] [--agent-tier <1-4>] [--dry-run] [--json]

Examples:
  operon action list --json
  operon action submit update_vitals --params '{"patientId":"P001","heartRate":72}' --agent-tier 4
  operon action submit adjust_dose --params '{"patientId":"P001","recommendedDose":12}' --agent-tier 2
  operon action submit update_vitals --params '{"patientId":"P001","heartRate":72}' --dry-run
  cat params.json | operon action submit update_vitals --stdin
`);
        return Effect.succeed(0);
      }
      return runAction(args.slice(1));
    }

    case "inbox": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon inbox list [--json]
  operon inbox approve <proposalId> --reviewer <id> --role <role> [--evidence-hash <hash>] [--override <cat> --reason <text>] [--json]
  operon inbox reject <proposalId> --reviewer <id> --role <role> --reason <text> [--json]

Examples:
  operon inbox list --json
  operon inbox approve proposal_123 --reviewer dr_li --role physician
  operon inbox approve proposal_123 --reviewer dr_li --role physician --override clinical_discretion --reason "Adjusted for fasting"
  operon inbox reject proposal_123 --reviewer chief_eng --role engineer --reason "Valve pressure excessive"
`);
        return Effect.succeed(0);
      }
      return runInbox(args.slice(1));
    }

    case "audit": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon audit list [--limit <n>] [--json]
  operon audit verify [--json]

Examples:
  operon audit list --limit 10 --json
  operon audit verify
  operon audit verify --json
`);
        return Effect.succeed(0);
      }
      return runAudit(args.slice(1));
    }

    case "oms": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon oms branch create <branchName> --author <id> [--json]
  operon oms proposal create --branch <branchName> --title <title> --author <id> [--json]
  operon oms proposal review <proposalId> --reviewer <id> --verdict <approve|reject> --comments <text> [--json]
  operon oms proposal merge <proposalId> --author <id> [--require-specialist] [--json]

Examples:
  operon oms branch create feature/telemetry --author arch_1
  operon oms proposal create --branch feature/telemetry --title "Add telemetry" --author arch_1
  operon oms proposal review prop_123 --reviewer doc_lead --verdict approve --comments "LGTM"
  operon oms proposal merge prop_123 --author lead_arch --require-specialist
`);
        return Effect.succeed(0);
      }
      return runOms(args.slice(1));
    }

    case "sandbox": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon sandbox verify <modelId> [--inputs '<json>'] [--iterations <n>] [--json]

Examples:
  operon sandbox verify predictive_vibration_model
  operon sandbox verify predictive_vibration_model --inputs '{"value":14.2}' --iterations 5 --json
`);
        return Effect.succeed(0);
      }
      return runSandbox(args.slice(1));
    }

    case "mcp": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  operon mcp start [--agent-tier <1-4>] [--db <path>]

Examples:
  operon mcp start
  operon mcp start --agent-tier 4
`);
        return Effect.succeed(0);
      }
      return runMcp(args.slice(1));
    }

    case "demo": {
      if (args.includes("--help") || args.includes("-h") || args.length === 1) {
        console.log(`
Usage:
  operon demo <healthcare|aviation|wastewater|sompo|education>

Examples:
  operon demo healthcare
  operon demo aviation
  operon demo wastewater
  operon demo sompo
  operon demo education
`);
        return Effect.succeed(0);
      }
      return runDemo(args.slice(1));
    }

    case "telemetry": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  operon telemetry status [--ping] [--json]

Examples:
  operon telemetry status
  operon telemetry status --ping --json
`);
        return Effect.succeed(0);
      }
      return runTelemetry(args.slice(1));
    }

    case "skill": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  operon skill list [--json]
  operon skill get <skillId> [--json]

Examples:
  operon skill list --json
  operon skill get operon.skill.audit-investigation
`);
        return Effect.succeed(0);
      }
      return runSkill(args.slice(1));
    }

    case "recipe": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  operon recipe list [--json]
  operon recipe get <recipeId> [--json]
  operon recipe import <path-or-builtin> [--json]

Examples:
  operon recipe list --json
  operon recipe get operon.recipe.aviation-skywise
  operon recipe import aviation-skywise --json
`);
        return Effect.succeed(0);
      }
      return runRecipe(args.slice(1));
    }

    case "source": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  operon source ingest --locator <loc> --media-type <mime> --payload '<json>' [--idempotency-key <k>] [--tenant <t>] [--json]
  operon source list [--tenant <t>] [--json]
  operon source get <sourceId> [--tenant <t>] [--json]
  operon source propose-mapping --sources <s1,s2> --target-type <t> --pk <f> --mappings '<json>' --definition <d> [--json]
  operon source admit-mapping <proposalId> [--json]

Examples:
  operon source ingest --locator s3://lake/data.json --media-type application/json --payload '[{"id":"1"}]' --json
  operon source list --json
`);
        return Effect.succeed(0);
      }
      return runSource(args.slice(1));
    }

    case "reconcile": {
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Usage:
  operon reconcile propose --source-system <sys> --source-key <key> --target-canonical <id> --action <link|merge|split> --confidence <float> [--reason <str>] [--original-ids <id1,id2>] [--idempotency-key <key>] [--json]
  operon reconcile resolve <proposalId> --decision-ref <ref> [--force-override] [--idempotency-key <key>] [--json]
  operon reconcile list [--json]
  operon reconcile get <proposalId> [--json]

Examples:
  operon reconcile propose --source-system crm --source-key c_101 --target-canonical cust_999 --action merge --confidence 0.95 --json
  operon reconcile resolve prop_123 --decision-ref dec_supervisor_1 --json
  operon reconcile list --json
`);
        return Effect.succeed(0);
      }
      return runReconcile(args.slice(1));
    }

    default: {
      console.error(`Error: Unknown command '${command}'\n`);
      console.error(
        "  Available commands: doctor, object, readiness, action, inbox, audit, oms, skill, recipe, source, reconcile, sandbox, mcp, telemetry, demo"
      );
      console.error("  Run 'operon --help' to see usage and examples.");
      return Effect.succeed(1);
    }
  }
}

export function runCli(
  argv: string[] = process.argv.slice(2)
): Effect.Effect<number, never, never> {
  const args = [...argv];
  const command = args[0];
  const isHelp =
    args.includes("--help") || args.includes("-h") || args.length === 0;

  if (args.includes("--version") || args.includes("-v")) {
    console.log("operon 0.1.0");
    return Effect.succeed(0);
  }

  if (isHelp && !command) {
    printHelp();
    return Effect.succeed(0);
  }

  const startTime = Date.now();
  const telemetry = OperonTelemetryService.getInstance();

  return Effect.gen(function* () {
    const handleCommandError = (error: unknown) => {
      telemetry.captureError(error, { args, command });
      return Effect.succeed(1);
    };

    const exitCode = yield* dispatchCommand(command, args).pipe(
      Effect.catch(handleCommandError)
    );

    telemetry.trackEvent({
      event: "operon_cli_command",
      properties: {
        command: command || "help",
        durationMs: Date.now() - startTime,
        exitCode,
      },
    });

    yield* Effect.promise(() => telemetry.flushAndClose());

    return exitCode;
  }).pipe(
    Effect.annotateLogs({ cliCommand: command || "help" }),
    Effect.provide(telemetry.getLoggerLayer())
  );
}

export function runCliPromise(
  argv: string[] = process.argv.slice(2)
): Promise<number> {
  return Effect.runPromise(runCli(argv));
}

export * from "./state.js";
export * from "./commands/doctor.js";
export * from "./commands/object.js";
export * from "./commands/readiness.js";
export * from "./commands/action.js";
export * from "./commands/inbox.js";
export * from "./commands/audit.js";
export * from "./commands/oms.js";
export * from "./commands/sandbox.js";
export * from "./commands/mcp.js";
export * from "./commands/demo.js";
export * from "./commands/telemetry.js";
export * from "./commands/skill.js";
export * from "./commands/recipe.js";
export * from "./commands/source.js";
