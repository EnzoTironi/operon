export { QuarantineEnvelope, toIngestRawSourceOptions } from "./envelope.js";
export type { IngestRawSourceInput } from "./envelope.js";
export {
  WriteInvokeForbiddenError,
  ReadOperationUnsupportedError,
} from "./errors.js";
export {
  GATEWAY_WRITE_PATH_INVARIANT,
  FORBIDDEN_RUNTIME_SYMBOLS,
} from "./invariants.js";
export {
  classifyGatewayRequest,
  dispatchGatewayRequest,
  refuseWriteInvoke,
} from "./membrane.js";
export type {
  ClassifiedGatewayRequest,
  ConnectorKind,
  GatewayDispatchResult,
  GatewayRequest,
  ReadExecutor,
} from "./membrane.js";
export { makeReadOnlySandboxInvoker, classifySandboxPath } from "./sandbox.js";
export { SecretRef, secretRef } from "./secret-ref.js";
export { WriteCandidate } from "./write-candidate.js";
export {
  gmailReadonlyConnector,
  imapReadonlyConnector,
  GMAIL_READONLY_SCOPES_LIST,
} from "./connectors/email.js";
export type {
  GmailConnectorDefinition,
  ImapConnectorDefinition,
  EmailReadOperation,
} from "./connectors/email.js";

export { fileSecretsPlugin } from "@operon/gateway/source-secrets";
export {
  openApiPlugin,
  annotationsForOperation,
} from "@operon/gateway/source-openapi";
export { graphqlPlugin } from "@operon/gateway/source-graphql";
export { mcpPlugin } from "@operon/gateway/source-mcp";
export { createExecutor } from "@operon/gateway/sdk";
export { createExecutionEngine } from "@operon/gateway/execution";
export { makeQuickJsExecutor, setQuickJSModule } from "@operon/gateway/sandbox";
