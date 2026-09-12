import { Option, Schema } from "effect";

const EMAIL_PATTERN = /^[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;
const DOMAIN_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;

/**
 * Mail domains shared by the public. A person on one of these has no
 * organization to derive; these never become an Organização.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "aol.com",
  "bol.com.br",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.com.br",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "outlook.com.br",
  "proton.me",
  "protonmail.com",
  "terra.com.br",
  "uol.com.br",
  "yahoo.com",
  "yahoo.com.br",
  "ymail.com",
]);

export function isSuppressedDomain(
  domain: string,
  suppressedDomains: ReadonlySet<string>
): boolean {
  for (const suppressed of suppressedDomains) {
    if (domain === suppressed || domain.endsWith(`.${suppressed}`)) {
      return true;
    }
  }
  return false;
}

function withPublicMailDomains(
  extraSuppressedDomains: ReadonlySet<string>
): ReadonlySet<string> {
  if (extraSuppressedDomains.size === 0) {
    return PUBLIC_MAIL_DOMAINS;
  }
  return new Set([...PUBLIC_MAIL_DOMAINS, ...extraSuppressedDomains]);
}

/**
 * Email address already normalized: trimmed, lower-cased, one `@`, dotted domain.
 * Build one with `normalizeEmailAddress`; never cast a raw string.
 */
export const EmailAddress = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isLowercased(),
    Schema.isPattern(EMAIL_PATTERN)
  ),
  Schema.brand("EmailAddress")
);
export type EmailAddress = typeof EmailAddress.Type;

/**
 * Lower-cased mail domain that may identify an organization.
 * Public mail domains are unrepresentable here; do not cast a raw string.
 */
export const OrganizationDomain = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isLowercased(),
    Schema.isPattern(DOMAIN_PATTERN),
    Schema.makeFilter((domain: string) =>
      isSuppressedDomain(domain, PUBLIC_MAIL_DOMAINS)
        ? "public mail domains never identify an organization"
        : undefined
    )
  ),
  Schema.brand("OrganizationDomain")
);
export type OrganizationDomain = typeof OrganizationDomain.Type;

export const EmailIdentityKey = Schema.Struct({
  kind: Schema.Literal("email"),
  value: EmailAddress,
});
export type EmailIdentityKey = typeof EmailIdentityKey.Type;

export const DomainIdentityKey = Schema.Struct({
  kind: Schema.Literal("domain"),
  value: OrganizationDomain,
});
export type DomainIdentityKey = typeof DomainIdentityKey.Type;

export const SourcePkIdentityKey = Schema.Struct({
  kind: Schema.Literal("source_pk"),
  sourceSystem: Schema.String,
  value: Schema.String,
});
export type SourcePkIdentityKey = typeof SourcePkIdentityKey.Type;

/**
 * Identity resolution key. N keys resolve to one canonical id.
 */
export const IdentityKey = Schema.Union([
  EmailIdentityKey,
  DomainIdentityKey,
  SourcePkIdentityKey,
]);
export type IdentityKey = typeof IdentityKey.Type;

export const decodeIdentityKey = Schema.decodeUnknownOption(IdentityKey);

/**
 * Canonical string form used as registry key: `email:ana@unimed.com.br`,
 * `domain:unimed.com.br`, `source_pk:scada:legacy-tank-a`.
 */
export function identityKeyString(key: IdentityKey): string {
  switch (key.kind) {
    case "email": {
      return `email:${key.value}`;
    }
    case "domain": {
      return `domain:${key.value}`;
    }
    case "source_pk": {
      return `source_pk:${key.sourceSystem}:${key.value}`;
    }
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/**
 * Confidence a deterministic key match carries into identity resolution.
 * Exact email is identity. A non-public domain is a strong organization signal.
 */
export const IDENTITY_KEY_CONFIDENCE = {
  domain: 0.95,
  email: 1,
} as const;

const decodeEmailAddress = Schema.decodeUnknownOption(EmailAddress);
const decodeOrganizationDomain = Schema.decodeUnknownOption(OrganizationDomain);

/**
 * Normalizes a raw address (trim, lower-case) and validates it.
 * Returns none when the input is not an email address.
 */
export function normalizeEmailAddress(
  raw: string
): Option.Option<EmailAddress> {
  return decodeEmailAddress(raw.trim().toLowerCase());
}

/**
 * Domain part of a normalized email, unless it is a public mail domain or
 * in the extra suppression list. Public domains cannot be opted out of.
 */
export function organizationDomainOf(
  email: EmailAddress,
  extraSuppressedDomains: ReadonlySet<string> = new Set()
): Option.Option<OrganizationDomain> {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (
    isSuppressedDomain(domain, withPublicMailDomains(extraSuppressedDomains))
  ) {
    return Option.none();
  }
  return decodeOrganizationDomain(domain);
}

export const OrganizationDerivation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("derived"),
    key: DomainIdentityKey,
    confidence: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("suppressed"),
    domain: Schema.String,
  }),
]);
export type OrganizationDerivation = typeof OrganizationDerivation.Type;

/**
 * Identity keys an email address yields: one person key, and either an
 * organization key or the reason it was suppressed.
 */
export const EmailIdentityKeys = Schema.Struct({
  person: Schema.Struct({
    key: EmailIdentityKey,
    confidence: Schema.Number,
  }),
  organization: OrganizationDerivation,
});
export type EmailIdentityKeys = typeof EmailIdentityKeys.Type;

export function deriveEmailIdentityKeys(
  raw: string,
  extraSuppressedDomains: ReadonlySet<string> = new Set()
): Option.Option<EmailIdentityKeys> {
  return Option.map(normalizeEmailAddress(raw), (email) => {
    const organization: OrganizationDerivation = Option.match(
      organizationDomainOf(email, extraSuppressedDomains),
      {
        onNone: () => ({
          domain: email.slice(email.lastIndexOf("@") + 1),
          status: "suppressed" as const,
        }),
        onSome: (domain) => ({
          confidence: IDENTITY_KEY_CONFIDENCE.domain,
          key: { kind: "domain" as const, value: domain },
          status: "derived" as const,
        }),
      }
    );
    return {
      organization,
      person: {
        confidence: IDENTITY_KEY_CONFIDENCE.email,
        key: { kind: "email" as const, value: email },
      },
    };
  });
}
