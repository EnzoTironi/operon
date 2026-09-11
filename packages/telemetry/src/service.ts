import * as Sentry from "@sentry/node";
import {
  Cause,
  Config,
  Data,
  Effect,
  Logger,
  Option,
  Predicate,
  Redacted,
} from "effect";
import type { Layer } from "effect";
import { PostHog } from "posthog-node";

import { TelemetryDataScrubber } from "./scrubber.js";
import type {
  OperonTelemetryEvent,
  TelemetryConfig,
  TelemetryContext,
} from "./types.js";

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

interface EnvConfig {
  readonly posthogApiKey: string | undefined;
  readonly posthogHost: string;
  readonly release: string;
  readonly sentryDsn: string | undefined;
  readonly sentryEnvironment: string;
  readonly telemetryEnabled: string | undefined;
}

function loadEnvConfig(): EnvConfig {
  return Effect.runSync(
    Effect.gen(function* () {
      const telemetryEnabled = yield* Config.string(
        "OPERON_TELEMETRY_ENABLED"
      ).pipe(Config.option);
      const sentryDsn = yield* Config.redacted("SENTRY_DSN").pipe(
        Config.orElse(() => Config.redacted("NEXT_PUBLIC_SENTRY_DSN")),
        Config.option
      );
      const posthogApiKey = yield* Config.redacted("POSTHOG_API_KEY").pipe(
        Config.orElse(() => Config.redacted("NEXT_PUBLIC_POSTHOG_KEY")),
        Config.option
      );
      const posthogHost = yield* Config.string("POSTHOG_HOST").pipe(
        Config.orElse(() => Config.string("NEXT_PUBLIC_POSTHOG_HOST")),
        Config.withDefault("https://us.i.posthog.com")
      );
      const release = yield* Config.string("OPERON_RELEASE").pipe(
        Config.withDefault("operon@0.1.0")
      );
      const sentryEnvironment = yield* Config.string("SENTRY_ENVIRONMENT").pipe(
        Config.orElse(() => Config.string("NODE_ENV")),
        Config.withDefault("development")
      );

      return {
        posthogApiKey: posthogApiKey.pipe(
          Option.map(Redacted.value),
          Option.getOrUndefined
        ),
        posthogHost,
        release,
        sentryDsn: sentryDsn.pipe(
          Option.map(Redacted.value),
          Option.getOrUndefined
        ),
        sentryEnvironment,
        telemetryEnabled: Option.getOrUndefined(telemetryEnabled),
      };
    })
  );
}

function computeTelemetryEnabled(
  envEnabled: string | undefined,
  hasCredentials: boolean,
  configEnabled?: boolean
): boolean {
  if (configEnabled !== undefined) {
    return configEnabled;
  }
  if (envEnabled === "false") {
    return false;
  }
  return envEnabled === "true" || hasCredentials;
}

interface EndpointConfig {
  readonly sentryDsn: string | undefined;
  readonly posthogApiKey: string | undefined;
  readonly posthogHost: string;
}

function resolveEndpointConfig(
  env: EnvConfig,
  config: TelemetryConfig
): EndpointConfig {
  const sentryDsn = config.sentryDsn ?? env.sentryDsn;
  const posthogApiKey = config.posthogApiKey ?? env.posthogApiKey;
  const posthogHost = config.posthogHost ?? env.posthogHost;
  return { sentryDsn, posthogApiKey, posthogHost };
}

interface EnvMeta {
  readonly release: string;
  readonly sentryEnvironment: string;
  readonly sentrySampleRate: number;
}

function resolveEnvMeta(env: EnvConfig, config: TelemetryConfig): EnvMeta {
  const release = config.release ?? env.release;
  const sentryEnvironment = config.sentryEnvironment ?? env.sentryEnvironment;
  const sentrySampleRate = config.sentrySampleRate ?? 1;
  return { release, sentryEnvironment, sentrySampleRate };
}

function buildResolvedConfig(
  env: EnvConfig,
  config: TelemetryConfig
): TelemetryConfig {
  const endpoints = resolveEndpointConfig(env, config);
  const meta = resolveEnvMeta(env, config);
  const hasCredentials = Boolean(
    endpoints.sentryDsn || endpoints.posthogApiKey
  );
  const enabled = computeTelemetryEnabled(
    env.telemetryEnabled,
    hasCredentials,
    config.enabled
  );

  return {
    enabled,
    posthogApiKey: endpoints.posthogApiKey,
    posthogHost: endpoints.posthogHost,
    release: meta.release,
    scrubKeys: config.scrubKeys,
    sentryDsn: endpoints.sentryDsn,
    sentryEnvironment: meta.sentryEnvironment,
    sentrySampleRate: meta.sentrySampleRate,
  };
}

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
    const env = loadEnvConfig();
    return buildResolvedConfig(env, config ?? {});
  }

  private initBackends(): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.config.sentryDsn && !this.sentryInitialized) {
      Effect.try(() => {
        Sentry.init({
          dsn: this.config.sentryDsn,
          environment: this.config.sentryEnvironment,
          release: this.config.release,
          tracesSampleRate: this.config.sentrySampleRate,
        });
        this.sentryInitialized = true;
      }).pipe(Effect.ignore, Effect.runSync);
    }

    const posthogApiKey = this.config.posthogApiKey;
    if (posthogApiKey && !this.posthogClient) {
      Effect.try(() => {
        this.posthogClient = new PostHog(posthogApiKey, {
          flushAt: 1,
          flushInterval: 1000,
          host: this.config.posthogHost,
        });
      }).pipe(Effect.ignore, Effect.runSync);
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
    data?: TelemetryContext
  ): void {
    if (!this.isEnabled()) {
      return;
    }

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

  captureError(cause: unknown, context?: TelemetryContext): void {
    if (!this.isEnabled()) {
      return;
    }

    const scrubbed = context ? this.scrubber.scrub(context) : undefined;
    if (this.sentryInitialized) {
      Sentry.captureException(cause, {
        extra: scrubbed,
      });
    }
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error" = "info",
    context?: TelemetryContext
  ): void {
    if (!this.isEnabled()) {
      return;
    }

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

    if (!this.isEnabled()) {
      return;
    }

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

    const posthogClient = this.posthogClient;
    if (posthogClient) {
      Effect.try(() => {
        posthogClient.capture({
          distinctId,
          event: eventPayload.event,
          properties: {
            ...scrubbedProps,
            subjectType: eventPayload.subject?.type,
          },
        });
      }).pipe(Effect.ignore, Effect.runSync);
    }
  }

  withSpan<A, E, R>(
    name: string,
    attributes: TelemetryContext,
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
              Predicate.isObject(m)
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
            cause: Cause.pretty(options.cause),
            level,
          }
        );
      }
    });

    return Logger.layer([logger, Logger.tracerLogger]);
  }

  flushAndClose(): Promise<void> {
    const sentryFlush = this.sentryInitialized
      ? Effect.tryPromise({
          catch: (cause) => cause,
          try: () => Sentry.flush(2000),
        }).pipe(Effect.ignore)
      : Effect.void;

    const posthogClient = this.posthogClient;
    const posthogShutdown = posthogClient
      ? Effect.tryPromise({
          catch: (cause) => cause,
          try: () => posthogClient.shutdown(),
        }).pipe(Effect.ignore)
      : Effect.void;

    return Effect.all([sentryFlush, posthogShutdown], {
      concurrency: 2,
    }).pipe(Effect.asVoid, Effect.runPromise);
  }
}
