import { OperonTelemetryService } from "@operon/telemetry";
import { Clock, Effect } from "effect";

import { runAction } from "./commands/action.js";
import { runApprover } from "./commands/approver.js";
import { runAssurance } from "./commands/assurance.js";
import { runAudit } from "./commands/audit.js";
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
import { runView } from "./commands/view.js";

export function printHelp(): void {
  console.log(`
Operon CLI — The Governed Operational Ontology & Decision Runtime for AI Agents

Usage:
  operon <command> [subcommand] [flags]

Commands:
  doctor              Run environment, storage, and cryptographic audit health checks
  object              Get, put, list, bitemporal exact query, and SQL plan explain (S04)
  readiness           Evaluate Level-1 4C Decision Readiness (Completeness, Correctness, Currentness, Consistency)
  action              Prepare, approve, commit, inspect status, list, or submit governed actions (S07, S08)
  inbox               Inspect pending proposals, approve, or reject with human override dossiers
  audit               List tamper-evident DecisionRecords and cryptographically verify SHA-256 chain
  oms                 Ontology Metadata Service: branch, propose, review, and merge ontology changes
  skill               List registered versioned skills or inspect schemas and digests
  recipe              List, get, or import declarative recipe packs (S14: grants no authority)
  source              Accountable raw source inventory, mapping proposals, and admission (S03, S15)
  reconcile           Identity resolution proposals, deterministic & ML matching, reversible merge/split (S03)
  sandbox             Execute sandboxed models with fiber timeouts and verify determinism proofs
  view                Generate disposable application views with lifecycle state badges (S13)
  assurance           Dual F1/F2 release evaluation, mirror verification, and publication boundary check
  approver            Issue a cell approver session (Better Auth on the cell Postgres) for the MCP host
  mcp                 Launch Model Context Protocol (MCP) server over stdio for Claude Desktop / Cursor
  telemetry           Inspect Sentry & PostHog telemetry status, privacy scrubber, and diagnostic ping

Global Flags:
  --json              Output structured machine-readable JSON
  --db <path|url>     SQLite file path or postgresql:// URL of the cell (defaults to OPERON_DATABASE_URL, then in-memory)
  --help, -h          Print contextual help with copy-pasteable examples
  --version, -v       Print CLI version

Examples:
  operon doctor --json
  operon object put --type Pessoa --id ana --properties '{"displayName":"Ana Silva","emails":["ana@unimed.com.br"]}'
  operon object get Pessoa ana --json
  operon readiness check Pessoa ana
  operon action list --json
  operon inbox list --json
  operon audit verify --json
`);
}

const DOCTOR_HELP = `
Usage: operon doctor [--db <path>] [--json]

Examples:
  operon doctor
  operon doctor --json
  operon doctor --db ./operon.db
`;

const OBJECT_HELP = `
Usage:
  operon object get <typeId> <id> [--json] [--db <path>]
  operon object put --type <typeId> --id <id> --properties '<json>' [--version <n>] [--db <path>]
  operon object query <typeId> [id] [--valid-time <ms>] [--tx-time <ms>] [--json]
  operon object explain <typeId> <id> [--valid-time <ms>] [--tx-time <ms>] [--json]

Examples:
  operon object put --type Pessoa --id ana --properties '{"displayName":"Ana Silva","emails":["ana@unimed.com.br"]}'
  operon object get Pessoa ana --json
  operon object query Pessoa ana --valid-time 1789000000000 --json
  operon object explain Pessoa ana --valid-time 1789000000000
`;

const READINESS_HELP = `
Usage:
  operon readiness check <typeId> <id> [--json] [--db <path>]

Examples:
  operon readiness check Pessoa ana
  operon readiness check Pessoa ana --json
`;

