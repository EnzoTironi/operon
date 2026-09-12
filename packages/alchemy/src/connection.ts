import { Redacted } from "effect";

export interface CellPostgresConnection {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly database: string;
  readonly user: "postgres";
  readonly container: string;
  readonly volume: string;
  readonly stage: string;
}

export function publishedPostgresPort(
  ports: Readonly<Record<string, number>>
): number | undefined {
  return ports["5432/tcp"];
}

export function cellPostgresConnection(input: {
  readonly stage: string;
  readonly database: string;
  readonly container: string;
  readonly volume: string;
  readonly port: number;
}): CellPostgresConnection {
  return {
    container: input.container,
    database: input.database,
    host: "127.0.0.1",
    port: input.port,
    stage: input.stage,
    user: "postgres",
    volume: input.volume,
  };
}

/**
 * Builds a loopback URL. The password is never stored on {@link CellPostgresConnection}.
 */
export function formatCellDatabaseUrl(
  connection: CellPostgresConnection,
  password: Redacted.Redacted<string>
): string {
  const encoded = encodeURIComponent(Redacted.value(password));
  return `postgresql://${connection.user}:${encoded}@${connection.host}:${connection.port}/${connection.database}`;
}
