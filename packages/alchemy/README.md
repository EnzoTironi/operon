# @operon/alchemy

Alchemy program that brings up **cell Postgres 17** in Docker. Companion is the only interactive Better Auth host. This package provisions the database those sessions live in. It does not serve `/api/auth/*`.

The previous Cloudflare Worker / D1 / R2 / Queue manifest is gone. Nothing in the workspace consumed it.

## Operator

From the repository root, with Docker running:

```sh
cp packages/alchemy/.env.example packages/alchemy/.env
chmod 600 packages/alchemy/.env
```

Set `OPERON_POSTGRES_PASSWORD` in `packages/alchemy/.env` (name only in git, never a real value). Then:

```sh
pnpm --filter @operon/alchemy run up
```

That command is idempotent. It pulls `postgres:17-alpine` if needed, starts a loopback-only container, and applies the Better Auth + channel bind schema. Destroy with `pnpm --filter @operon/alchemy run down`. Production stage retains the data volume on destroy.

The deploy output is host, port, database, container, and volume. It does not print the password. Wire the kernel with:

```dotenv
OPERON_DATABASE_URL=postgresql://postgres:<url-encoded-password>@127.0.0.1:<port>/operon_local
BETTER_AUTH_SECRET=
OPERON_BETTER_AUTH_URL=http://127.0.0.1:3000
OPERON_ORG_ID=
OPERON_SESSION=
```

`BETTER_AUTH_SECRET` must be the same secret Companion uses. Operon never commits it.

## Layout

- `alchemy.run.ts` — Alchemy CLI entry (Companion-shaped Docker stack)
- `src/stack.ts` — Postgres 17-alpine, named volume, healthcheck, auth schema
- `src/stage.ts` — `local` / `dev` / `staging` / `prod` policy
- `src/auth-schema.ts` — `user` / `session` / `account` / `verification` plus channel bind tables
