import { defineObjectType, defineProperty } from "@operon/schema";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { evaluateDecisionReadiness } from "./readiness.js";

describe("4C Decision Readiness Evaluation (readiness.ts)", () => {
  const telemetryType = defineObjectType({
    description: "Turbine sensor telemetry",
    id: "TurbineTelemetry",
    name: "Turbine Telemetry",
    primaryKey: "id",
    properties: {
      egt: defineProperty({
        description: "Exhaust gas temperature",
        schema: Schema.Number,
      }),
      id: defineProperty({
        description: "Sensor ID",
        required: true,
        schema: Schema.String,
      }),
      vibration: defineProperty({
        description: "Vibration in mm/s",
        freshnessBudget: {
          maxStalenessMs: 15 * 60 * 1000, // 15 minutes
          onStale: "reject",
        },
        schema: Schema.Number,
      }),
    },
    typology: "observation",
  });

  const now = 1_700_000_000_000;

  it("passes when all 4C criteria are fully satisfied", () => {
    const instance = {
      id: "SN-01",
      lastModifiedAt: now - 5 * 60 * 1000,
      properties: {
        egt: 650,
        id: "SN-01",
        vibration: 4.2,
      },
      provenance: {
        ingestedAt: now - 5 * 60 * 1000,
        recordedAt: now - 5 * 60 * 1000,
        sourceSystem: "FADEC",
      },
      typeId: telemetryType.id,
      validFrom: now - 10 * 60 * 1000,
      validTo: now + 60 * 60 * 1000,
      version: 1,
    };

    const res = evaluateDecisionReadiness(instance, telemetryType, now);
    expect(res.isReady).toBe(true);
    expect(res.correct.passed).toBe(true);
    expect(res.correct.violations).toHaveLength(0);
    expect(res.complete.passed).toBe(true);
    expect(res.complete.missingProperties).toHaveLength(0);
    expect(res.current.passed).toBe(true);
    expect(res.current.staleProperties).toHaveLength(0);
    expect(res.consistent.passed).toBe(true);
    expect(res.consistent.contradictions).toHaveLength(0);
  });

  it("evaluates C1 Completeness: flags missing required properties and distinguishes undefined vs null", () => {
    const missingRequired = {
      id: "SN-02",
      lastModifiedAt: now,
      properties: {
        vibration: 3.1,
      },
      typeId: telemetryType.id,
      version: 1,
    };

    const res1 = evaluateDecisionReadiness(missingRequired, telemetryType, now);
    expect(res1.isReady).toBe(false);
    expect(res1.complete.passed).toBe(false);
    expect(res1.complete.missingProperties).toContain("id");

    const nullRequired = {
      id: "SN-03",
      lastModifiedAt: now,
      properties: {
        id: null,
      },
      typeId: telemetryType.id,
      version: 1,
    };

    const res2 = evaluateDecisionReadiness(nullRequired, telemetryType, now);
    expect(res2.complete.passed).toBe(false);
    expect(res2.complete.missingProperties).toContain("id");
  });

  it("evaluates C2 Correctness: flags property schema validation failures", () => {
    const invalidType = {
      id: "SN-04",
      lastModifiedAt: now,
      properties: {
        egt: "not-a-number",
        id: "SN-04",
      },
      typeId: telemetryType.id,
      version: 1,
    };

    const res = evaluateDecisionReadiness(invalidType, telemetryType, now);
    expect(res.isReady).toBe(false);
    expect(res.correct.passed).toBe(false);
    expect(res.correct.violations.length).toBeGreaterThan(0);
    expect(res.correct.violations[0]).toContain("egt");
  });

  it("evaluates C3 Currency: tests exact freshness boundary, stale threshold, and details", () => {
    const budgetMs = 15 * 60 * 1000;

    // Exact boundary: ageMs === maxStalenessMs is NOT stale
    const atBoundary = {
      id: "SN-05",
      lastModifiedAt: now - budgetMs,
      properties: {
        id: "SN-05",
        vibration: 2.5,
      },
      provenance: {
        ingestedAt: now - budgetMs,
        recordedAt: now - budgetMs,
        sourceSystem: "FADEC",
      },
      typeId: telemetryType.id,
      version: 1,
    };
    const resBoundary = evaluateDecisionReadiness(
      atBoundary,
      telemetryType,
      now
    );
    expect(resBoundary.current.passed).toBe(true);
    expect(resBoundary.current.staleProperties).toHaveLength(0);

    // 1 millisecond beyond threshold is stale
    const pastBoundary = {
      id: "SN-06",
      lastModifiedAt: now - (budgetMs + 1),
      properties: {
        id: "SN-06",
        vibration: 2.5,
      },
      provenance: {
        ingestedAt: now - (budgetMs + 1),
        recordedAt: now - (budgetMs + 1),
        sourceSystem: "FADEC",
      },
      typeId: telemetryType.id,
      version: 1,
    };
    const resPast = evaluateDecisionReadiness(pastBoundary, telemetryType, now);
    expect(resPast.isReady).toBe(false);
    expect(resPast.current.passed).toBe(false);
    expect(resPast.current.staleProperties).toHaveLength(1);
    expect(resPast.current.staleProperties[0]).toEqual({
      ageMs: budgetMs + 1,
      maxStalenessMs: budgetMs,
      property: "vibration",
    });

    // When value is undefined or null, freshness budget is not triggered
    const missingValue = {
      id: "SN-07",
      lastModifiedAt: now - 50 * budgetMs,
      properties: {
        id: "SN-07",
        vibration: undefined,
      },
      typeId: telemetryType.id,
      version: 1,
    };
    const resMissing = evaluateDecisionReadiness(
      missingValue,
      telemetryType,
      now
    );
    expect(resMissing.current.passed).toBe(true);
    expect(resMissing.current.staleProperties).toHaveLength(0);

    const nullValue = {
      id: "SN-08",
      lastModifiedAt: now - 50 * budgetMs,
      properties: {
        id: "SN-08",
        vibration: null,
      },
      typeId: telemetryType.id,
      version: 1,
    };
    const resNull = evaluateDecisionReadiness(nullValue, telemetryType, now);
    expect(resNull.current.passed).toBe(true);
    expect(resNull.current.staleProperties).toHaveLength(0);
  });

  it("evaluates C4 Consistency: handles bitemporal point-in-time facts, open intervals, and contradictions", () => {
    // Paradox: validFrom > validTo
    const contradiction = {
      id: "SN-09",
      lastModifiedAt: now,
      properties: { id: "SN-09" },
      typeId: telemetryType.id,
      validFrom: 2000,
      validTo: 1000,
      version: 1,
    };
    const resContra = evaluateDecisionReadiness(
      contradiction,
      telemetryType,
      now
    );
    expect(resContra.isReady).toBe(false);
    expect(resContra.consistent.passed).toBe(false);
    expect(resContra.consistent.contradictions).toHaveLength(1);
    expect(resContra.consistent.contradictions[0]).toContain(
      "validFrom (2000) cannot be after validTo (1000)"
    );

    // Point in time fact: validFrom === validTo is NOT contradictory
    const pointInTime = {
      id: "SN-10",
      lastModifiedAt: now,
      properties: { id: "SN-10" },
      typeId: telemetryType.id,
      validFrom: 1000,
      validTo: 1000,
      version: 1,
    };
    const resPoint = evaluateDecisionReadiness(pointInTime, telemetryType, now);
    expect(resPoint.consistent.passed).toBe(true);
    expect(resPoint.consistent.contradictions).toHaveLength(0);

    // Open-ended interval: validTo is undefined
    const openEnded = {
      id: "SN-11",
      lastModifiedAt: now,
      properties: { id: "SN-11" },
      typeId: telemetryType.id,
      validFrom: 1000,
      validTo: undefined,
      version: 1,
    };
    const resOpen = evaluateDecisionReadiness(openEnded, telemetryType, now);
    expect(resOpen.consistent.passed).toBe(true);
    expect(resOpen.consistent.contradictions).toHaveLength(0);

    // Unspecified validFrom: validFrom is undefined
    const unspecifiedFrom = {
      id: "SN-12",
      lastModifiedAt: now,
      properties: { id: "SN-12" },
      typeId: telemetryType.id,
      validFrom: undefined,
      validTo: 2000,
      version: 1,
    };
    const resUnspec = evaluateDecisionReadiness(
      unspecifiedFrom,
      telemetryType,
      now
    );
    expect(resUnspec.consistent.passed).toBe(true);
    expect(resUnspec.consistent.contradictions).toHaveLength(0);
  });
});
