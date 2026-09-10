import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  AgentDecisionOutput,
  DecisionContextSubgraph,
  DecisionQueryGoal,
  GoverningPolicy,
} from "./verification.js";
import { evaluateDecisionQualityL2 } from "./verification.js";

const makeContext = (): DecisionContextSubgraph => ({
  objects: [
    {
      id: "patient-101",
      lastModifiedAt: 1000,
      properties: { currentDoseMg: 20, eGfr: 45, status: "admitted" },
      typeId: "Patient" as any,
      version: 1,
    },
  ],
});

const validOutput: AgentDecisionOutput = {
  actionTypeId: "AdjustMedication",
  agentTier: 3,
  assertions: [
    {
      assertedValue: 45,
      property: "renalFunction",
      sourceObjectId: "patient-101",
      sourceProperty: "eGfr",
      sourceSpan: "patient-101.properties.eGfr",
      sourceVersion: 1,
    },
  ],
  outputId: "out-1",
  proposedParameters: { newDoseMg: 15, patientId: "patient-101" },
  requiredQuestionsAnswered: [
    "renal_clearance_checked",
    "current_dose_verified",
  ],
};

const defaultQuery: DecisionQueryGoal = {
  mustAnswerSet: ["renal_clearance_checked", "current_dose_verified"],
};

const defaultPolicy: GoverningPolicy = {
  allowedAgentTier: 3,
  forbiddenParameters: ["overrideSafetyEnvelope"],
  scenarioRedLines: [
    {
      condition: (val: unknown) => typeof val === "number" && val > 25,
      description: "Proposed dose cannot exceed 25mg",
      property: "newDoseMg",
    },
  ],
};

describe("Chapter 16 Layer 2 4C Decision Quality (evaluateDecisionQualityL2)", () => {
  it("passes when output is Correct, Complete, Cited, and Compliant", async () => {
    const result = await Effect.runPromise(
      evaluateDecisionQualityL2(
        validOutput,
        makeContext(),
        defaultQuery,
        defaultPolicy
      )
    );

    expect(result.isQualityPassed).toBe(true);
    expect(result.correct.passed).toBe(true);
    expect(result.complete.passed).toBe(true);
    expect(result.cited.passed).toBe(true);
    expect(result.compliant.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails Correctness when an assertion contradicts context evidence", async () => {
    const contradictoryOutput: AgentDecisionOutput = {
      ...validOutput,
      assertions: [
        {
          assertedValue: 90,
          property: "renalFunction",
          sourceObjectId: "patient-101",
          sourceProperty: "eGfr",
          sourceSpan: "patient-101.properties.eGfr",
        },
      ],
    };

    const result = await Effect.runPromise(
      evaluateDecisionQualityL2(
        contradictoryOutput,
        makeContext(),
        defaultQuery,
        defaultPolicy
      )
    );

    expect(result.isQualityPassed).toBe(false);
    expect(result.correct.passed).toBe(false);
    expect(result.correct.contradictions.length).toBeGreaterThan(0);
    expect(result.correct.contradictions[0]).toContain(
      "Contradiction on 'renalFunction'"
    );
  });

  it("fails Completeness when required questions are omitted", async () => {
    const incompleteOutput: AgentDecisionOutput = {
      ...validOutput,
      requiredQuestionsAnswered: ["renal_clearance_checked"],
    };

    const result = await Effect.runPromise(
      evaluateDecisionQualityL2(
        incompleteOutput,
        makeContext(),
        defaultQuery,
        defaultPolicy
      )
    );

    expect(result.isQualityPassed).toBe(false);
    expect(result.complete.passed).toBe(false);
    expect(result.complete.missingMustAnswer).toContain(
      "Must-answer question 'current_dose_verified' was omitted from output"
    );
  });

  it("fails Citation when assertions lack provenance or source spans", async () => {
    const uncitedOutput: AgentDecisionOutput = {
      ...validOutput,
      assertions: [
        {
          assertedValue: 45,
          property: "renalFunction",
        },
      ],
    };

    const result = await Effect.runPromise(
      evaluateDecisionQualityL2(
        uncitedOutput,
        makeContext(),
        defaultQuery,
        defaultPolicy
      )
    );

    expect(result.isQualityPassed).toBe(false);
    expect(result.cited.passed).toBe(false);
    expect(result.cited.uncitedAssertions.length).toBeGreaterThan(0);
  });

  it("fails Compliance when policy tier, forbidden parameters, or red lines are breached", async () => {
    const nonCompliantOutput: AgentDecisionOutput = {
      ...validOutput,
      agentTier: 4,
      proposedParameters: {
        newDoseMg: 35,
        overrideSafetyEnvelope: true,
        patientId: "patient-101",
      },
    };

    const result = await Effect.runPromise(
      evaluateDecisionQualityL2(
        nonCompliantOutput,
        makeContext(),
        defaultQuery,
        defaultPolicy
      )
    );

    expect(result.isQualityPassed).toBe(false);
    expect(result.compliant.passed).toBe(false);
    expect(result.compliant.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Agent tier 4 exceeds policy maximum allowed tier 3"
        ),
        expect.stringContaining(
          "Output contains forbidden parameter 'overrideSafetyEnvelope'"
        ),
        expect.stringContaining(
          "Scenario red line violated: Proposed dose cannot exceed 25mg"
        ),
      ])
    );
  });
});
