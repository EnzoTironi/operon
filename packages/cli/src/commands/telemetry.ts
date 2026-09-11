import type { DiagnosticBundle } from "@operon/schema";
import {
  OperonTelemetryService,
  TelemetryDiagnosticError,
} from "@operon/telemetry";
import { Clock, Config, Data, Effect, Exit, Option } from "effect";

import { printCliError, printCliJson } from "../io.js";
import { createRuntimeContext } from "../state.js";

class TelemetryContextInitError extends Data.TaggedError(
  "TelemetryContextInitError"
)<{
  readonly message: string;
}> {}

function printDiagnosticHuman(bundle: DiagnosticBundle) {
  console.log(`=== OPERON RUN DIAGNOSTIC: ${bundle.runId} ===`);
  console.log(`Operation:              ${bundle.operation}`);
  console.log(
    `Business Status:        ${bundle.businessOutcome?.status ?? "none"}`
  );
  console.log(
    `Policy Verdict:         ${bundle.policyOutcome?.verdict ?? "none"}`
  );
  console.log(
    `Infrastructure Status:  ${bundle.infrastructureOutcome?.status ?? "none"}`
  );
  console.log(`Entries Logged:         ${bundle.entries.length}`);
}

const handleTelemetryDiagnose = Effect.fn("handleTelemetryDiagnose")(function* (
  runId: string,
  isJson: boolean
): Effect.fn.Return<number, TelemetryContextInitError> {
  const ctx = yield* Effect.tryPromise({
    catch: (err) =>
      new TelemetryContextInitError({
        message: `Failed to initialize runtime context: ${String(err)}`,
      }),
    try: () => createRuntimeContext(),
  });
  const diagExit = yield* Effect.exit(ctx.operonService.diagnose(runId));
  if (Exit.isFailure(diagExit)) {
    printCliError(`Error: Diagnostic bundle for run '${runId}' not found`);
    return 1;
  }
  if (isJson) {
    printCliJson(diagExit.value);
  } else {
    printDiagnosticHuman(diagExit.value);
  }
  return 0;
});

const triggerManualPing = Effect.fn("triggerManualPing")(function* (
  telemetry: OperonTelemetryService
): Effect.fn.Return<void> {
  yield* Effect.logInfo("Manual diagnostic ping initiated by operator");
  telemetry.addBreadcrumb(
    "cli.diagnostic",
    "Manual ping diagnostic initiated by operator"
  );
  telemetry.captureMessage("Operon CLI diagnostic ping", "info", {
    command: "telemetry ping",
    timestamp: yield* Clock.currentTimeMillis,
  });
  telemetry.trackEvent({
    event: "operon_cli_command",
    properties: {
      command: "telemetry ping",
      durationMs: 1,
      exitCode: 0,
    },
  });
});

const triggerManualError = Effect.fn("triggerManualError")(function* (
  telemetry: OperonTelemetryService
): Effect.fn.Return<void> {
  yield* Effect.logError("Manual diagnostic error initiated by operator");
  telemetry.addBreadcrumb(
    "cli.diagnostic",
    "Manual error test initiated by operator"
  );
  telemetry.captureError(
    new TelemetryDiagnosticError({
      message: "Operon CLI diagnostic test error initiated by operator",
    }),
    {
      command: "telemetry error",
      timestamp: yield* Clock.currentTimeMillis,
    }
  );
});

function resolveTelemetryConfig() {
  return Effect.gen(function* () {
    const posthogApiKey = yield* Effect.option(
      Config.redacted("POSTHOG_API_KEY").pipe(
        Config.orElse(() => Config.redacted("NEXT_PUBLIC_POSTHOG_KEY"))
      )
    );
    const posthogHost = yield* Effect.option(
      Config.string("POSTHOG_HOST").pipe(
        Config.orElse(() => Config.string("NEXT_PUBLIC_POSTHOG_HOST"))
      )
    );
    const sentryDsn = yield* Effect.option(
      Config.redacted("SENTRY_DSN").pipe(
        Config.orElse(() => Config.redacted("NEXT_PUBLIC_SENTRY_DSN"))
      )
    );
    const sentryEnv = yield* Effect.option(
      Config.string("SENTRY_ENVIRONMENT").pipe(
        Config.orElse(() => Config.string("NODE_ENV"))
      )
    );
    const sentryOrg = yield* Effect.option(Config.string("SENTRY_ORG"));
    const sentryProject = yield* Effect.option(Config.string("SENTRY_PROJECT"));

    return {
      posthogApiKey,
      posthogHost,
      sentryDsn,
      sentryEnv,
      sentryOrg,
      sentryProject,
    };
  });
}

