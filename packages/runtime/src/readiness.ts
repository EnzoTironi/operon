import type {
  ObjectInstance,
  ObjectType,
  PropertyDefinition,
} from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Schema } from "effect";

export interface ReadinessCheckResult {
  readonly isReady: boolean;
  readonly correct: {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
  readonly complete: {
    readonly passed: boolean;
    readonly missingProperties: readonly string[];
  };
  readonly current: {
    readonly passed: boolean;
    readonly staleProperties: readonly {
      readonly property: string;
      readonly ageMs: number;
      readonly maxStalenessMs: number;
    }[];
  };
  readonly consistent: {
    readonly passed: boolean;
    readonly contradictions: readonly string[];
  };
}

/**
 * Evaluates Decision Readiness (4C-L1) for a given ObjectInstance against its ObjectType definition.
 */
export function evaluateDecisionReadiness(
  instance: ObjectInstance,
  objectType: ObjectType<any>,
  now: number = Date.now()
): ReadinessCheckResult {
  const correctViolations: string[] = [];
  const missingProperties: string[] = [];
  const staleProperties: {
    property: string;
    ageMs: number;
    maxStalenessMs: number;
  }[] = [];
  const contradictions: string[] = [];

  const propertyEntries = Object.entries(objectType.properties) as [
    string,
    PropertyDefinition<any>,
  ][];

  // 1. Correctness: Validate each property against its schema
  for (const [propName, propDef] of propertyEntries) {
    const val = (instance.properties as any)?.[propName];
    if (val !== undefined && val !== null) {
      const exit = Schema.decodeUnknownExit(
        propDef.schema as Schema.Decoder<any>
      )(val);
      if (exit._tag === "Failure") {
        correctViolations.push(
          `Property '${propName}' validation failed: ${String(exit.cause)}`
        );
      }
    }
  }

  // 2. Completeness: Check required properties
  for (const [propName, propDef] of propertyEntries) {
    const val = (instance.properties as any)?.[propName];
    if (propDef.required && (val === undefined || val === null)) {
      missingProperties.push(propName);
    }
  }

  // 3. Currency: Check freshness budgets
  const recordedAt = instance.provenance?.recordedAt ?? instance.lastModifiedAt;
  const ageMs = Math.max(0, now - recordedAt);

  for (const [propName, propDef] of propertyEntries) {
    const val = (instance.properties as any)?.[propName];
    if (
      propDef.freshnessBudget &&
      val !== undefined &&
      val !== null &&
      ageMs > propDef.freshnessBudget.maxStalenessMs
    ) {
      staleProperties.push({
        ageMs,
        maxStalenessMs: propDef.freshnessBudget.maxStalenessMs,
        property: propName,
      });
    }
  }

  // 4. Consistency: Check bitemporal and integrity invariants
  if (
    instance.validFrom !== undefined &&
    instance.validTo !== undefined &&
    instance.validFrom > instance.validTo
  ) {
    contradictions.push(
      `validFrom (${instance.validFrom}) cannot be after validTo (${instance.validTo})`
    );
  }

  const isCorrect = correctViolations.length === 0;
  const isComplete = missingProperties.length === 0;
  const isCurrent = staleProperties.length === 0;
  const isConsistent = contradictions.length === 0;

  const isReady = isCorrect && isComplete && isCurrent && isConsistent;

  OperonTelemetryService.getInstance().trackEvent({
    event: "operon_readiness_evaluated",
    properties: {
      c1CompletenessPassed: isComplete,
      c2CorrectnessPassed: isCorrect,
      c3CurrentnessPassed: isCurrent,
      c4ConsistencyPassed: isConsistent,
      id: instance.id,
      isReady,
      missingPropertiesCount: missingProperties.length,
      stalePropertiesCount: staleProperties.length,
      typeId: objectType.id,
      typology: objectType.typology,
      violationsCount: correctViolations.length,
    },
  });

  return {
    complete: {
      missingProperties,
      passed: isComplete,
    },
    consistent: {
      contradictions,
      passed: isConsistent,
    },
    correct: {
      passed: isCorrect,
      violations: correctViolations,
    },
    current: {
      passed: isCurrent,
      staleProperties,
    },
    isReady,
  };
}
