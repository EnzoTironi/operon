import { Schema } from "effect";

import type { ObjectInstance } from "./object-type.js";
import type { Subject } from "./security.js";

/**
 * Restricted View (RV): Dynamic row-level security rule
 */
export interface RestrictedView {
  readonly id: string;
  readonly objectTypeId: string;
  readonly name: string;
  readonly description: string;
  /**
   * Predicate determining whether the given subject can view the instance
   */
  readonly predicate: (instance: ObjectInstance, subject: Subject) => boolean;
}

export const PropertySecurityClassification = Schema.Literals([
  "public",
  "internal",
  "confidential",
  "restricted",
  "pii",
]);
export type PropertySecurityClassification =
  typeof PropertySecurityClassification.Type;
export const PropertySecurityClassificationSchema =
  PropertySecurityClassification;

/**
 * Multi-Dataset Object (MDO): Column/property-level mapping and security classification
 */
export interface MultiDatasetObjectMapping {
  readonly objectTypeId: string;
  readonly propertyClassifications: Record<
    string,
    PropertySecurityClassification
  >;
  readonly datasetSources: Record<string, string>; // propertyName -> datasetId
  readonly authorizedRolesPerClassification: Record<
    PropertySecurityClassification,
    readonly string[]
  >;
}
