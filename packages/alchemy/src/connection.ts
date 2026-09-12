import { Redacted } from "effect";

/** Postgres role owning the cell database. Fixed so the URL is derivable. */
export const CELL_POSTGRES_USER = "operon";

/** The container only publishes on loopback. */
export const CELL_POSTGRES_HOST = "127.0.0.1";

const CELL_POSTGRES_PORT_BASE = 55432;

const STAGE_PORT_OFFSETS: Record<string, number> = {
  dev: 1,
  local: 0,
  prod: 3,
  staging: 2,
};

/** `operon_<stage>`; hyphens become underscores so the name is a valid identifier. */
export function cellDatabaseName(stage: string): string {
  return `operon_${stage.replaceAll("-", "_")}`;
}

/**
 * Deterministic loopback port per documented stage (55432 local, 55433 dev,
 * 55434 staging, 55435 prod). Undocumented stages hash onto 55440-55639 so
 * two ad hoc stages on one host rarely collide.
 */
export function defaultCellPostgresPort(stage: string): number {
  const offset = STAGE_PORT_OFFSETS[stage];
  if (offset !== undefined) {
    return CELL_POSTGRES_PORT_BASE + offset;
  }
  let hash = 0;
  for (const byte of new TextEncoder().encode(stage)) {
    hash = (hash * 31 + byte) % 200;
  }
  return CELL_POSTGRES_PORT_BASE + 8 + hash;
}

export interface CellDatabaseUrlInput {
  readonly database: string;
  readonly password: Redacted.Redacted<string>;
  readonly port: number;
}

/**
 * Connection string the cell runtime uses (`OPERON_DATABASE_URL`).
 * The returned value stays redacted; unwrap only when writing an env file.
 */
export function cellDatabaseUrl(
  input: CellDatabaseUrlInput
): Redacted.Redacted<string> {
  const password = encodeURIComponent(Redacted.value(input.password));
  return Redacted.make(
    `postgresql://${CELL_POSTGRES_USER}:${password}@${CELL_POSTGRES_HOST}:${input.port}/${input.database}?sslmode=disable`
  );
}

/** Same shape as {@link cellDatabaseUrl} with a placeholder instead of the secret. */
export function cellDatabaseUrlTemplate(
  database: string,
  port: number
): string {
  return `postgresql://${CELL_POSTGRES_USER}:<url-encoded-password>@${CELL_POSTGRES_HOST}:${port}/${database}?sslmode=disable`;
}
