import { createHash } from "node:crypto";

import { Predicate } from "effect";

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

function scrubRecordProperties<T extends object>(
  data: T,
  sensitiveKeys: ReadonlySet<string>,
  seen: WeakSet<object>,
  scrubItem: <V>(v: V, s: WeakSet<object>) => V
): T {
  const copy = { ...data };
  for (const [key, val] of Object.entries(data)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      Object.assign(copy, { [key]: "[REDACTED]" });
    } else if (Predicate.isObject(val) || Array.isArray(val)) {
      Object.assign(copy, { [key]: scrubItem(val, seen) });
    }
  }
  // SAFETY: object spread retains structure with redacted sensitive keys
  return copy as T;
}

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
    if (!Predicate.isString(id) || id.length === 0) {
      return id;
    }
    const hash = createHash("sha256").update(id).digest("hex");
    return `anon_${hash.slice(0, 12)}`;
  }

  /**
   * Deeply cleans and scrubs payloads to prevent leaking PII or credentials
   */
  scrub<T>(data: T, seen = new WeakSet<object>()): T {
    if (!Predicate.isObject(data)) {
      return data;
    }

    if (seen.has(data)) {
      // SAFETY: circular reference replacement marker
      return "[CIRCULAR_REFERENCE]" as T;
    }
    seen.add(data);

    if (Array.isArray(data)) {
      // SAFETY: mapped elements retain array type
      return data.map((item) => this.scrub(item, seen)) as T;
    }

    return scrubRecordProperties(data, this.sensitiveKeys, seen, (v, s) =>
      this.scrub(v, s)
    );
  }
}
