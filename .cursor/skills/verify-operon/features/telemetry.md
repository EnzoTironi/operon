# F-08: Production Telemetry & Enterprise Observability

Operon includes enterprise-grade observability and product dogfooding instrumentation via `@operon/telemetry`, combining **Sentry** (distributed tracing, span tracking, and forensic error capture) and **PostHog** (product analytics, action execution funnels, and agent behavior tracking) with automated zero-leak privacy controls.

---

## Sub-features

1. **Telemetry Status Inspection**: Inspects Sentry and PostHog connection status, environment tags, and buffered event count.
2. **Diagnostic Ping**: Emits an end-to-end breadcrumb and operational telemetry event without mutating persistent state.
3. **Automated PII & Secret Redaction**: Intercepts passwords, tokens, API keys, medical record numbers (MRNs), and SSNs.
4. **Deterministic Pseudonymization**: Hashes sensitive entity IDs using truncated SHA-256 digests (`anon_${hash.slice(0, 12)}`).
5. **Effect Native Logger Forwarding**: Captures `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError` directly into Sentry breadcrumbs and errors.
6. **No-Op Fallback Mode**: Gracefully operates without throwing or degrading performance when credentials are omitted.

---

## How to get to it (user POV)

- **Operators**: Run `operon telemetry status` to verify telemetry sink readiness and diagnostic counts.
- **Developers / DevOps**: Configure `SENTRY_DSN` and `POSTHOG_API_KEY` in environment files.
- **CI / CD**: Execute `operon telemetry status --ping --json` as part of health and deployment checks.

---

## Driving it with operon CLI

### Human-Readable Inspection

```bash
node packages/cli/dist/bin.js telemetry status
```

**Expected Output:**

```text
=== OPERON PRODUCTION TELEMETRY STATUS ===
Telemetry Enabled:      YES
Privacy Scrubber:       ACTIVE (PII & secrets masked)
Sentry Error Tracking:  INACTIVE (No DSN provided)
  Environment:          development
PostHog Product Analytics: INACTIVE (No API key provided)
  Host:                 https://us.i.posthog.com
Buffered Events:        0
```

### JSON Diagnostic Ping

```bash
node packages/cli/dist/bin.js telemetry status --ping --json
```

**Expected JSON Shape:**

```json
{
  "diagnosticPingSent": true,
  "enabled": false,
  "eventsBufferedCount": 1,
  "posthog": {
    "active": false,
    "apiKeyConfigured": false,
    "host": "https://us.i.posthog.com"
  },
  "privacyScrubberActive": true,
  "sentry": {
    "active": false,
    "dsnConfigured": false,
    "environment": "development"
  },
  "timestamp": 1789051800000
}
```

---

## Gotchas

1. **Fail-Safe Fallback**: When `SENTRY_DSN` or `POSTHOG_API_KEY` are not set, telemetry defaults to a local in-memory ring buffer (up to 100 recent events) rather than throwing or failing CLI executions.
2. **Safe Shutdown**: The CLI flushes telemetry via `flushAndClose()` on exit with a 2-second timeout guard to prevent hung processes in serverless or CI environments.
