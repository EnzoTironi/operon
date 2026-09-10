import { Schema } from "effect";

/**
 * Ingestion mode for the Object Data Funnel
 */
export const FunnelIngestionMode = Schema.Literals(["batch", "streaming"]);
export type FunnelIngestionMode = typeof FunnelIngestionMode.Type;
export const FunnelIngestionModeSchema = FunnelIngestionMode;

/**
 * Precedence rule when external source batch syncs conflict with local unmaterialized action edits
 */
export const ConflictResolutionPolicy = Schema.Literals([
  "user_edit_wins",
  "source_wins",
  "timestamp_wins",
]);
export type ConflictResolutionPolicy = typeof ConflictResolutionPolicy.Type;
export const ConflictResolutionPolicySchema = ConflictResolutionPolicy;

/**
 * Transform expression or function from source field to target property
 */
export interface PropertyMapping {
  readonly sourceField: string;
  readonly targetPropertyName: string;
  readonly transform?: (value: unknown) => unknown;
}

/**
 * Configuration for an external dataset pipeline into an Object Type
 */
export interface FunnelPipelineConfig {
  readonly id: string;
  readonly name: string;
  readonly sourceDatasetId: string;
  readonly targetObjectTypeId: string;
  readonly mode: FunnelIngestionMode;
  readonly primaryKeyField: string;
  readonly propertyMappings: readonly PropertyMapping[];
  readonly conflictPolicy: ConflictResolutionPolicy;
  readonly scheduleCron?: string;
}
