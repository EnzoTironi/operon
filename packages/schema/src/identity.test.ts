import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeIdentityKey,
  deriveEmailIdentityKeys,
  identityKeyString,
  normalizeEmailAddress,
  organizationDomainOf,
} from "./identity.js";

describe("identity keys", () => {
  it("normalizes case and whitespace of an email address", () => {
    const email = normalizeEmailAddress("  Ana.Silva@Unimed.COM.br ");
    expect(Option.getOrThrow(email)).toBe("ana.silva@unimed.com.br");
  });

  it("rejects strings that are not email addresses", () => {
    expect(Option.isNone(normalizeEmailAddress("ana.silva"))).toBe(true);
    expect(Option.isNone(normalizeEmailAddress("ana@localhost"))).toBe(true);
    expect(Option.isNone(normalizeEmailAddress("a@b@c.com"))).toBe(true);
  });

  it("derives a person key and an organization key from a work address", () => {
    const keys = Option.getOrThrow(
      deriveEmailIdentityKeys("Ana.Silva@Unimed.com.br")
    );
    expect(keys).toEqual({
      organization: {
        confidence: 0.95,
        key: { kind: "domain", value: "unimed.com.br" },
        status: "derived",
      },
      person: {
        confidence: 1,
        key: { kind: "email", value: "ana.silva@unimed.com.br" },
      },
    });
  });

  it("suppresses public mail domains so they never become an organization", () => {
    const keys = Option.getOrThrow(deriveEmailIdentityKeys("ana@gmail.com"));
    expect(keys.organization).toEqual({
      domain: "gmail.com",
      status: "suppressed",
    });
    expect(keys.person.key).toEqual({ kind: "email", value: "ana@gmail.com" });
  });

  it("suppresses subdomains of a public mail domain", () => {
    const email = Option.getOrThrow(normalizeEmailAddress("x@mail.gmail.com"));
    expect(Option.isNone(organizationDomainOf(email))).toBe(true);
  });

  it("honours a caller supplied suppression list", () => {
    const email = Option.getOrThrow(
      normalizeEmailAddress("noreply@newsletter.example")
    );
    expect(
      Option.isNone(
        organizationDomainOf(email, new Set(["newsletter.example"]))
      )
    ).toBe(true);
    expect(Option.getOrThrow(organizationDomainOf(email, new Set()))).toBe(
      "newsletter.example"
    );
  });

  it("renders one canonical registry string per key kind", () => {
    const email = Option.getOrThrow(
      decodeIdentityKey({ kind: "email", value: "ana@unimed.com.br" })
    );
    const domain = Option.getOrThrow(
      decodeIdentityKey({ kind: "domain", value: "unimed.com.br" })
    );
    const sourcePk = Option.getOrThrow(
      decodeIdentityKey({
        kind: "source_pk",
        sourceSystem: "scada",
        value: "legacy-tank-A",
      })
    );
    expect(identityKeyString(email)).toBe("email:ana@unimed.com.br");
    expect(identityKeyString(domain)).toBe("domain:unimed.com.br");
    expect(identityKeyString(sourcePk)).toBe("source_pk:scada:legacy-tank-A");
  });

  it("refuses to decode an email key that is not normalized", () => {
    expect(
      Option.isNone(
        decodeIdentityKey({ kind: "email", value: "Ana@Unimed.com.br" })
      )
    ).toBe(true);
  });
});
