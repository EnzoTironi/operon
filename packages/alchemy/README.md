# @operon/alchemy

PostgreSQL 17 for an Operon cell, provisioned in Docker by [Alchemy](https://alchemy.run) (`alchemy@2.0.0-beta.76`, Effect `4.0.0-rc.112`). One stack program, one instance per `--stage`.

The stack creates three resources through the active Docker CLI context: a cached image reference (`postgres:17-alpine`), a named data volume and a running container with a healthcheck. The container publishes on `127.0.0.1` only, at a port that is fixed per stage, so the connection string is known before the container exists.

## One command

From the repository root, with Docker running:

```sh
pnpm install --frozen-lockfile
pnpm cell:up
```

`cell:up` does two things:

1. `pnpm --dir packages/alchemy env` writes the missing cell keys into the repository `.env` (ignored by git, mode `0600`): a random `OPERON_POSTGRES_PASSWORD`, a random `OPERON_AUTH_SECRET`, the stage `OPERON_POSTGRES_PORT` and the derived `OPERON_DATABASE_URL`. Keys that already exist are left alone, so the step is idempotent and you can pin your own values first.
2. `alchemy deploy --stage local --yes` reconciles the Docker resources. A second run plans `noop` for all three resources.

Wait for `docker inspect <container> --format '{{.State.Health.Status}}'` to say `healthy`, then any Operon process started with the repository `.env` (`pnpm operon ...`, `pnpm operon mcp start`) opens the cell database through `OPERON_DATABASE_URL`. The runtime applies its own DDL on connect.

`pnpm cell:down` removes the container and, except for `prod`, the data volume. `pnpm cell:plan` shows the pending diff.

## Stages

| Stage | Database | Port | Tier | Destroy retains volume |
| --- | --- | --- | --- | --- |
| `local` | `operon_local` | `55432` | ephemeral | no |
| `dev` | `operon_dev` | `55433` | ephemeral | no |
| `staging` | `operon_staging` | `55434` | shared-preprod | no |
| `prod` | `operon_prod` | `55435` | production | yes |

Pick a stage with `STAGE=dev pnpm cell:up`. Undocumented stage names get a stable port in `55440-55639` derived from the name. `OPERON_POSTGRES_PORT` overrides the port for whatever stage is deployed. The Companion (host) Postgres is a different database with a different port; the cell never shares it.

Stage policy lives in an Effect layer, `src/cell-stage.ts` (`CellStagePolicy`). Every stage runs the same resource graph; only the policy differs. Alchemy isolates state and Docker physical names per stage, so destroying one stage never touches another.

## Secrets

`OPERON_POSTGRES_PASSWORD` and `OPERON_AUTH_SECRET` live only in the repository `.env` and in Alchemy state under the ignored `packages/alchemy/.alchemy/` directory (mode `0700`, set by the package scripts). The stack output never contains them; it prints a `databaseUrlTemplate` with a placeholder instead. Do not commit `.env` and do not paste real values into docs or issues.

## State and destroy

Keep `packages/alchemy/.alchemy/` while the resources exist and use the same stage for later commands. `cell:down` on `prod` drops Alchemy tracking but retains the Docker volume (`RemovalPolicy.retain`); removing that volume is a manual operator action. The image reference is retained by the Docker provider.

## Notes

- The scripts call `node --experimental-strip-types ./node_modules/alchemy/bin/alchemy.js` so Node 22 can load `alchemy.run.ts`. The published `alchemy` launcher switches to Bun whenever the package manager path contains the substring `bun`, which is true for any `/home/ubuntu` checkout.
- Alchemy's Docker API wants `{}` for the volume props and a shell string for the healthcheck command.
- `@effect/platform-node-shared` is pinned to `4.0.0-rc.112` in the root `pnpm.overrides` so Alchemy and the workspace share one Effect.
