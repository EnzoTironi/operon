import type { ObjectInstance, ObjectType } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Exit, Schema } from "effect";

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
type PropertyEntry = readonly [string, ObjectType["properties"][string]];

function checkCorrectness(
  instance: ObjectInstance,
  propertyEntries: readonly PropertyEntry[]
): string[] {
  const correctViolations: string[] = [];
  for (const [propName, propDef] of propertyEntries) {
    const val = instance.properties[propName];
    if (val !== undefined && val !== null) {
      const decode = Schema.decodeUnknownExit(propDef.schema);
      const exit = decode(val);
      if (Exit.isFailure(exit)) {
        correctViolations.push(
          `Property '${propName}' validation failed: ${String(exit.cause)}`
        );
      }
    }
  }
  return correctViolations;
}

function checkCompleteness(
  instance: ObjectInstance,
  propertyEntries: readonly PropertyEntry[]
): string[] {
  const missingProperties: string[] = [];
  for (const [propName, propDef] of propertyEntries) {
    const val = instance.properties[propName];
    if (propDef.required && (val === undefined || val === null)) {
      missingProperties.push(propName);
    }
  }
  return missingProperties;
}

function checkCurrency(
  instance: ObjectInstance,
  propertyEntries: readonly PropertyEntry[],
  now: number
): {
  readonly ageMs: number;
  readonly maxStalenessMs: number;
  readonly property: string;
}[] {
  const recordedAt = instance.provenance?.recordedAt ?? instance.lastModifiedAt;
  const ageMs = Math.max(0, now - recordedAt);
  const staleProperties: {
    ageMs: number;
    maxStalenessMs: number;
    property: string;
  }[] = [];

  for (const [propName, propDef] of propertyEntries) {
    const val = instance.properties[propName];
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
  return staleProperties;
}

function checkConsistency(instance: ObjectInstance): string[] {
  const contradictions: string[] = [];
  if (
    instance.validFrom !== undefined &&
    instance.validTo !== undefined &&
    instance.validFrom > instance.validTo
  ) {
    contradictions.push(
      `validFrom (${instance.validFrom}) cannot be after validTo (${instance.validTo})`
    );
  }
  return contradictions;
}

/**
 * Evaluates Decision Readiness (4C-L1) for a given ObjectInstance against its ObjectType definition.
 */
export function evaluateDecisionReadiness(
  instance: ObjectInstance,
  objectType: ObjectType,
  now: number = Date.now()
): ReadinessCheckResult {
  const propertyEntries = Object.entries(objectType.properties);

  const correctViolations = checkCorrectness(instance, propertyEntries);
  const missingProperties = checkCompleteness(instance, propertyEntries);
  const staleProperties = checkCurrency(instance, propertyEntries, now);
  const contradictions = checkConsistency(instance);

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
