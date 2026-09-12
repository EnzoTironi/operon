import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  cellDatabaseName,
  cellDatabaseUrl,
  cellDatabaseUrlTemplate,
  defaultCellPostgresPort,
} from "./connection.ts";
import { ensureCellEnv } from "./env-file.ts";

const secrets = {
  authSecret: Redacted.make("auth-secret"),
  postgresPassword: Redacted.make("p@ss/word"),
};

describe("cell connection policy", () => {
  it("derives operon_<stage> database names with underscores", () => {
    expect(cellDatabaseName("local")).toBe("operon_local");
    expect(cellDatabaseName("feature-x")).toBe("operon_feature_x");
  });

  it("assigns deterministic loopback ports to documented stages", () => {
    expect(defaultCellPostgresPort("local")).toBe(55432);
    expect(defaultCellPostgresPort("dev")).toBe(55433);
    expect(defaultCellPostgresPort("staging")).toBe(55434);
    expect(defaultCellPostgresPort("prod")).toBe(55435);
  });

  it("keeps ad hoc stages stable and outside the documented range", () => {
    const first = defaultCellPostgresPort("dev_enzo");
    expect(defaultCellPostgresPort("dev_enzo")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(55440);
    expect(first).toBeLessThan(55640);
  });

  it("builds the URL with the encoded password and the template with a placeholder", () => {
    const url = cellDatabaseUrl({
      database: "operon_local",
      password: Redacted.make("p@ss/word"),
      port: 55432,
    });
    expect(Redacted.value(url)).toBe(
      "postgresql://operon:p%40ss%2Fword@127.0.0.1:55432/operon_local?sslmode=disable"
    );
    expect(String(url)).not.toContain("p%40ss");
    expect(cellDatabaseUrlTemplate("operon_local", 55432)).toBe(
      "postgresql://operon:<url-encoded-password>@127.0.0.1:55432/operon_local?sslmode=disable"
    );
  });
});

describe("ensureCellEnv", () => {
  it("appends all four cell keys to an empty file", () => {
    const result = ensureCellEnv("", "local", secrets);
    expect(result.added).toEqual([
      "OPERON_POSTGRES_PASSWORD",
      "OPERON_POSTGRES_PORT",
      "OPERON_AUTH_SECRET",
      "OPERON_DATABASE_URL",
    ]);
    expect(result.content).toContain("OPERON_POSTGRES_PASSWORD=p@ss/word\n");
    expect(result.content).toContain("OPERON_POSTGRES_PORT=55432\n");
    expect(result.content).toContain("OPERON_AUTH_SECRET=auth-secret\n");
    expect(result.content).toContain(
      "OPERON_DATABASE_URL=postgresql://operon:p%40ss%2Fword@127.0.0.1:55432/operon_local?sslmode=disable\n"
    );
  });

  it("keeps existing values and derives the URL from them", () => {
    const existing =
      "SENTRY_DSN=x\nOPERON_POSTGRES_PASSWORD=keep\nOPERON_POSTGRES_PORT=6000\n";
    const result = ensureCellEnv(existing, "dev", secrets);
    expect(result.added).toEqual(["OPERON_AUTH_SECRET", "OPERON_DATABASE_URL"]);
    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.content).toContain(
      "OPERON_DATABASE_URL=postgresql://operon:keep@127.0.0.1:6000/operon_dev?sslmode=disable\n"
    );
    expect(result.content).not.toContain("p@ss/word");
  });

  it("is a no-op once the file is complete", () => {
    const first = ensureCellEnv("", "local", secrets);
    const second = ensureCellEnv(first.content, "local", secrets);
    expect(second.added).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  it("rejects an invalid configured port instead of writing a broken URL", () => {
    expect(() =>
      ensureCellEnv("OPERON_POSTGRES_PORT=notaport\n", "local", secrets)
    ).toThrow();
  });
});
