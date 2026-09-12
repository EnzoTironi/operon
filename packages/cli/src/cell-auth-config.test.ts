import { Effect, Option, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  APPROVER_SESSION_TOKEN_ENV,
  SESSION_TOKEN_ENV,
  readApproverSessionToken,
} from "./cell-auth-config.js";

afterEach(() => {
  process.env.OPERON_SESSION = "";
  process.env.OPERON_APPROVER_SESSION_TOKEN = "";
});

describe("readApproverSessionToken", () => {
  it("reads Companion Better Auth session.token from OPERON_SESSION", async () => {
    process.env[SESSION_TOKEN_ENV] = "Bearer companion-session";
    const token = await Effect.runPromise(readApproverSessionToken());
    expect(Option.isSome(token)).toBe(true);
    if (Option.isSome(token)) {
      expect(Redacted.value(token.value)).toBe("companion-session");
    }
  });

  it("accepts the legacy OPERON_APPROVER_SESSION_TOKEN alias", async () => {
    process.env[APPROVER_SESSION_TOKEN_ENV] = "legacy-session";
    const token = await Effect.runPromise(readApproverSessionToken());
    expect(Option.isSome(token)).toBe(true);
    if (Option.isSome(token)) {
      expect(Redacted.value(token.value)).toBe("legacy-session");
    }
  });

  it("fails when OPERON_SESSION and the alias name different tokens", async () => {
    process.env[SESSION_TOKEN_ENV] = "companion-session";
    process.env[APPROVER_SESSION_TOKEN_ENV] = "other-session";
    const exit = await Effect.runPromiseExit(readApproverSessionToken());
    expect(exit._tag).toBe("Failure");
  });
});
