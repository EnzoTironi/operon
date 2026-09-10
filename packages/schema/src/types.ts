import { Schema } from "effect";

/**
 * Branded identifier for an instance of an Object
 */
export const ObjectId = Schema.String.pipe(Schema.brand("ObjectId"));
export type ObjectId = typeof ObjectId.Type;

/**
 * Identifier for an Object Type (e.g. 'Patient', 'AerationTank')
 */
export const ObjectTypeId = Schema.String.pipe(Schema.brand("ObjectTypeId"));
export type ObjectTypeId = typeof ObjectTypeId.Type;

/**
 * Identifier for a Link Type (e.g. 'treatedBy', 'connectedTo')
 */
export const LinkTypeId = Schema.String.pipe(Schema.brand("LinkTypeId"));
export type LinkTypeId = typeof LinkTypeId.Type;

/**
 * Identifier for an Action Type (e.g. 'propose_dose_adjustment', 'approve_setpoint_change')
 */
export const ActionTypeId = Schema.String.pipe(Schema.brand("ActionTypeId"));
export type ActionTypeId = typeof ActionTypeId.Type;

/**
 * Four-quadrant object typology from Chapter 4 of the book:
 * - master: Core durable entities (Patient, Facility, Course)
 * - transaction: Finite lifecycle commitments (Order, Prescription, WaiverRequest)
 * - observation: Point-in-time sensor/handover telemetry (MealObservation, GlucoseReading, SCADA Telemetry)
 * - reference: Standardized vocabulary / dictionaries (MedicationCatalog, ICD10Code)
 */
export const EntityTypology = Schema.Literals([
  "master",
  "transaction",
  "observation",
  "reference",
]);
export type EntityTypology = typeof EntityTypology.Type;

/**
 * Data classification level for governance and property-level ACLs (Chapter 10)
 */
export const DataClassification = Schema.Literals([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type DataClassification = typeof DataClassification.Type;

/**
 * Freshness budget specification (Chapter 3 & 7)
 * Defines allowable staleness relative to decision time
 */
export const FreshnessBudget = Schema.Struct({
  maxStalenessMs: Schema.Number,
  onStale: Schema.Literals(["reject", "warn", "escalate_to_human"]),
});
export type FreshnessBudget = typeof FreshnessBudget.Type;
export const FreshnessBudgetSchema = FreshnessBudget;

/**
 * Provenance tracking on property values and observations (Chapter 7)
 */
export const Provenance = Schema.Struct({
  sourceSystem: Schema.String,
  sourceRecordId: Schema.optionalKey(Schema.String),
  ingestedAt: Schema.Number, // unix epoch ms
  recordedAt: Schema.Number, // valid-time epoch ms
  confidence: Schema.optionalKey(Schema.Number), // 0.0 to 1.0
});
export type Provenance = typeof Provenance.Type;
export const ProvenanceSchema = Provenance;
