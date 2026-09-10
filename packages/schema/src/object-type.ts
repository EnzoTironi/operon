import { Schema } from "effect";

import { ObjectTypeId, Provenance } from "./types.js";
import type {
  DataClassification,
  EntityTypology,
  FreshnessBudget,
} from "./types.js";
import type { ValueType } from "./value-types.js";

/**
 * Property definition on an Object Type
 */
export interface PropertyDefinition<T = any> {
  readonly schema: Schema.Schema<T>;
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
  Props extends Record<string, PropertyDefinition<any>> = Record<
    string,
    PropertyDefinition<any>
  >,
> {
  readonly id: ObjectTypeId;
  readonly name: string;
  readonly description: string;
  readonly typology: EntityTypology;
  readonly primaryKey: keyof Props & string;
  readonly properties: Props;
  readonly implementedInterfaces?: readonly string[];
  readonly immutableProperties?: readonly (keyof Props & string)[];
}

/**
 * Factory for defining an Object Type with strong typing
 */
export function defineObjectType<
  Props extends Record<string, PropertyDefinition<any>>,
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
    id: config.id as ObjectTypeId,
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

export interface ObjectInstance<T = Record<string, unknown>> extends Omit<
  Schema.Schema.Type<typeof ObjectInstanceSchema>,
  "properties"
> {
  readonly properties: T;
}
