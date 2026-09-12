import type { SandboxToolInvoker } from "@operon/gateway/sandbox-core";
import { Effect } from "effect";

import { WriteInvokeForbiddenError } from "./errors.js";
import { classifyGatewayRequest } from "./membrane.js";
import type { ConnectorKind, GatewayRequest } from "./membrane.js";

const HTTP_METHOD_PREFIX =
  /^(?<method>get|head|options|post|put|patch|delete)_/iu;
const PATH_METHOD =
  /(?:^|[._])(?<method>get|head|options|post|put|patch|delete)(?:[._]|$)/iu;

export type SandboxCallClassifier = (path: string) => GatewayRequest;

export const classifySandboxPath = (
  path: string,
  connectorKind: ConnectorKind = "openapi"
): GatewayRequest => {
  const lastSegment = path.split(".").at(-1) ?? path;
  const match = HTTP_METHOD_PREFIX.exec(lastSegment) ?? PATH_METHOD.exec(path);
  const method = match?.groups?.method?.toUpperCase() ?? "GET";
  return {
    connectorId: "sandbox",
    connectorKind,
    operation: lastSegment,
    method,
    arguments: {},
    graphqlKind: path.includes("mutation") ? "mutation" : "query",
    destructiveHint:
      lastSegment.toLowerCase().includes("delete") ||
      lastSegment.toLowerCase().includes("destroy"),
  };
};

/**
 * Wrap a QuickJS tool invoker so write paths never leave the sandbox.
 */
export const makeReadOnlySandboxInvoker = (
  inner: SandboxToolInvoker,
  classify: SandboxCallClassifier = classifySandboxPath
): SandboxToolInvoker => ({
  invoke: (input) => {
    const request = classify(input.path);
    const classified = classifyGatewayRequest(request);
    if (classified._tag === "WriteCandidate") {
      return Effect.fail(
        new WriteInvokeForbiddenError({
          connectorId: classified.candidate.connectorId,
          operation: input.path,
          method: classified.candidate.method,
          reason: classified.candidate.reason,
        })
      );
    }
    return inner.invoke(input);
  },
});
