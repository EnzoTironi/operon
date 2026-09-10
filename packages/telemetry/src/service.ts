import * as Sentry from "@sentry/node";
import { Data, Effect, Logger } from "effect";
import type { Layer } from "effect";
import { PostHog } from "posthog-node";

import { TelemetryDataScrubber } from "./scrubber.js";
import type { OperonTelemetryEvent, TelemetryConfig } from "./types.js";

export class TelemetryLogCapturedError extends Data.TaggedError(
  "TelemetryLogCapturedError"
)<{
  readonly message: string;
  readonly level: string;
}> {}

export class TelemetryDiagnosticError extends Data.TaggedError(
  "TelemetryDiagnosticError"
)<{
  readonly message: string;
}> {}

export class OperonTelemetryService {
  private static instance: OperonTelemetryService | null = null;

  private config: TelemetryConfig;
  private readonly scrubber: TelemetryDataScrubber;
  private sentryInitialized = false;
  private posthogClient: PostHog | null = null;
  private readonly capturedEvents: OperonTelemetryEvent[] = [];

  constructor(config?: TelemetryConfig) {
    this.config = this.resolveConfig(config);
    this.scrubber = new TelemetryDataScrubber(this.config.scrubKeys);
    this.initBackends();
  }

  static getInstance(config?: TelemetryConfig): OperonTelemetryService {
    if (!OperonTelemetryService.instance) {
      OperonTelemetryService.instance = new OperonTelemetryService(config);
    }
    return OperonTelemetryService.instance;
  }

  static resetInstance(): void {
    if (OperonTelemetryService.instance) {
      void OperonTelemetryService.instance.flushAndClose();
      OperonTelemetryService.instance = null;
    }
  }

  private resolveConfig(config?: TelemetryConfig): TelemetryConfig {
    const isExplicitlyDisabled =
      process.env.OPERON_TELEMETRY_ENABLED === "false";
    const isExplicitlyEnabled = process.env.OPERON_TELEMETRY_ENABLED === "true";

    const sentryDsn =
      config?.sentryDsn ||
      process.env.SENTRY_DSN ||
      process.env.NEXT_PUBLIC_SENTRY_DSN;
    const posthogApiKey =
      config?.posthogApiKey ||
      process.env.POSTHOG_API_KEY ||
      process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const posthogHost =
      config?.posthogHost ||
      process.env.POSTHOG_HOST ||
      process.env.NEXT_PUBLIC_POSTHOG_HOST ||
      "https://us.i.posthog.com";

    const hasCredentials = Boolean(sentryDsn || posthogApiKey);
    const enabled =
      config?.enabled ??
      (!isExplicitlyDisabled && (isExplicitlyEnabled || hasCredentials));

    return {
      enabled,
      posthogApiKey,
      posthogHost,
      release: config?.release || process.env.OPERON_RELEASE || "operon@0.1.0",
      scrubKeys: config?.scrubKeys,
      sentryDsn,
      sentryEnvironment:
        config?.sentryEnvironment ||
        process.env.SENTRY_ENVIRONMENT ||
        process.env.NODE_ENV ||
        "development",
      sentrySampleRate: config?.sentrySampleRate ?? 1,
    };
  }

