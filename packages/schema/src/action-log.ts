import { Schema } from "effect";

import { Subject } from "./security.js";

/**
 * Standard ActionLog Object Type Schema
 * In Operon, every action invocation materializes a 1-to-1 ActionLog object instance.
 */
export const ActionLogTypeId = "ActionLog";

export type ActionLogParameters = Record<string, Schema.Json>;

export interface ActionLogObject {
  readonly id: string;
  readonly actionTypeId: string;
  readonly executionId: string;
  readonly targetObjectId?: string;
  readonly targetObjectTypeId?: string;
  readonly caller: Subject;
  readonly timestamp: number;
  readonly parameters: ActionLogParameters;
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
  caller: Subject,
  timestamp: Schema.Number,
  parameters: Schema.Record(Schema.String, Schema.Json),
  status: Schema.Literals(["executed", "proposed", "rejected", "compensated"]),
  decisionRecordId: Schema.String,
  recordHash: Schema.String,
  previousRecordHash: Schema.optional(Schema.String),
});
