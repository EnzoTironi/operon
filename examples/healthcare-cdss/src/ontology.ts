import type { ObjectTypeId } from "@operon/schema";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";

export const PatientType = defineObjectType({
  description: "Endocrinology inpatient subject to glycemic management",
  id: "Patient",
  name: "Patient",
  primaryKey: "patientId",
  properties: {
    currentBasalDose: defineProperty({
      description: "Current bedtime basal insulin dose in Units",
      required: true,
      schema: Schema.Number.pipe(
        Schema.check(Schema.isBetween({ maximum: 100, minimum: 0 }))
      ),
    }),
    eGFR: defineProperty({
      description: "Estimated glomerular filtration rate in mL/min",
      freshnessBudget: {
        maxStalenessMs: 24 * 60 * 60 * 1000, // 24 hours
        onStale: "escalate_to_human",
      },
      required: true,
      schema: Schema.Number.pipe(
        Schema.check(Schema.isBetween({ maximum: 150, minimum: 0 }))
      ),
    }),
    name: defineProperty({
      description: "Patient full name",
      required: true,
      schema: Schema.String,
    }),
    patientId: defineProperty({
      description: "Unique medical record number",
      required: true,
      schema: Schema.String,
    }),
  },
  typology: "master",
});

export const MealObservationType = defineObjectType({
  description: "Daily dietary intake observation recorded by nursing staff",
  id: "MealObservation",
  name: "MealObservation",
  primaryKey: "observationId",
  properties: {
    intakePercent: defineProperty({
      description: "Percentage of regular meal consumed",
      freshnessBudget: {
        maxStalenessMs: 12 * 60 * 60 * 1000, // 12 hours freshness budget!
        onStale: "reject",
      },
      required: true,
      schema: Schema.Number.pipe(
        Schema.check(Schema.isBetween({ maximum: 100, minimum: 0 }))
      ),
    }),
    nauseaReported: defineProperty({
      description: "Whether patient reported nausea during meal",
      required: true,
      schema: Schema.Boolean,
    }),
    observationId: defineProperty({
      description: "Unique observation ID",
      required: true,
      schema: Schema.String,
    }),
    patientId: defineProperty({
      description: "Referenced patient ID",
      required: true,
      schema: Schema.String,
    }),
  },
  typology: "observation",
});

export const PatientMealLink = defineLinkType({
  cardinality: "one-to-many",
  description: "Links patient to their dietary observations",
  id: "patient_meal_observations",
  sourceToTargetName: "mealObservations",
  sourceTypeId: "Patient",
  targetToSourceName: "patient",
  targetTypeId: "MealObservation",
});

/**
 * Governed Action: Propose or Adjust Insulin Dose
 * Enforces the Golden Rule: LLM suggests candidates; deterministic guards verify Decision Readiness.
 */
export const AdjustInsulinDoseAction = defineActionType({
  defaultExecutionMode: "proposal", // Must go through human review inbox by default
  description:
    "Adjust bedtime basal insulin dose based on glucose trends, renal clearance, and dietary intake",
  id: "adjust_insulin_dose",
  minimumAgentTier: 2, // Tier 2 (Propose) or higher
  name: "Adjust Bedtime Basal Insulin Dose",
  parametersSchema: Schema.Struct({
    clinicalRationale: Schema.String,
    patientId: Schema.String,
    proposedDoseUnits: Schema.Number.pipe(
      Schema.check(Schema.isBetween({ maximum: 80, minimum: 1 }))
    ),
  }),
  riskTier: "high",
  submissionCriteria: [
    {
      description:
        "Decision Readiness (Complete): Today's food intake must be structured and present",
      evaluate: (params, context) =>
        Effect.gen(function* evaluateFoodIntakeGuard() {
          const patient = yield* context.getObject(
            "Patient" as ObjectTypeId,
            params.patientId
          );
          if (!patient) {
            return {
              failureReason: `Patient '${params.patientId}' does not exist in the ontology`,
              passed: false,
              verdict: "deny",
            };
          }

          const mealObs = yield* context.getObject(
            "MealObservation" as ObjectTypeId,
            `meal-${params.patientId}`
          );

          if (!mealObs) {
            return {
              failureReason:
                "Decision Readiness Failure (Completeness): No dietary intake observation recorded for today. Handover text must be structured into a MealObservation before safe dose adjustment can proceed.",
              passed: false,
              verdict: "deny",
            };
          }

          const ageMs = context.now - mealObs.lastModifiedAt;
          if (ageMs > 12 * 60 * 60 * 1000) {
            return {
              failureReason:
                "Dietary intake observation is stale (> 12 hours old)",
              passed: false,
              verdict: "deny",
            };
          }

          return { passed: true, verdict: "allow" };
        }),
      id: "food_intake_completeness_guard",
    },
    {
      description:
        "Hypoglycemia Safety: Impaired renal function (eGFR < 60) combined with low intake (< 60%) requires dose <= 10U",
      evaluate: (params, context) =>
        Effect.gen(function* evaluateHypoglycemiaGuard() {
          const patient = yield* context.getObject(
            "Patient" as ObjectTypeId,
            params.patientId
          );
          const mealObs = yield* context.getObject(
            "MealObservation" as ObjectTypeId,
            `meal-${params.patientId}`
          );

          if (patient && mealObs) {
            const egfr = Number((patient.properties as any).eGFR);
            const intake = Number((mealObs.properties as any).intakePercent);
            const dose = Number((params as any).proposedDoseUnits);

            if (egfr < 60 && intake < 60 && dose > 10) {
              return {
                failureReason: `High Hypoglycemia Risk: eGFR (${egfr}) < 60 and food intake (${intake}%) < 60%. Proposed dose (${dose}U) exceeds safety ceiling of 10U without attending specialist review.`,
                passed: false,
                verdict: "review",
              };
            }
          }

          return { passed: true, verdict: "allow" };
        }),
      id: "renal_intake_hypoglycemia_guard",
    },
  ],
  targetObjectTypeId: "Patient",
});
