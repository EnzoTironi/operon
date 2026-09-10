import { Schema } from "effect";

import type { Subject } from "./security.js";

/**
 * Standard ActionLog Object Type Schema
 * In Operon, every action invocation materializes a 1-to-1 ActionLog object instance.
 */
export const ActionLogTypeId = "ActionLog";

export interface ActionLogObject {
  readonly id: string;
  readonly actionTypeId: string;
  readonly executionId: string;
  readonly targetObjectId?: string;
  readonly targetObjectTypeId?: string;
  readonly caller: Subject;
  readonly timestamp: number;
  readonly parameters: Record<string, unknown>;
  readonly status: "executed" | "proposed" | "rejected" | "compensated";
  readonly decisionRecordId: string;
  readonly recordHash: string;
  readonly previousRecordHash?: string;
}

export const ActionLogSchema = Schema.Struct({
  id: Schema.String,
  actionTypeId: Schema.String,
  executionId: Schema.String,
  targetObjectId: Schema.optional(Schema.String),
  targetObjectTypeId: Schema.optional(Schema.String),
  caller: Schema.Unknown,
  timestamp: Schema.Number,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.Literals(["executed", "proposed", "rejected", "compensated"]),
  decisionRecordId: Schema.String,
  recordHash: Schema.String,
  previousRecordHash: Schema.optional(Schema.String),
});
