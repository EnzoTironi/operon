import { Schema } from "effect";

/**
 * Envelope handed to `AccountableIngestionService.ingestRawSource`.
 *
 * The gateway never calls that service. Runtime closes the pipe by passing
 * `toIngestRawSourceOptions(envelope)` to `ingestRawSource`.
 * Shape matches `IngestRawSourceOptions`:
 * locator, mediaType, rawPayload, plus optional tenant and sensitivity.
 */
export const QuarantineEnvelope = Schema.Struct({
  locator: Schema.String,
  mediaType: Schema.String,
  rawPayload: Schema.Json,
  sourceSystem: Schema.String,
  operation: Schema.String,
  receivedAt: Schema.Number,
  tenantId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(Schema.String),
  idempotencyKey: Schema.optionalKey(Schema.String),
  sensitivity: Schema.optionalKey(
    Schema.Literals(["public", "internal", "confidential", "restricted"])
  ),
  permittedUses: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type QuarantineEnvelope = typeof QuarantineEnvelope.Type;

export interface IngestRawSourceInput {
  readonly locator: string;
  readonly mediaType: string;
  readonly rawPayload: Schema.Json;
  tenantId?: string;
  environmentId?: string;
  idempotencyKey?: string;
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
  permittedUses?: readonly string[];
}

export const toIngestRawSourceOptions = (
  envelope: QuarantineEnvelope
): IngestRawSourceInput => {
  const options: IngestRawSourceInput = {
    locator: envelope.locator,
    mediaType: envelope.mediaType,
    rawPayload: envelope.rawPayload,
  };
  if (envelope.tenantId !== undefined) {
    options.tenantId = envelope.tenantId;
  }
  if (envelope.environmentId !== undefined) {
    options.environmentId = envelope.environmentId;
  }
  if (envelope.idempotencyKey !== undefined) {
    options.idempotencyKey = envelope.idempotencyKey;
  }
  if (envelope.sensitivity !== undefined) {
    options.sensitivity = envelope.sensitivity;
  }
  if (envelope.permittedUses !== undefined) {
    options.permittedUses = envelope.permittedUses;
  }
  return options;
};
