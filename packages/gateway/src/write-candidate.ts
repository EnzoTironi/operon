import { Schema } from "effect";

/**
 * A mutation the gateway classified and refused to invoke.
 *
 * This is a proposal-shaped record for the Operon write pipeline.
 * The gateway does not run that pipeline.
 */
export const WriteCandidate = Schema.Struct({
  _tag: Schema.Literal("WriteCandidate"),
  connectorId: Schema.String,
  operation: Schema.String,
  method: Schema.String,
  reason: Schema.Literals([
    "http_mutation",
    "graphql_mutation",
    "mcp_destructive",
    "email_send_or_modify",
  ]),
  arguments: Schema.Unknown,
  approvalDescription: Schema.String,
});
export type WriteCandidate = typeof WriteCandidate.Type;
