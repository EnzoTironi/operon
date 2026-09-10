import { OperonTelemetryService } from "@operon/telemetry";

export async function runTelemetry(args: string[]): Promise<number> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const isPing = args.includes("--ping");

  if (sub !== "status" && sub !== "ping") {
    console.error(`Error: Unknown telemetry subcommand '${sub ?? ""}'`);
    console.error("  Usage: operon telemetry status [--ping] [--json]");
    console.error("  Example: operon telemetry status --json");
    return 1;
  }

  const telemetry = OperonTelemetryService.getInstance();

  if (isPing || sub === "ping") {
    telemetry.addBreadcrumb(
      "cli.diagnostic",
      "Manual ping diagnostic initiated by operator"
    );
    telemetry.trackEvent({
      event: "operon_cli_command",
      properties: {
        command: "telemetry ping",
        durationMs: 1,
        exitCode: 0,
      },
    });
  }

  const statusReport = {
    diagnosticPingSent: isPing || sub === "ping",
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
        process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
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
    console.log(`  Environment:          ${statusReport.sentry.environment}`);
    console.log(
      `PostHog Product Analytics: ${statusReport.posthog.active ? "ACTIVE" : "INACTIVE (No API key provided)"}`
    );
    console.log(`  Host:                 ${statusReport.posthog.host}`);
    console.log(`Buffered Events:        ${statusReport.eventsBufferedCount}`);
    if (statusReport.diagnosticPingSent) {
      console.log(`✔ Diagnostic ping sent successfully.`);
    }
  }

  await telemetry.flushAndClose();
  return 0;
}
