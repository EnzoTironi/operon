import { randomBytes } from "node:crypto";

import { Redacted } from "effect";
import * as Pg from "pg";

export interface PostgresTestDatabase {
  readonly url: Redacted.Redacted<string>;
  readonly drop: () => Promise<void>;
}

/**
 * Base server for Postgres-backed tests. `vitest.global-setup.ts` starts a
 * `postgres:17-alpine` container and exports its URL here unless an
 * operator already provided one (for example the Alchemy cell).
 */
export const POSTGRES_TEST_URL_ENV = "OPERON_TEST_DATABASE_URL";

async function withAdminClient<A>(
  baseUrl: string,
  run: (client: Pg.Client) => Promise<A>
): Promise<A> {
  const client = new Pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates a throwaway database on the shared test server so test files never
 * see each other's rows. Returns `undefined` when no server is available;
 * callers skip their suite in that case.
 */
export async function createPostgresTestDatabase(): Promise<
  PostgresTestDatabase | undefined
> {
  const baseUrl = process.env[POSTGRES_TEST_URL_ENV];
  if (baseUrl === undefined || baseUrl === "") {
    return undefined;
  }
  const name = `operon_test_${randomBytes(6).toString("hex")}`;
  await withAdminClient(baseUrl, (client) =>
    client.query(`CREATE DATABASE ${name}`)
  );
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    drop: () =>
      withAdminClient(baseUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
    url: Redacted.make(url.toString()),
  };
}
