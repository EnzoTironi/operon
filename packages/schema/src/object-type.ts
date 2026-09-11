import { Schema } from "effect";

import { ObjectTypeId, Provenance } from "./types.js";
import type {
  DataClassification,
  EntityTypology,
  FreshnessBudget,
} from "./types.js";
import type { ValueType } from "./value-types.js";

export type ObjectProperties = Record<string, Schema.Json>;

/**
 * Property definition on an Object Type
 */
export interface PropertyDefinition<T = unknown> {
  readonly schema: Schema.Codec<T, unknown, never>;
  readonly description: string;
  readonly valueType?: ValueType<T>;
  readonly required?: boolean;
  readonly defaultValue?: T;
  readonly freshnessBudget?: FreshnessBudget;
  readonly classification?: DataClassification;
  readonly isDerived?: boolean;
  readonly derivedFrom?: readonly string[];
}

/**
 * Object Type definition
 */
export interface ObjectType<
  Props extends Record<string, PropertyDefinition<unknown>> = Record<
    string,
    PropertyDefinition<unknown>
  >,
> {
  readonly id: ObjectTypeId;
  readonly name: string;
  readonly description: string;
  readonly typology: EntityTypology;
  readonly primaryKey: string;
  readonly properties: Props;
  readonly implementedInterfaces?: readonly string[];
  readonly immutableProperties?: readonly string[];
}

/**
 * Factory for defining an Object Type with strong typing
 */
export function defineObjectType<
  Props extends Record<string, PropertyDefinition<unknown>>,
  PK extends keyof Props & string,
>(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly typology: EntityTypology;
  readonly primaryKey: PK;
  readonly properties: Props;
  readonly implementedInterfaces?: readonly string[];
  readonly immutableProperties?: readonly (keyof Props & string)[];
}): ObjectType<Props> {
  return {
    ...config,
    id: ObjectTypeId.make(config.id),
  };
}

/**
 * Helper to define a property
 */
export function defineProperty<T>(
  config: PropertyDefinition<T>
): PropertyDefinition<T> {
  return config;
}

/**
 * Runtime instance of an Object with metadata
 */
export const ObjectInstanceSchema = Schema.Struct({
  id: Schema.String,
  typeId: ObjectTypeId,
  properties: Schema.Record(Schema.String, Schema.Unknown),
  provenance: Schema.optionalKey(Provenance),
  lastModifiedAt: Schema.Number,
  validFrom: Schema.optionalKey(Schema.Number),
  validTo: Schema.optionalKey(Schema.Number),
  version: Schema.Number,
});

export interface ObjectInstance<T = ObjectProperties> extends Omit<
  Schema.Schema.Type<typeof ObjectInstanceSchema>,
  "properties"
> {
  readonly properties: T;
}