const ACTION_HELP = `
Usage:
  operon action list [--json]
  operon action prepare <actionId> [--params '<json>' | --stdin] [--grant-id <id>] [--agent-tier <1-4>] [--json]
  operon action approve <preparedDigest> --viewed-digest <digest> [--decision approve|reject] [--reason <text>] [--json]
  operon action commit <preparedDigest> [--approval-id <id>] --idempotency-key <key> [--json]
  operon action status <operationId> [--json]
  operon action submit <actionId> [--params '<json>' | --stdin] [--agent-tier <1-4>] [--dry-run] [--json]

Examples:
  operon action list --json
  operon action prepare <actionId> --params '<json>' --agent-tier 2 --json
  operon action approve <preparedDigest> --viewed-digest <viewedDigest> --reason "Verified" --json
  operon action commit <preparedDigest> --approval-id <approvalId> --idempotency-key key-123 --json
  operon action status <operationId> --json
  operon action submit <actionId> --params '<json>' --agent-tier 4
`;

const INBOX_HELP = `
Usage:
  operon inbox list [--json]
  operon inbox approve <proposalId> --reviewer <id> --role <role> [--evidence-hash <hash>] [--override <cat> --reason <text>] [--json]
  operon inbox reject <proposalId> --reviewer <id> --role <role> --reason <text> [--json]

Examples:
  operon inbox list --json
  operon inbox approve proposal_123 --reviewer dr_li --role physician
  operon inbox approve proposal_123 --reviewer dr_li --role physician --override clinical_discretion --reason "Adjusted for fasting"
  operon inbox reject proposal_123 --reviewer chief_eng --role engineer --reason "Valve pressure excessive"
`;

const AUDIT_HELP = `
Usage:
  operon audit list [--limit <n>] [--json]
  operon audit verify [--json]

Examples:
  operon audit list --limit 10 --json
  operon audit verify
  operon audit verify --json
`;

const OMS_HELP = `
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
`;

const SANDBOX_HELP = `
Usage:
  operon sandbox verify <modelId> [--inputs '<json>'] [--iterations <n>] [--json]

Examples:
  operon sandbox verify <modelId>
  operon sandbox verify <modelId> --inputs '{"value":14.2}' --iterations 5 --json
`;

const MCP_HELP = `
Usage:
  operon mcp start [--role <consumer|builder>] [--agent-tier <1-4>] [--db <path|postgres-url>] [--workspace <id>] [--host-approver]

The server role is chosen by its trusted host. Consumer is the default and cannot modify schemas or pipelines.
Builder can prepare changes; human approval still requires an authenticated session.
Default --agent-tier is 2 (Propose). Tier 4 bounded autonomy must be set explicitly.

The approver is bound from OPERON_APPROVER_SESSION_TOKEN (see operon approver session).
Without it the server runs unbound and human decisions are refused.
A trusted application host can instead select --workspace <id> --role builder --host-approver.
The host must implement the private operon/verify-approval callback and revalidate the exact operation.
Workspace mode persists all runtime state atomically in the database, serializes writers, and starts without demo data.

Examples:
  operon mcp start
  operon mcp start --role builder --agent-tier 2 --db ./operon.db
  OPERON_APPROVER_SESSION_TOKEN=<token> operon mcp start
`;

const APPROVER_HELP = `
Usage:
  operon approver session --email <email> --name <name> [--db <postgres-url>] [--json]

Needs OPERON_DATABASE_URL (postgresql://) and OPERON_AUTH_SECRET, both written by pnpm cell:up.
Prints the session token once; hand it to the host that starts operon mcp start.

Examples:
  operon approver session --email ana@clinica.example --name "Ana"
  operon approver session --email ana@clinica.example --name "Ana" --json
`;

const TELEMETRY_HELP = `
Usage:
  operon telemetry status [--ping] [--json]

Examples:
  operon telemetry status
  operon telemetry status --ping --json
`;

const SKILL_HELP = `
Usage:
  operon skill list [--json]
  operon skill get <skillId> [--json]

Examples:
  operon skill list --json
  operon skill get operon.skill.audit-investigation
`;

const RECIPE_HELP = `
Usage:
  operon recipe list [--json]
  operon recipe get <recipeId> [--json]
  operon recipe import <path-or-builtin> [--json]

Examples:
  operon recipe list --json
  operon recipe get operon.recipe.aviation-skywise
  operon recipe import aviation-skywise --json
`;

