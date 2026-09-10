import { createHash } from "node:crypto";

import { Schema } from "effect";

import type { Subject } from "./security.js";
import { DataClassification, EntityTypology } from "./types.js";

/**
 * Declared effect class for operations and action definitions
 */
export const EffectClass = Schema.Literals([
  "read_only",
  "state_mutation",
  "external_side_effect",
]);
export type EffectClass = Schema.Schema.Type<typeof EffectClass>;

/**
 * Property definition inside a TypeDef
 */
export const PropertyDef = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["string", "number", "boolean", "date", "json"]),
  required: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
});
export type PropertyDef = Schema.Schema.Type<typeof PropertyDef>;

/**
 * TypeDef: Object Type Definition inside a DefinitionArtifact
 */
export const TypeDef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  properties: Schema.Record(Schema.String, PropertyDef),
  primaryKey: Schema.String,
  typology: Schema.optional(EntityTypology),
  classification: Schema.optional(DataClassification),
});
export type TypeDef = Schema.Schema.Type<typeof TypeDef>;

/**
 * LinkDef: Relationship definition between types
 */
export const LinkDef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  sourceTypeId: Schema.String,
  targetTypeId: Schema.String,
  cardinality: Schema.Literals(["1:1", "1:N", "N:N"]),
  deletionSemantics: Schema.optional(
    Schema.Literals(["cascade", "set_null", "restrict"])
  ),
  temporal: Schema.optional(Schema.Boolean),
});
export type LinkDef = Schema.Schema.Type<typeof LinkDef>;

/**
 * QueryDef: Reusable typed query definition (ObjectSetDefinition)
 */
export const QueryDef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  returnTypeId: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.String),
  description: Schema.optional(Schema.String),
});
export type QueryDef = Schema.Schema.Type<typeof QueryDef>;

/**
 * ActionDef: Action type definition with declared effect class
 */
export const ActionDef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  effectClass: EffectClass,
  riskTier: Schema.Literals(["low", "moderate", "high", "critical"]),
  parametersSchema: Schema.Record(Schema.String, Schema.String),
  requiredRoles: Schema.Array(Schema.String),
});
export type ActionDef = Schema.Schema.Type<typeof ActionDef>;

/**
 * PolicyDef: Governance and review policy
 */
export const PolicyDef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  ruleExpression: Schema.String,
  requiredReviewerRoles: Schema.Array(Schema.String),
});
export type PolicyDef = Schema.Schema.Type<typeof PolicyDef>;

/**
 * FreshnessDef: Freshness budget per type / property
 */
export const FreshnessDef = Schema.Struct({
  typeId: Schema.String,
  propertyName: Schema.String,
  maxStalenessMs: Schema.Number,
  onStale: Schema.Literals(["reject", "warn", "escalate_to_human"]),
});
export type FreshnessDef = Schema.Schema.Type<typeof FreshnessDef>;

/**
 * DefinitionArtifact: The atomic authoring unit compiled to a ChangeSet
 */
export const DefinitionArtifact = Schema.Struct({
  types: Schema.Array(TypeDef),
  links: Schema.Array(LinkDef),
  queries: Schema.Array(QueryDef),
  actions: Schema.Array(ActionDef),
  policies: Schema.Array(PolicyDef),
  freshness: Schema.Array(FreshnessDef),
  presentation: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type DefinitionArtifact = Schema.Schema.Type<typeof DefinitionArtifact>;

/**
 * CandidateChangeSet: Compiled immutable change set with canonical digest
 */
export interface CandidateChangeSet {
  readonly artifact: DefinitionArtifact;
  readonly canonicalDigest: string;
  readonly compiledAt: number;
  readonly revision: number;
}

/**
 * CandidateReceipt: Returned upon atomic application of a DefinitionArtifact
 */
export interface CandidateReceipt {
  readonly branch: string;
  readonly revision: number;
  readonly candidateDigest: string;
  readonly changeSet: CandidateChangeSet;
  readonly status: "applied" | "rejected";
  readonly appliedAt: number;
  readonly idempotencyKey?: string;
}

/**
 * DefinitionRelease: An immutable, published ontology release
 */
export interface DefinitionRelease {
  readonly releaseId: string;
  readonly version: string;
  readonly revision: number;
  readonly candidateDigest: string;
  readonly canonicalDigest: string;
  readonly dependencies: readonly string[];
  readonly declaredEffects: readonly string[];
  readonly schemaVersion: string;
  readonly publishedAt: number;
  readonly publishedBy: Subject;
  readonly reviewRefs: readonly string[];
  readonly status: "published" | "deprecated";
}

/**
 * PublicationReceipt: Returned upon governed publication of a DefinitionRelease
 */
export interface PublicationReceipt {
  readonly publicationId: string;
  readonly release: DefinitionRelease;
  readonly status: "published";
  readonly publishedAt: number;
  readonly idempotencyKey?: string;
}

/**
 * Deterministic RFC 8785-compliant canonical JSON serializer
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const elements = value.map((item) => {
      const res = canonicalJson(item);
      return res === undefined ? "null" : res;
    });
    return `[${elements.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && typeof v !== "function" && typeof v !== "symbol") {
      pairs.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
  }
  return `{${pairs.join(",")}}`;
}

/**
 * Compute SHA-256 byte digest of the canonical JSON bytes
 */
export function computeCanonicalDigest(value: unknown): string {
  const json = canonicalJson(value);
  return createHash("sha256").update(Buffer.from(json, "utf-8")).digest("hex");
}
