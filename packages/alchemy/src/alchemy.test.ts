import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  CELL_AUTH_DDL,
  cellDatabaseName,
  cellPostgresConnection,
  formatCellDatabaseUrl,
  publishedPostgresPort,
} from "./index.js";

describe("@operon/alchemy cell Postgres", () => {
  it("names the cell database from the Alchemy stage", () => {
    expect(cellDatabaseName("local")).toBe("operon_local");
    expect(cellDatabaseName("feature-x")).toBe("operon_feature_x");
  });

  it("exposes loopback connection metadata without a password", () => {
    const connection = cellPostgresConnection({
      container: "operon-cell-postgres",
      database: "operon_local",
      port: 55432,
      stage: "local",
      volume: "operon-cell-pg-data",
    });
    expect(connection.host).toBe("127.0.0.1");
    expect(connection.user).toBe("postgres");
    expect(JSON.stringify(connection)).not.toMatch(/password/iu);
    expect(publishedPostgresPort({ "5432/tcp": 54321 })).toBe(54321);
  });

  it("formats DATABASE_URL from a redacted password", () => {
    const connection = cellPostgresConnection({
      container: "c",
      database: "operon_local",
      port: 5432,
      stage: "local",
      volume: "v",
    });
    const url = formatCellDatabaseUrl(connection, Redacted.make("p@ss:word"));
    expect(url).toBe(
      "postgresql://postgres:p%40ss%3Aword@127.0.0.1:5432/operon_local"
    );
  });

  it("ships Better Auth and channel bind DDL for the cell store", () => {
    const sql = CELL_AUTH_DDL.join("\n");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "user"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "session"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "account"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "verification"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "channel_identity"');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "channel_auth_challenge"'
    );
  });
});
