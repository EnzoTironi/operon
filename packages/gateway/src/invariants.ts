/**
 * Live-path invariant for `@operon/gateway`.
 *
 * The gateway is a read/poll/download adapter. It produces a quarantine
 * envelope for `AccountableIngestionService.ingestRawSource` or a
 * `WriteCandidate` for the Operon write pipeline. It never:
 *
 * - calls `FunnelService.ingestBatch`
 * - calls `putObject`
 * - calls the 7th step of `executeWritePipeline`
 * - HTTP-invokes POST/PUT/PATCH/DELETE, GraphQL mutation, or MCP destructive tools
 *
 * Secrets stay in the host as `SecretRef`. Stdio MCP stays off.
 */
export const GATEWAY_WRITE_PATH_INVARIANT =
  "Gateway never invokes writes, never ingestBatch, never putObject, never executeWritePipeline.";

export const FORBIDDEN_RUNTIME_SYMBOLS = [
  "FunnelService.ingestBatch",
  "putObject",
  "executeWritePipeline",
] as const;
