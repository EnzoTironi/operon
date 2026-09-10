import {
  OperonTelemetryService,
  TelemetryDiagnosticError,
} from "@operon/telemetry";
import { Effect } from "effect";

export function runTelemetry(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const isPing = args.includes("--ping") || sub === "ping";
    const isError = args.includes("--error") || sub === "error";

    if (
      sub !== "status" &&
      sub !== "ping" &&
      sub !== "error" &&
      sub !== undefined
    ) {
      console.error(`Error: Unknown telemetry subcommand '${sub ?? ""}'`);
      console.error(
        "  Usage: operon telemetry [status|ping|error] [--ping] [--error] [--json]"
      );
      console.error("  Example: operon telemetry status --json");
      console.error("  Example: operon telemetry ping");
      console.error("  Example: operon telemetry error");
      return 1;
    }

    const telemetry = OperonTelemetryService.getInstance();

    if (isPing) {
      yield* Effect.logInfo("Manual diagnostic ping initiated by operator");
      telemetry.addBreadcrumb(
        "cli.diagnostic",
        "Manual ping diagnostic initiated by operator"
      );
      telemetry.captureMessage("Operon CLI diagnostic ping", "info", {
        command: "telemetry ping",
        timestamp: Date.now(),
      });
      telemetry.trackEvent({
        event: "operon_cli_command",
        properties: {
          command: "telemetry ping",
          durationMs: 1,
          exitCode: 0,
        },
      });
    }

    if (isError) {
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
          timestamp: Date.now(),
        }
      );
    }

    const statusReport = {
      diagnosticErrorSent: isError,
      diagnosticPingSent: isPing,
      enabled: telemetry.isEnabled(),
      eventsBufferedCount: telemetry.getRecentEvents().length,
      posthog: {
        active: telemetry.isPostHogActive(),
        apiKeyConfigured: Boolean(
          process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY
        ),
        host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      },
      privacyScrubberActive: true,
      sentry: {
        active: telemetry.isSentryActive(),
        dsnConfigured: Boolean(
          process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
        ),
        environment:
          process.env.SENTRY_ENVIRONMENT ||
          process.env.NODE_ENV ||
          "development",
        organization: process.env.SENTRY_ORG || "zoen-1r",
        project: process.env.SENTRY_PROJECT || "operon",
      },
      timestamp: Date.now(),
    };

    if (isJson) {
      console.log(JSON.stringify(statusReport, null, 2));
    } else {
      console.log("=== OPERON PRODUCTION TELEMETRY STATUS ===");
      console.log(
        `Telemetry Enabled:      ${statusReport.enabled ? "YES" : "NO (No-op mode)"}`
      );
      console.log(`Privacy Scrubber:       ACTIVE (PII & secrets masked)`);
      console.log(
        `Sentry Error Tracking:  ${statusReport.sentry.active ? "ACTIVE" : "INACTIVE (No DSN provided)"}`
      );
      if (statusReport.sentry.active || statusReport.sentry.dsnConfigured) {
        console.log(
          `  Project:              ${statusReport.sentry.organization}/${statusReport.sentry.project}`
        );
        console.log(
          `  Environment:          ${statusReport.sentry.environment}`
        );
      }
      console.log(
        `PostHog Product Analytics: ${statusReport.posthog.active ? "ACTIVE" : "INACTIVE (No API key provided)"}`
      );
      console.log(`  Host:                 ${statusReport.posthog.host}`);
      console.log(
        `Buffered Events:        ${statusReport.eventsBufferedCount}`
      );
      if (statusReport.diagnosticPingSent) {
        console.log(`✔ Diagnostic ping sent successfully.`);
      }
      if (statusReport.diagnosticErrorSent) {
        console.log(`✔ Diagnostic test error dispatched successfully.`);
      }
    }

    yield* Effect.tryPromise({
      catch: () => undefined,
      try: () => telemetry.flushAndClose(),
    });
    return 0;
  }).pipe(
    Effect.annotateLogs({ command: "telemetry", subcommand: args[0] ?? "none" })
  );
}
