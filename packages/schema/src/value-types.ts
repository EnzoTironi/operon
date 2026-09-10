import { Schema } from "effect";

/**
 * ValueType definition encapsulating schema validation, physical unit, domain bounds, and description.
 */
export interface ValueType<T> {
  readonly id: string;
  readonly unit?: string;
  readonly description: string;
  readonly schema: Schema.Schema<T>;
}

/**
 * Factory helper for creating domain-guarded ValueTypes.
 */
export function defineValueType<T>(config: {
  readonly id: string;
  readonly schema: Schema.Schema<T>;
  readonly unit?: string;
  readonly description: string;
}): ValueType<T> {
  return config;
}

/**
 * Built-in standard primitive ValueTypes
 */
export const CommonValueTypes = {
  ISO8601String: defineValueType({
    id: "ISO8601String",
    description: "Standard ISO 8601 formatted date-time string",
    schema: Schema.String.pipe(Schema.brand("ISO8601String")),
  }),
  Percentage: defineValueType({
    id: "Percentage",
    unit: "%",
    description: "Ratio between 0 and 100",
    schema: Schema.Number.pipe(
      Schema.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
      Schema.brand("Percentage")
    ),
  }),
  TimestampMs: defineValueType({
    id: "TimestampMs",
    unit: "ms",
    description: "Unix epoch timestamp in milliseconds",
    schema: Schema.Number.pipe(
      Schema.check(Schema.isGreaterThan(0)),
      Schema.brand("TimestampMs")
    ),
  }),
};
