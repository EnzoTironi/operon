import { Schema } from "effect";

import { LinkTypeId, ObjectTypeId } from "./types.js";

export const LinkCardinality = Schema.Literals([
  "one-to-one",
  "one-to-many",
  "many-to-many",
]);
export type LinkCardinality = typeof LinkCardinality.Type;

export const LinkType = Schema.Struct({
  id: LinkTypeId,
  description: Schema.String,
  sourceTypeId: ObjectTypeId,
  targetTypeId: ObjectTypeId,
  sourceToTargetName: Schema.String,
  targetToSourceName: Schema.String,
  cardinality: LinkCardinality,
  cascadeDelete: Schema.optionalKey(Schema.Boolean),
});
export type LinkType = typeof LinkType.Type;
export const LinkTypeSchema = LinkType;

export function defineLinkType(config: {
  readonly id: string;
  readonly description: string;
  readonly sourceTypeId: string;
  readonly targetTypeId: string;
  readonly sourceToTargetName: string;
  readonly targetToSourceName: string;
  readonly cardinality: LinkCardinality;
  readonly cascadeDelete?: boolean;
}): LinkType {
  return {
    ...config,
    id: LinkTypeId.make(config.id),
    sourceTypeId: ObjectTypeId.make(config.sourceTypeId),
    targetTypeId: ObjectTypeId.make(config.targetTypeId),
  };
}

/**
 * Runtime instance of a Link between two objects
 */
export const LinkInstance = Schema.Struct({
  linkTypeId: LinkTypeId,
  sourceId: Schema.String,
  targetId: Schema.String,
  createdAt: Schema.Number,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type LinkInstance = typeof LinkInstance.Type;
export const LinkInstanceSchema = LinkInstance;
