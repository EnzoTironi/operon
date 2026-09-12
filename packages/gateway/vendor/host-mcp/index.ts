// ---------------------------------------------------------------------------
// @operon/gateway/mcp — the provider-neutral MCP SERVING surface.
//
// This entry point exports ONLY the serving envelope (`McpServingRoutes`) +
// its seams (`McpAuthProvider` / `McpSessionStore` / `McpErrorReporter` /
// `Principal`) + the canonical JSON-RPC error renderer (`jsonRpcErrorBody`).
//
// The executor TOOL factory (`createExecutorMcpServer`, artifacts,
// browser-approval, search_tools) is not vendored. This package keeps the
// serving envelope and seams only.
// ---------------------------------------------------------------------------

export {
  Principal,
  McpAuthProvider,
  McpSessionStore,
  McpErrorReporter,
  McpErrorReporterNoop,
  defaultMcpResource,
  mcpResourceKey,
  principalOwns,
  orgWriteAccessForPrincipal,
  withOrgWriteAccess,
  MCP_ORG_WRITE_ACCESS_HEADER,
  authenticated,
  unauthorized,
  forbidden,
  unavailable,
  type AuthOutcome,
  type McpAuthenticated,
  type McpUnauthorized,
  type McpForbidden,
  type McpUnavailable,
  type McpDiscoveryRoute,
  type McpDispatchInput,
  type McpDispatchResult,
  type McpResource,
} from "./seams";

export {
  McpServingRoutes,
  McpDiscoveryRoutes,
  jsonRpcErrorBody,
  preInitializeMethodNotFound,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "./envelope";
