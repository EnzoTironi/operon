import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Redacted } from "effect";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { applyCellAuthSchema } from "./apply-schema.js";
import { cellPostgresConnection } from "./connection.js";

describe("cell auth schema", () => {
  it("applies Better Auth tables idempotently", async () => {
    const container = await new PostgreSqlContainer("postgres:17-alpine")
      .withDatabase("operon_local")
      .withUsername("postgres")
      .withPassword("operon-test")
      .start();
    try {
      const connection = cellPostgresConnection({
        container: container.getId(),
        database: "operon_local",
        port: container.getMappedPort(5432),
        stage: "local",
        volume: "test",
      });
      const password = Redacted.make("operon-test");
      await Effect.runPromise(applyCellAuthSchema(connection, password));
      await Effect.runPromise(applyCellAuthSchema(connection, password));
      const client = new Client({
        connectionString: container.getConnectionUri(),
      });
      await client.connect();
      const tables = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      );
      await client.end();
      const names = tables.rows.map(
        (row: { tablename: string }) => row.tablename
      );
      expect(names).toEqual(
        expect.arrayContaining([
          "account",
          "channel_auth_challenge",
          "channel_identity",
          "session",
          "user",
          "verification",
        ])
      );
    } finally {
      await container.stop();
    }
  }, 120_000);
});
