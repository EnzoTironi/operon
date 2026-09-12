import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const URL_ENV = "OPERON_TEST_DATABASE_URL";

/**
 * Starts one PostgreSQL 17 container for the whole test run and hands its URL
 * to the workers through `OPERON_TEST_DATABASE_URL`. An operator-provided
 * URL wins, so the suite can also run against the Alchemy cell. Without
 * Docker the Postgres suites skip locally and fail in CI.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env[URL_ENV]) {
    return () => Promise.resolve();
  }

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  } catch (error) {
    if (process.env.CI) {
      throw error;
    }
    process.stderr.write(
      `[cell-auth tests] Postgres suites skipped: no Docker runtime (${String(error)})\n`
    );
    return () => Promise.resolve();
  }

  process.env[URL_ENV] = container.getConnectionUri();
  return () => container.stop().then(() => undefined);
}
