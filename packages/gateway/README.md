# @operon/gateway

Read-only connection layer for Operon. Nothing in this package is user-visible yet. Companion, CLI, and MCP still ingest through their own paths. This package is the wedge that will poll and download into quarantine.

## What a caller gets

`classifyGatewayRequest` and `dispatchGatewayRequest` turn a connector call into one of two things:

1. A `QuarantineEnvelope` for GET, poll, download, GraphQL query, and IMAP/Gmail fetch. The envelope is the input shape of `AccountableIngestionService.ingestRawSource` in `packages/runtime/src/funnel.ts`. The gateway does not call that service.
2. A `WriteCandidate` for POST, PUT, PATCH, DELETE, GraphQL mutation, MCP `destructiveHint`, and email send or modify. The candidate is for the Operon write pipeline. The gateway does not invoke the tool.

## Write-path invariant

The gateway never writes to the world.

- It never calls `FunnelService.ingestBatch`.
- It never calls `putObject`.
- It never runs the 7th step of `executeWritePipeline`.
- Sandbox code-mode cannot POST. `makeReadOnlySandboxInvoker` fails those calls with `WriteInvokeForbiddenError`.
- Stdio MCP stays off (`dangerouslyAllowStdioMCP` defaults to false in the vendored plugin).

Secrets stay in the host as `SecretRef`. Agents do not read them.

## Email demo connector

`gmailReadonlyConnector` is enough for the phase-1 mailbox demo. Scopes are `gmail.readonly` and `calendar.readonly`. OAuth client secret and refresh token are `SecretRef` stubs. Send, modify, insert, and draft tools are listed as forbidden, not as callable operations.

`imapReadonlyConnector(host)` is the same idea over IMAP: EXAMINE, FETCH, IDLE. No APPEND, STORE, or EXPUNGE.

## Vendored surface

Upstream is Useful Software's executor, commit `f1d95f2`, MIT, copyright Rhys Sullivan. See `LICENSE.executor` and `VENDORED.md`. Public name is `@operon/gateway`, not Executor.

Internal subpaths keep the wedge packages without Cloud, UI, billing, or WorkOS:

| Subpath                          | Upstream                           |
| -------------------------------- | ---------------------------------- |
| `@operon/gateway/sdk`            | `packages/core/sdk`                |
| `@operon/gateway/execution`      | `packages/core/execution`          |
| `@operon/gateway/sandbox`        | `packages/kernel/runtime-quickjs`  |
| `@operon/gateway/sandbox-core`   | `packages/kernel/core`             |
| `@operon/gateway/store`          | `packages/core/fumadb`             |
| `@operon/gateway/source-openapi` | `packages/plugins/openapi/src/sdk` |
| `@operon/gateway/source-graphql` | `packages/plugins/graphql/src/sdk` |
| `@operon/gateway/source-mcp`     | `packages/plugins/mcp/src/sdk`     |
| `@operon/gateway/source-secrets` | `packages/plugins/file-secrets`    |
| `@operon/gateway/mcp`            | narrow host MCP envelope           |

Effect is the workspace catalog version `4.0.0-rc.112`. There is no second Effect copy.
