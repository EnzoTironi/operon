import { Schema } from "effect";

/**
 * Branded identifier for an instance of an Object
 */
export const ObjectId = Schema.String.pipe(Schema.brand("ObjectId"));
export type ObjectId = Schema.Schema.Type<typeof ObjectId>;

/**
 * Identifier for an Object Type (e.g. 'Patient', 'AerationTank')
 */
export const ObjectTypeId = Schema.String.pipe(Schema.brand("ObjectTypeId"));
export type ObjectTypeId = Schema.Schema.Type<typeof ObjectTypeId>;

/**
 * Identifier for a Link Type (e.g. 'treatedBy', 'connectedTo')
 */
export const LinkTypeId = Schema.String.pipe(Schema.brand("LinkTypeId"));
export type LinkTypeId = Schema.Schema.Type<typeof LinkTypeId>;

/**
 * Identifier for an Action Type (e.g. 'propose_dose_adjustment', 'approve_setpoint_change')
 */
export const ActionTypeId = Schema.String.pipe(Schema.brand("ActionTypeId"));
export type ActionTypeId = Schema.Schema.Type<typeof ActionTypeId>;

/**
 * Four-quadrant object typology from Chapter 4 of the book:
 * - master: Core durable entities (Patient, Facility, Course)
 * - transaction: Finite lifecycle commitments (Order, Prescription, WaiverRequest)
 * - observation: Point-in-time sensor/handover telemetry (MealObservation, GlucoseReading, SCADA Telemetry)
 * - reference: Standardized vocabulary / dictionaries (MedicationCatalog, ICD10Code)
 */
export type EntityTypology =
  | "master"
  | "transaction"
  | "observation"
  | "reference";

/**
 * Data classification level for governance and property-level ACLs (Chapter 10)
 */
export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/**
 * Freshness budget specification (Chapter 3 & 7)
 * Defines allowable staleness relative to decision time
 */
export interface FreshnessBudget {
  readonly maxStalenessMs: number;
  readonly onStale: "reject" | "warn" | "escalate_to_human";
}

/**
 * Provenance tracking on property values and observations (Chapter 7)
 */
export interface Provenance {
  readonly sourceSystem: string;
  readonly sourceRecordId?: string;
  readonly ingestedAt: number; // unix epoch ms
  readonly recordedAt: number; // valid-time epoch ms
  readonly confidence?: number; // 0.0 to 1.0
}