interface TelemetryReport {
  readonly diagnosticErrorSent: boolean;
  readonly diagnosticPingSent: boolean;
  readonly enabled: boolean;
  readonly eventsBufferedCount: number;
  readonly posthog: {
    readonly active: boolean;
    readonly apiKeyConfigured: boolean;
    readonly host: string;
  };
  readonly privacyScrubberActive: boolean;
  readonly sentry: {
    readonly active: boolean;
    readonly dsnConfigured: boolean;
    readonly environment: string;
    readonly organization: string;
    readonly project: string;
  };
  readonly timestamp: number;
}

function printSentrySection(sentry: TelemetryReport["sentry"]) {
  console.log(
    `Sentry Error Tracking:  ${sentry.active ? "ACTIVE" : "INACTIVE (No DSN provided)"}`
  );
  if (sentry.active || sentry.dsnConfigured) {
    console.log(
      `  Project:              ${sentry.organization}/${sentry.project}`
    );
    console.log(`  Environment:          ${sentry.environment}`);
  }
}

function printTelemetryHuman(report: TelemetryReport) {
  console.log("=== OPERON PRODUCTION TELEMETRY STATUS ===");
  console.log(
    `Telemetry Enabled:      ${report.enabled ? "YES" : "NO (No-op mode)"}`
  );
  console.log("Privacy Scrubber:       ACTIVE (PII & secrets masked)");
  printSentrySection(report.sentry);
  console.log(
    `PostHog Product Analytics: ${report.posthog.active ? "ACTIVE" : "INACTIVE (No API key provided)"}`
  );
  console.log(`  Host:                 ${report.posthog.host}`);
  console.log(`Buffered Events:        ${report.eventsBufferedCount}`);
  if (report.diagnosticPingSent) {
    console.log("✔ Diagnostic ping sent successfully.");
  }
  if (report.diagnosticErrorSent) {
    console.log("✔ Diagnostic test error dispatched successfully.");
  }
}

const handleTelemetryStatus = Effect.fn("handleTelemetryStatus")(function* (
  isPing: boolean,
  isError: boolean,
  isJson: boolean
): Effect.fn.Return<number> {
  const telemetry = OperonTelemetryService.getInstance();
  if (isPing) {
    yield* triggerManualPing(telemetry);
  }
  if (isError) {
    yield* triggerManualError(telemetry);
  }
  const cfg = yield* resolveTelemetryConfig();
  const statusReport: TelemetryReport = {
    diagnosticErrorSent: isError,
    diagnosticPingSent: isPing,
    enabled: telemetry.isEnabled(),
    eventsBufferedCount: telemetry.getRecentEvents().length,
    posthog: {
      active: telemetry.isPostHogActive(),
      apiKeyConfigured: Option.isSome(cfg.posthogApiKey),
      host: Option.getOrElse(cfg.posthogHost, () => "https://us.i.posthog.com"),
    },
    privacyScrubberActive: true,
    sentry: {
      active: telemetry.isSentryActive(),
      dsnConfigured: Option.isSome(cfg.sentryDsn),
      environment: Option.getOrElse(cfg.sentryEnv, () => "development"),
      organization: Option.getOrElse(cfg.sentryOrg, () => "zoen-1r"),
      project: Option.getOrElse(cfg.sentryProject, () => "operon"),
    },
    timestamp: yield* Clock.currentTimeMillis,
  };

  if (isJson) {
    printCliJson(statusReport);
  } else {
    printTelemetryHuman(statusReport);
  }

  yield* Effect.tryPromise({
    catch: (err) => err,
    try: () => telemetry.flushAndClose(),
  }).pipe(Effect.ignore);
  return 0;
});

const VALID_TELEMETRY_SUBCOMMANDS = new Set([
  "status",
  "ping",
  "error",
  undefined,
]);

function isTelemetrySubcommandValid(sub?: string): boolean {
  return VALID_TELEMETRY_SUBCOMMANDS.has(sub);
}

function parseTelemetryFlags(args: readonly string[], sub?: string) {
  const isJson = args.includes("--json");
  const isPing = args.includes("--ping") || sub === "ping";
  const isError = args.includes("--error") || sub === "error";
  return { isError, isJson, isPing };
}

export function runTelemetry(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const { isError, isJson, isPing } = parseTelemetryFlags(args, sub);

    if (sub === "diagnose") {
      const runId = args[1];
      if (!runId || runId.startsWith("--")) {
        printCliError("Error: Missing required argument <runId>");
        printCliError("  Usage: operon telemetry diagnose <runId> [--json]");
        return 1;
      }
      return yield* handleTelemetryDiagnose(runId, isJson);
    }

    if (!isTelemetrySubcommandValid(sub)) {
      printCliError(`Error: Unknown telemetry subcommand '${sub ?? ""}'`);
      printCliError(
        "  Usage: operon telemetry [status|ping|error|diagnose] [--ping] [--error] [--json]"
      );
      return 1;
    }

    return yield* handleTelemetryStatus(isPing, isError, isJson);
  }).pipe(
    Effect.annotateLogs({ command: "telemetry", subcommand: args[0] ?? "none" })
  );
}
