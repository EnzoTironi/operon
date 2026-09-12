# Vendored executor wedge

Upstream: https://github.com/UsefulSoftwareCo/executor

Pin: `f1d95f2b657316180992d5a67c24b7b76dc2b0f1` (`v1.6.8-3-gf1d95f2`)

License: MIT, Copyright (c) 2026 Rhys Sullivan. Full text in `LICENSE.executor`.

Third-party notices that travelled with the copy:

- `vendor/sdk/vendor/json-schema-to-typescript/LICENCE.md` — MIT, Copyright 2022 Boris Cherny
- FumaDB sources under `vendor/store` — MIT, author Fuma Nama, redistributed inside the executor tree

## What was copied

- `packages/core/sdk` (dropped `client.ts` React UI and the oxlint plugin test)
- `packages/core/execution`
- `packages/kernel/core` (codemode-core)
- `packages/kernel/runtime-quickjs`
- `packages/core/fumadb` (dropped CLI, Convex, MongoDB, Prisma, TypeORM, Kysely adapters)
- `packages/plugins/openapi/src/sdk` plus the Effect test harness in `src/testing`
- `packages/plugins/graphql/src/sdk` plus its Effect test harness
- `packages/plugins/mcp/src/sdk` plus its Effect test harness
- `packages/plugins/file-secrets`
- `packages/hosts/mcp` envelope and seams only (no create-artifact, MCP Apps, or search_tools host)

## What was not copied

Cloud, desktop, marketing, docs, host-cloudflare, host-selfhost, React UI, billing, WorkOS vault, toolkits, encrypted secrets, keychain, 1Password, analytics, onboarding demo, e2e, Autumn, telemetry to Useful Software, `runtime-dynamic-worker`, Deno, workerd.

## What Operon changed

- Package names: `@executor-js/*` imports now resolve to `@operon/gateway/*` subpaths.
- Effect catalog bump: `4.0.0-beta.59` to workspace `4.0.0-rc.112`. Mechanical remaps: `Schema.TaggedErrorClass` to `Schema.TaggedError`, `Schema.UnknownFromJsonString` to `Schema.fromJsonString(Schema.Unknown)`, `Schema.Defect` field positions to `Schema.Defect()`, `HttpApiGroup.Any` and `HttpApi.Any`/`AnyWithProps` to `Constraint`/`Top`, `Schedule.both(spaced, recurs(n))` to `Schedule.spaced.pipe(Schedule.upTo({ times: n }))`, `HttpServerRequest.asEffect()` to `Effect.flatMap(HttpServerRequest.HttpServerRequest, ...)`. Node-only fetch types: MCP `HeadersInit`/`BodyInit` narrowed to runtime checks; OpenAPI `File` parts take `Uint8Array` instead of `ArrayBuffer`. Kysely introspect type inlined in `vendor/store/schema/serialize.ts` because that adapter was dropped.
- File-secrets data directory name: `executor` to `operon-gateway`.
- Operon membrane in `src/`: writes are `WriteCandidate`, never `invoke`. Reads become a quarantine envelope for `AccountableIngestionService.ingestRawSource`. Gmail/IMAP connectors are read-only with `SecretRef` on a host store. `createGmailReadonlyExecutor` polls a recorded fixture.

Vendor `@effect/vitest` suites stay in the tree but are not part of `pnpm test`. They need vitest >= 4.1, which cannot share this workspace's vitest 2.1.x and Vite 5. Production vendor sources typecheck on `effect@4.0.0-rc.112`. Package tests cover the Operon membrane and write-path invariant.

Do not rebase this tree onto later executor commits as a drive-by. Pin stays `f1d95f2` until a later, explicit vendor refresh.
