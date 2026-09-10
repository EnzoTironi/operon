import { createHash } from "node:crypto";

const DEFAULT_SENSITIVE_KEYS = new Set([
  "address",
  "auth",
  "authorization",
  "card",
  "cookie",
  "creditcard",
  "dob",
  "email",
  "key",
  "mrn",
  "pass",
  "password",
  "phone",
  "private",
  "secret",
  "ssn",
  "token",
]);

export class TelemetryDataScrubber {
  private readonly sensitiveKeys: Set<string>;

  constructor(customSensitiveKeys?: readonly string[]) {
    this.sensitiveKeys = new Set(DEFAULT_SENSITIVE_KEYS);
    if (customSensitiveKeys) {
      for (const k of customSensitiveKeys) {
        this.sensitiveKeys.add(k.toLowerCase());
      }
    }
  }

  /**
   * Cryptographically pseudonymizes an identifier via SHA-256 prefix
   */
  pseudonymize(id: string): string {
    if (!id || typeof id !== "string") return id;
    const hash = createHash("sha256").update(id).digest("hex");
    return `anon_${hash.slice(0, 12)}`;
  }

  /**
   * Deeply cleans and scrubs payloads to prevent leaking PII or credentials
   */
  scrub<T>(data: T, seen = new WeakSet<object>()): T {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data !== "object") {
      return data;
    }

    if (seen.has(data as object)) {
      return "[CIRCULAR_REFERENCE]" as any;
    }
    seen.add(data as object);

    if (Array.isArray(data)) {
      return data.map((item) => this.scrub(item, seen)) as any;
    }

    const record = data as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      if (this.sensitiveKeys.has(lowerKey)) {
        scrubbed[key] = "[REDACTED]";
      } else if (typeof val === "object" && val !== null) {
        scrubbed[key] = this.scrub(val, seen);
      } else {
        scrubbed[key] = val;
      }
    }

    return scrubbed as any;
  }
}
