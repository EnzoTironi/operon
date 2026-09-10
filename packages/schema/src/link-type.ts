import type { LinkTypeId, ObjectTypeId } from "./types.js";

export type LinkCardinality = "one-to-one" | "one-to-many" | "many-to-many";

export interface LinkType {
  readonly id: LinkTypeId;
  readonly description: string;
  readonly sourceTypeId: ObjectTypeId;
  readonly targetTypeId: ObjectTypeId;
  readonly sourceToTargetName: string;
  readonly targetToSourceName: string;
  readonly cardinality: LinkCardinality;
  readonly cascadeDelete?: boolean;
}

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
    id: config.id as LinkTypeId,
    sourceTypeId: config.sourceTypeId as ObjectTypeId,
    targetTypeId: config.targetTypeId as ObjectTypeId,
  };
}

/**
 * Runtime instance of a Link between two objects
 */
export interface LinkInstance {
  readonly linkTypeId: LinkTypeId;
  readonly sourceId: string;
  readonly targetId: string;
  readonly createdAt: number;
  readonly metadata?: Record<string, unknown>;
}
