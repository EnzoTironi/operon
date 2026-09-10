import { Schema } from "effect";

/**
 * Valid Time (T_v): The interval during which a fact was true in reality
 */
export const ValidTime = Schema.Struct({
  validFrom: Schema.Number,
  validTo: Schema.optionalKey(Schema.Number),
});
export type ValidTime = typeof ValidTime.Type;
export const ValidTimeSchema = ValidTime;

/**
 * Transaction Time (T_t): The interval during which a fact was stored in the system
 */
export const TransactionTime = Schema.Struct({
  recordedAt: Schema.Number,
  supersededAt: Schema.optionalKey(Schema.Number),
});
export type TransactionTime = typeof TransactionTime.Type;
export const TransactionTimeSchema = TransactionTime;

/**
 * Bitemporal Coordinates: 2-dimensional time matrix for point-in-time time travel
 */
export const BitemporalCoordinates = Schema.Struct({
  validTime: ValidTime,
  transactionTime: TransactionTime,
});
export type BitemporalCoordinates = typeof BitemporalCoordinates.Type;
export const BitemporalCoordinatesSchema = BitemporalCoordinates;
