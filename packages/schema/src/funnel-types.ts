/**
 * Ingestion mode for the Object Data Funnel
 */
export type FunnelIngestionMode = "batch" | "streaming";

/**
 * Precedence rule when external source batch syncs conflict with local unmaterialized action edits
 */
export type ConflictResolutionPolicy =
  | "user_edit_wins"
  | "source_wins"
  | "timestamp_wins";

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
