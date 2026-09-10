import { Schema } from "effect";

/**
 * Valid Time (T_v): The interval during which a fact was true in reality
 */
export interface ValidTime {
  readonly validFrom: number;
  readonly validTo?: number;
}

/**
 * Transaction Time (T_t): The interval during which a fact was stored in the system
 */
export interface TransactionTime {
  readonly recordedAt: number;
  readonly supersededAt?: number;
}

/**
 * Bitemporal Coordinates: 2-dimensional time matrix for point-in-time time travel
 */
export interface BitemporalCoordinates {
  readonly validTime: ValidTime;
  readonly transactionTime: TransactionTime;
}

export const ValidTimeSchema = Schema.Struct({
  validFrom: Schema.Number,
  validTo: Schema.optional(Schema.Number),
});

export const TransactionTimeSchema = Schema.Struct({
  recordedAt: Schema.Number,
  supersededAt: Schema.optional(Schema.Number),
});

export const BitemporalCoordinatesSchema = Schema.Struct({
  validTime: ValidTimeSchema,
  transactionTime: TransactionTimeSchema,
});
