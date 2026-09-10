# @operon/telemetry

Production observability, telemetry, and distributed tracing for **Operon**, integrating **Sentry** and **PostHog** with native **Effect 4.0.0-rc.112** workflows and zero-leak privacy controls.

---

## Features

- **Distributed Tracing**: Wrap Effect operations in named tracing spans via `telemetry.withSpan(name, attributes, effect)`.
- **Product Dogfooding & Analytics**: Track governed action submission, execution, human safety vetoes, and inbox overrides via PostHog.
- **Automated PII & Secret Redaction**: The `TelemetryDataScrubber` scans and sanitizes sensitive fields (`password`, `token`, `secret`, `ssn`, `mrn`, `dob`, `address`, `creditcard`, `authorization`, etc.) before any payload leaves the process.
- **Cryptographic Pseudonymization**: Entity IDs (e.g. `patientId`, `mrn`) are deterministically pseudonymized with truncated SHA-256 hashes (`anon_${hash.slice(0, 12)}`).
- **Circular Reference Immunity**: Protects payload serializers from infinite recursion using `WeakSet` instance tracking.
- **Native Effect Logger Layer**: Forward all `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError` events directly to Sentry breadcrumbs/errors and PostHog via `service.getLoggerLayer()`.
- **Fail-Safe Offline Mode**: Operates in zero-overhead no-op mode when credentials are missing, maintaining an in-memory ring buffer of recent events for local diagnostics and CLI inspection.

---

## Environment Variables

| Variable | Description | Default |
| :-- | :-- | :-- |
| `SENTRY_DSN` | Sentry project DSN for error and span capture | _None (no-op)_ |
| `SENTRY_ENVIRONMENT` | Deployment environment (`production`, `staging`, `development`) | `development` |
| `POSTHOG_API_KEY` | PostHog project API key for event telemetry | _None (no-op)_ |
| `POSTHOG_HOST` | PostHog ingestion host endpoint | `https://us.i.posthog.com` |
| `OPERON_TELEMETRY_ENABLED` | Global kill switch (`true` / `false`) | `true` |

---

## Usage

### 1. Initializing Service

```typescript
import { OperonTelemetryService } from "@operon/telemetry";

const telemetry = OperonTelemetryService.getInstance({
  dsn: process.env.SENTRY_DSN,
  posthogApiKey: process.env.POSTHOG_API_KEY,
  environment: "production",
});
```

### 2. Tracing an Effect Workflow

```typescript
import { Effect } from "effect";
import { OperonTelemetryService } from "@operon/telemetry";

const telemetry = OperonTelemetryService.getInstance();

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Executing clinical calculation");
  return 42;
});

const traced = telemetry.withSpan(
  "clinical.calc",
  { patientId: "P001" },
  program
);
await Effect.runPromise(traced);
```

### 3. Effect Logger Integration

```typescript
import { Effect } from "effect";
import { OperonTelemetryService } from "@operon/telemetry";

const telemetry = OperonTelemetryService.getInstance();

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Operation completed successfully");
}).pipe(Effect.provide(telemetry.getLoggerLayer()));
```

### 4. Tracking Events & Capturing Errors

```typescript
// Event tracking
telemetry.trackEvent({
  event: "operon_action_submitted",
  properties: {
    actionId: "adjust_dose",
    agentTier: 2,
    riskTier: "high",
  },
});

// Error capture
try {
  riskyOperation();
} catch (error) {
  telemetry.captureError(error, { context: "inbox_review" });
}
```