  private initBackends(): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.config.sentryDsn && !this.sentryInitialized) {
      try {
        Sentry.init({
          dsn: this.config.sentryDsn,
          environment: this.config.sentryEnvironment,
          release: this.config.release,
          tracesSampleRate: this.config.sentrySampleRate,
        });
        this.sentryInitialized = true;
      } catch {
        // Fail-safe: Sentry init failure should never crash application
      }
    }

    if (this.config.posthogApiKey && !this.posthogClient) {
      try {
        this.posthogClient = new PostHog(this.config.posthogApiKey, {
          flushAt: 1,
          flushInterval: 1000,
          host: this.config.posthogHost,
        });
      } catch {
        // Fail-safe: PostHog init failure should never crash application
      }
    }
  }

  isEnabled(): boolean {
    return Boolean(this.config.enabled);
  }

  isSentryActive(): boolean {
    return this.sentryInitialized;
  }

  isPostHogActive(): boolean {
    return Boolean(this.posthogClient);
  }

  getScrubber(): TelemetryDataScrubber {
    return this.scrubber;
  }

  getRecentEvents(): readonly OperonTelemetryEvent[] {
    return [...this.capturedEvents];
  }

  addBreadcrumb(
    category: string,
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (!this.isEnabled()) return;

    const scrubbed = data ? this.scrubber.scrub(data) : undefined;
    if (this.sentryInitialized) {
      Sentry.addBreadcrumb({
        category,
        data: scrubbed,
        level: "info",
        message,
      });
    }
  }

  captureError(error: unknown, context?: Record<string, unknown>): void {
    if (!this.isEnabled()) return;

    const scrubbed = context ? this.scrubber.scrub(context) : undefined;
    if (this.sentryInitialized) {
      Sentry.captureException(error, {
        extra: scrubbed,
      });
    }
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error" = "info",
    context?: Record<string, unknown>
  ): void {
    if (!this.isEnabled()) return;

    const scrubbed = context ? this.scrubber.scrub(context) : undefined;
    if (this.sentryInitialized) {
      Sentry.captureMessage(message, {
        extra: scrubbed,
        level,
      });
    }
  }

  trackEvent(eventPayload: OperonTelemetryEvent): void {
    // Keep in-memory ring buffer (up to 100 items for dogfooding / verification checks)
    this.capturedEvents.push(eventPayload);
    if (this.capturedEvents.length > 100) {
      this.capturedEvents.shift();
    }

    if (!this.isEnabled()) return;

    const scrubbedProps = this.scrubber.scrub(eventPayload.properties);
    const distinctId = eventPayload.subject
      ? eventPayload.subject.id
      : "operon_system";

    if (this.sentryInitialized) {
      Sentry.addBreadcrumb({
        category: "operon.telemetry",
        data: scrubbedProps,
        level: "info",
        message: eventPayload.event,
      });
    }

    if (this.posthogClient) {
      try {
        this.posthogClient.capture({
          distinctId,
          event: eventPayload.event,
          properties: {
            ...scrubbedProps,
            subjectType: eventPayload.subject?.type,
          },
        });
      } catch {
        // Fail-safe
      }
    }
  }

  withSpan<A, E, R>(
    name: string,
    attributes: Record<string, unknown>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> {
    const scrubbed = this.scrubber.scrub(attributes);
    this.addBreadcrumb("span.start", `Starting operation ${name}`, scrubbed);

    return effect.pipe(
      Effect.withSpan(name, { attributes: scrubbed }),
      Effect.tapError((failure) =>
        Effect.sync(() => {
          this.captureError(failure, { span: name, ...scrubbed });
        })
      )
    );
  }

  /**
   * Provides an Effect Logger layer that routes Effect.log* calls
   * into Sentry breadcrumbs/errors and telemetry tracking.
   */
  getLoggerLayer(): Layer.Layer<never, never, never> {
    const logger = Logger.make((options) => {
      const level = options.logLevel;
      const rawMsg = options.message;
      const msg = Array.isArray(rawMsg)
        ? rawMsg
            .map((m) =>
              typeof m === "object" && m !== null
                ? JSON.stringify(this.scrubber.scrub(m))
                : String(m)
            )
            .join(" ")
        : String(rawMsg);

      this.addBreadcrumb(`effect.log.${level.toLowerCase()}`, msg);
      if (level === "Error" || level === "Fatal") {
        this.captureError(
          new TelemetryLogCapturedError({ level, message: msg }),
          {
            cause: options.cause,
            level,
          }
        );
      }
    });

    return Logger.layer([logger, Logger.tracerLogger]);
  }

  async flushAndClose(): Promise<void> {
    if (this.sentryInitialized) {
      try {
        await Sentry.flush(2000);
      } catch {
        // Ignore Sentry flush errors on shutdown
      }
    }

    if (this.posthogClient) {
      try {
        await this.posthogClient.shutdown();
      } catch {
        // Ignore PostHog shutdown errors on shutdown
      }
    }
  }
}
