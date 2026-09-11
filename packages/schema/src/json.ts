import { Schema } from "effect";

/**
 * Centralized JSON Schema codec for safe, typed serialization across the monorepo.
 */
export const JsonCodec = Schema.fromJsonString(Schema.Unknown);

/**
 * Serialize any JSON-compatible value to a JSON string using Effect Schema.
 */
export const serializeJson = Schema.encodeSync(JsonCodec);

/**
 * Safely parse a JSON string using Effect Schema.
 */
export const parseJson = Schema.decodeUnknownSync(JsonCodec);