const SOURCE_HELP = `
Usage:
  operon source ingest --locator <loc> --media-type <mime> --payload '<json>' [--idempotency-key <k>] [--tenant <t>] [--json]
  operon source list [--tenant <t>] [--json]
  operon source get <sourceId> [--tenant <t>] [--json]
  operon source propose-mapping --sources <s1,s2> --target-type <t> --pk <f> --mappings '<json>' --definition <d> [--json]
  operon source admit-mapping <proposalId> [--json]

Examples:
  operon source ingest --locator s3://lake/data.json --media-type application/json --payload '[{"id":"1"}]' --json
  operon source list --json
`;

const RECONCILE_HELP = `
Usage:
  operon reconcile propose --source-system <sys> --source-key <key> --target-canonical <id> --action <link|merge|split> --confidence <float> [--reason <str>] [--original-ids <id1,id2>] [--idempotency-key <key>] [--json]
  operon reconcile resolve <proposalId> --decision-ref <ref> [--force-override] [--idempotency-key <key>] [--json]
  operon reconcile list [--json]
  operon reconcile get <proposalId> [--json]

Examples:
  operon reconcile propose --source-system crm --source-key c_101 --target-canonical cust_999 --action merge --confidence 0.95 --json
  operon reconcile resolve prop_123 --decision-ref dec_supervisor_1 --json
  operon reconcile list --json
`;

const VIEW_HELP = `
Usage:
  operon view generate --title <title> --state <state> [--data '<json>' | --stdin] [--grant-id <id>] [--audience <aud>] [--format <format>] [--json]

Examples:
  operon view generate --title "Inbox summary" --state PROPOSED --data '{"pessoas":28}'
  operon view generate --title "Quarantine card" --state CONFIRMED --data '{"conversas":1204}' --json
`;

const ASSURANCE_HELP = `
Operon Assurance & Release Evaluation (Gate V0-F)

Usage:
  operon assurance evaluate [flags]         Run Company-in-a-Box evaluator (F1)
  operon assurance mirror [flags]           Run consented real-company mirror (F2)
  operon assurance scan [path] [flags]      Scan publication boundary for leaks
  operon assurance verify-receipt <file>    Verify Ed25519 signature on receipt

Examples:
  operon assurance evaluate --candidate cand_v0 --profile local --json
  operon assurance mirror --participant metro_health --claim observed-action --json
  operon assurance scan packages --public-only --json
  operon assurance verify-receipt receipt.json --json
`;

function executeDoctor(args: string[]): Effect.Effect<number, unknown, never> {
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx === -1 ? undefined : args[dbIdx + 1];
  return runDoctor({
    dbPath,
    json: args.includes("--json"),
  });
}

type CommandRunner = (args: string[]) => Effect.Effect<number, unknown, never>;

const COMMAND_RUNNERS = {
  action: (args) => runAction(args.slice(1)),
  approver: (args) => runApprover(args.slice(1)),
  assurance: (args) => runAssurance(args.slice(1)),
  audit: (args) => runAudit(args.slice(1)),
  doctor: (args) => executeDoctor(args),
  inbox: (args) => runInbox(args.slice(1)),
  mcp: (args) => runMcp(args.slice(1)),
  object: (args) => runObject(args.slice(1)),
  oms: (args) => runOms(args.slice(1)),
  readiness: (args) => runReadiness(args.slice(1)),
  recipe: (args) => runRecipe(args.slice(1)),
  reconcile: (args) => runReconcile(args.slice(1)),
  sandbox: (args) => runSandbox(args.slice(1)),
  skill: (args) => runSkill(args.slice(1)),
  source: (args) => runSource(args.slice(1)),
  telemetry: (args) => runTelemetry(args.slice(1)),
  view: (args) => runView(args.slice(1)),
} as const satisfies Record<string, CommandRunner>;

