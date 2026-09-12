/**
 * Auth tables for the shared Better Auth instance on cell Postgres.
 * Physical names match Companion's Drizzle Better Auth 1.7.2 schema
 * (`user` / `session` / `account` / `verification`) plus channel bind tables.
 * Operon does not host `/api/auth/*`; Companion remains the interactive host.
 */
export const CELL_AUTH_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "user" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "email" text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    "image" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "phoneNumber" text,
    "phoneNumberVerified" boolean,
    CONSTRAINT "user_email_unique" UNIQUE("email"),
    CONSTRAINT "user_phoneNumber_unique" UNIQUE("phoneNumber")
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    "id" text PRIMARY KEY NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "token" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    CONSTRAINT "session_token_unique" UNIQUE("token"),
    CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
  )`,
  `CREATE TABLE IF NOT EXISTS "account" (
    "id" text PRIMARY KEY NOT NULL,
    "issuer" text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    "scope" text,
    "password" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
  )`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    "id" text PRIMARY KEY NOT NULL,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "channel_identity" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "channel" text NOT NULL,
    "installation_id" text NOT NULL,
    "sender_id" text NOT NULL,
    "user_id" text NOT NULL,
    "verified_at" timestamp with time zone DEFAULT now() NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "channel_identity_installation_key" UNIQUE("id","channel","installation_id"),
    CONSTRAINT "channel_identity_channel_check" CHECK ("channel_identity"."channel" IN ('telegram', 'kapso')),
    CONSTRAINT "channel_identity_address_check" CHECK (length(trim("channel_identity"."installation_id")) > 0 AND length(trim("channel_identity"."sender_id")) > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS "channel_auth_challenge" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "purpose" text NOT NULL,
    "token_hash" text NOT NULL,
    "browser_secret_hash" text NOT NULL,
    "target_user_id" text,
    "requesting_session_id" text,
    "channel" text NOT NULL,
    "installation_id" text NOT NULL,
    "identity_id" uuid,
    "confirmed_sender_id" text,
    "expires_at" timestamp with time zone NOT NULL,
    "confirmed_at" timestamp with time zone,
    "consumed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "channel_auth_challenge_channel_check" CHECK ("channel_auth_challenge"."channel" IN ('telegram', 'kapso') AND length(trim("channel_auth_challenge"."installation_id")) > 0),
    CONSTRAINT "channel_auth_challenge_purpose_check" CHECK (("channel_auth_challenge"."purpose" = 'login' AND "channel_auth_challenge"."target_user_id" IS NULL AND "channel_auth_challenge"."requesting_session_id" IS NULL) OR ("channel_auth_challenge"."purpose" = 'link' AND "channel_auth_challenge"."target_user_id" IS NOT NULL AND "channel_auth_challenge"."requesting_session_id" IS NOT NULL)),
    CONSTRAINT "channel_auth_challenge_hash_check" CHECK ("channel_auth_challenge"."token_hash" ~ '^[0-9a-f]{64}$' AND "channel_auth_challenge"."browser_secret_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "channel_auth_challenge_confirmation_check" CHECK (("channel_auth_challenge"."confirmed_at" IS NULL AND "channel_auth_challenge"."confirmed_sender_id" IS NULL) OR ("channel_auth_challenge"."confirmed_at" IS NOT NULL AND "channel_auth_challenge"."confirmed_sender_id" IS NOT NULL AND length(trim("channel_auth_challenge"."confirmed_sender_id")) > 0)),
    CONSTRAINT "channel_auth_challenge_consumption_check" CHECK ("channel_auth_challenge"."consumed_at" IS NULL OR ("channel_auth_challenge"."confirmed_at" IS NOT NULL AND "channel_auth_challenge"."identity_id" IS NOT NULL AND "channel_auth_challenge"."cancelled_at" IS NULL)),
    CONSTRAINT "channel_auth_challenge_expiry_check" CHECK ("channel_auth_challenge"."expires_at" > "channel_auth_challenge"."created_at")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" USING btree ("token")`,
  `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" USING btree ("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx" ON "account" USING btree ("issuer", "accountId")`,
  `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" USING btree ("userId")`,
  `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" USING btree ("identifier")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "channel_identity_sender_uidx" ON "channel_identity" USING btree ("channel","installation_id","sender_id")`,
  `CREATE INDEX IF NOT EXISTS "channel_identity_user_idx" ON "channel_identity" USING btree ("user_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "channel_auth_challenge_token_uidx" ON "channel_auth_challenge" USING btree ("token_hash")`,
  `CREATE INDEX IF NOT EXISTS "channel_auth_challenge_expiry_idx" ON "channel_auth_challenge" USING btree ("expires_at")`,
];

export function addChannelAuthForeignKeysSql(): readonly string[] {
  return [
    `DO $$ BEGIN
      ALTER TABLE "channel_identity"
        ADD CONSTRAINT "channel_identity_user_id_user_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN
      ALTER TABLE "channel_auth_challenge"
        ADD CONSTRAINT "channel_auth_challenge_target_user_id_user_id_fk"
        FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN
      ALTER TABLE "channel_auth_challenge"
        ADD CONSTRAINT "channel_auth_challenge_requesting_session_id_session_id_fk"
        FOREIGN KEY ("requesting_session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `DO $$ BEGIN
      ALTER TABLE "channel_auth_challenge"
        ADD CONSTRAINT "channel_auth_challenge_identity_fkey"
        FOREIGN KEY ("identity_id","channel","installation_id")
        REFERENCES "public"."channel_identity"("id","channel","installation_id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  ];
}
