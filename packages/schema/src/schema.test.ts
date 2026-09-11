import { Schema, Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  defineActionType,
  defineInterfaceType,
  defineLinkType,
  defineObjectType,
  defineProperty,
  defineValueType,
} from "./index.js";

describe("@operon/schema", () => {
  it("defines domain-specific ValueTypes with boundaries", () => {
    const BloodGlucoseMgDl = defineValueType({
      description: "Blood glucose concentration in mg/dL",
      id: "BloodGlucoseMgDl",
      schema: Schema.Number.pipe(
        Schema.check(Schema.isBetween({ maximum: 600, minimum: 20 })),
        Schema.brand("BloodGlucoseMgDl")
      ),
      unit: "mg/dL",
    });

    const decodeBloodGlucose = Schema.decodeUnknownSync(
      BloodGlucoseMgDl.schema
    );
    const validReading = decodeBloodGlucose(120);
    expect(validReading).toBe(120);

    expect(() => decodeBloodGlucose(10)).toThrow();
  });

  it("defines an Object Type with typed properties and freshness budget", () => {
    const Patient = defineObjectType({
      description: "Hospital Inpatient",
      id: "Patient",
      name: "Patient",
      primaryKey: "patientId",
      properties: {
        eGFR: defineProperty({
          schema: Schema.Number,
          description: "Estimated glomerular filtration rate",
          freshnessBudget: {
            maxStalenessMs: 24 * 60 * 60 * 1000,
            onStale: "escalate_to_human",
          },
        }),
        patientId: defineProperty({
          schema: Schema.String,
          description: "Unique patient identifier",
          required: true,
        }),
      },
      typology: "master",
    });

    expect(Patient.id).toBe("Patient");
    expect(Patient.typology).toBe("master");
    expect(Patient.primaryKey).toBe("patientId");
    expect(Patient.properties.eGFR.freshnessBudget?.maxStalenessMs).toBe(
      86_400_000
    );
  });

  it("defines Action Types with submission criteria", async () => {
    const AdjustDoseAction = defineActionType({
      defaultExecutionMode: "proposal",
      description: "Adjust bedtime basal insulin dose",
      id: "adjust_dose",
      minimumAgentTier: 2,
      name: "Adjust Insulin Dose",
      parametersSchema: Schema.Struct({
        patientId: Schema.String,
        proposedDoseUnits: Schema.Number.pipe(
          Schema.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
        ),
      }),
      riskTier: "high",
      submissionCriteria: [
        {
          id: "dose_ceiling_check",
          description:
            "Proposed dose must not exceed 60 units without specialist review",
          evaluate: (params) =>
            Effect.succeed({
              passed: params.proposedDoseUnits <= 60,
              verdict: params.proposedDoseUnits <= 60 ? "allow" : "review",
              failureReason:
                params.proposedDoseUnits > 60
                  ? "Dose exceeds 60U threshold; requires endocrinologist review"
                  : undefined,
            }),
        },
      ],
    });

    expect(AdjustDoseAction.id).toBe("adjust_dose");
    expect(AdjustDoseAction.minimumAgentTier).toBe(2);

    const checkResult = await Effect.runPromise(
      AdjustDoseAction.submissionCriteria[0].evaluate(
        { patientId: "P123", proposedDoseUnits: 75 },
        {
          getObject: () => Effect.succeed(null as any),
          now: Date.now(),
          security: {
            correlationId: "c-1",
            subject: {
              id: "agent-1",
              name: "DoseAgent",
              roles: [],
              type: "agent",
            },
            timestamp: Date.now(),
          },
        }
      )
    );

    expect(checkResult.passed).toBeFalsy();
    expect(checkResult.verdict).toBe("review");
  });

  it("validates BitemporalCoordinates and ActionLog schemas", () => {
    const coords = {
      transactionTime: { recordedAt: 1000 },
      validTime: { validFrom: 500, validTo: 1500 },
    };
    expect(coords.validTime.validFrom).toBe(500);
    expect(coords.transactionTime.recordedAt).toBe(1000);
  });

  it("defines Interface Types and Link Types with structural metadata", () => {
    const LocationInterface = defineInterfaceType({
      description: "Spatial coordinates contract",
      id: "LocationInterface",
      name: "Location Interface",
      properties: {
        latitude: defineProperty({
          description: "Latitude",
          schema: Schema.Number,
        }),
        longitude: defineProperty({
          description: "Longitude",
          schema: Schema.Number,
        }),
      },
    });

    expect(LocationInterface.id).toBe("LocationInterface");
    expect(LocationInterface.properties.latitude.description).toBe("Latitude");

    const DoctorPatientLink = defineLinkType({
      cardinality: "one-to-many",
      cascadeDelete: false,
      description: "Attending doctor assigned to patient",
      id: "DoctorPatientLink",
      sourceToTargetName: "patients",
      sourceTypeId: "Doctor",
      targetToSourceName: "attendingDoctor",
      targetTypeId: "Patient",
    });

    expect(DoctorPatientLink.id).toBe("DoctorPatientLink");
    expect(DoctorPatientLink.cardinality).toBe("one-to-many");
    expect(DoctorPatientLink.sourceTypeId).toBe("Doctor");
    expect(DoctorPatientLink.targetTypeId).toBe("Patient");
    expect(DoctorPatientLink.cascadeDelete).toBe(false);
  });

  it("defines Action Types with freshness requirements and side-effect sagas", async () => {
    let sideEffectRan = false;
    let compensationRan = false;

    const TelemetryAction = defineActionType({
      defaultExecutionMode: "automated",
      description:
        "Process vital signs with freshness and side-effect guarantees",
      id: "process_vitals",
      minimumAgentTier: 1,
      name: "Process Vitals",
      parametersSchema: Schema.Struct({
        patientId: Schema.String,
        heartRate: Schema.Number,
      }),
      requiredFreshnessProperties: [
        {
          maxStalenessMs: 60000,
          objectTypeId: "Patient",
          propertyName: "eGFR",
        },
      ],
      riskTier: "medium",
      sideEffects: [
        {
          compensate: () =>
            Effect.sync(() => {
              compensationRan = true;
            }),
          description: "Publish vital alarm to telemetry bus",
          execute: () =>
            Effect.sync(() => {
              sideEffectRan = true;
            }),
          id: "publish_alarm",
        },
      ],
      targetObjectTypeId: "Patient",
    });

    expect(TelemetryAction.targetObjectTypeId).toBe("Patient");
    expect(TelemetryAction.requiredFreshnessProperties).toBeDefined();
    expect(TelemetryAction.requiredFreshnessProperties?.[0].objectTypeId).toBe(
      "Patient"
    );

    const se = TelemetryAction.sideEffects?.[0];
    expect(se).toBeDefined();
    if (se) {
      const dummyCtx = {
        getObject: () => Effect.succeed(null as any),
        now: Date.now(),
        security: {
          correlationId: "c-test",
          subject: {
            id: "test",
            name: "Test",
            roles: [],
            type: "agent" as const,
          },
          timestamp: Date.now(),
        },
      };
      await Effect.runPromise(
        se.execute({ patientId: "P1", heartRate: 80 }, dummyCtx)
      );
      expect(sideEffectRan).toBe(true);

      if (se.compensate) {
        await Effect.runPromise(
          se.compensate({ patientId: "P1", heartRate: 80 }, dummyCtx)
        );
        expect(compensationRan).toBe(true);
      }
    }
  });
});