const COMMAND_HELP = {
  action: ACTION_HELP,
  approver: APPROVER_HELP,
  assurance: ASSURANCE_HELP,
  audit: AUDIT_HELP,
  doctor: DOCTOR_HELP,
  inbox: INBOX_HELP,
  mcp: MCP_HELP,
  object: OBJECT_HELP,
  oms: OMS_HELP,
  readiness: READINESS_HELP,
  recipe: RECIPE_HELP,
  reconcile: RECONCILE_HELP,
  sandbox: SANDBOX_HELP,
  skill: SKILL_HELP,
  source: SOURCE_HELP,
  telemetry: TELEMETRY_HELP,
  view: VIEW_HELP,
} as const satisfies Record<string, string>;

const REQUIRE_SUBCOMMAND_FOR_HELP = new Set([
  "action",
  "approver",
  "assurance",
  "audit",
  "inbox",
  "object",
  "oms",
  "readiness",
  "sandbox",
  "view",
]);

function shouldShowCommandHelp(command: string, args: string[]): boolean {
  if (args.includes("--help") || args.includes("-h")) {
    return true;
  }
  return REQUIRE_SUBCOMMAND_FOR_HELP.has(command) && args.length === 1;
}

function handleUnknownCommand(
  command: string
): Effect.Effect<number, unknown, never> {
  console.error(`Error: Unknown command '${command}'\n`);
  console.error(
    "  Available commands: doctor, object, readiness, action, inbox, audit, oms, skill, recipe, source, reconcile, sandbox, view, assurance, mcp, telemetry"
  );
  console.error("  Run 'operon --help' to see usage and examples.");
  return Effect.succeed(1);
}

function dispatchCommand(
  command: string,
  args: string[]
): Effect.Effect<number, unknown, never> {
  if (!Object.hasOwn(COMMAND_RUNNERS, command)) {
    return handleUnknownCommand(command);
  }
  // SAFETY: command existence checked via Object.hasOwn
  const cmdKey = command as keyof typeof COMMAND_RUNNERS;
  if (shouldShowCommandHelp(command, args)) {
    console.log(COMMAND_HELP[cmdKey]);
    return Effect.succeed(0);
  }
  return COMMAND_RUNNERS[cmdKey](args);
}

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

function hasFlag(args: readonly string[], flags: Set<string>): boolean {
  return args.some((a) => flags.has(a));
}

function checkEarlyExit(args: readonly string[]): number | undefined {
  if (hasFlag(args, VERSION_FLAGS)) {
    console.log("operon 0.1.0");
    return 0;
  }
  if (!args[0] || (hasFlag(args, HELP_FLAGS) && args.length === 1)) {
    printHelp();
    return 0;
  }
  return undefined;
}

export function runCli(
  argv: string[] = process.argv.slice(2)
): Effect.Effect<number, never, never> {
  const args = [...argv];
  const earlyCode = checkEarlyExit(args);
  if (earlyCode !== undefined) {
    return Effect.succeed(earlyCode);
  }

  const command = args[0] ?? "help";
  const telemetry = OperonTelemetryService.getInstance();

  return Effect.gen(function* () {
    const startTime = yield* Clock.currentTimeMillis;
    const handleCommandError = (cause: unknown) => {
      telemetry.captureError(cause, { args, command });
      return Effect.succeed(1);
    };

    const exitCode = yield* dispatchCommand(command, args).pipe(
      Effect.catch(handleCommandError)
    );

    const endTime = yield* Clock.currentTimeMillis;
    telemetry.trackEvent({
      event: "operon_cli_command",
      properties: {
        command,
        durationMs: endTime - startTime,
        exitCode,
      },
    });

    yield* Effect.promise(() => telemetry.flushAndClose());

    return exitCode;
  }).pipe(
    Effect.annotateLogs({ cliCommand: command }),
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
export * from "./commands/telemetry.js";
export * from "./commands/skill.js";
export * from "./commands/recipe.js";
export * from "./commands/source.js";
export * from "./commands/view.js";
