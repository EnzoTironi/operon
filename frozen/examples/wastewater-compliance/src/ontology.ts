import {
  CommonValueTypes,
  defineActionType,
  defineLinkType,
  defineObjectType,
} from "@operon/schema";
import type { ObjectTypeId } from "@operon/schema";
import { Effect, Schema } from "effect";

// ---------------------------------------------------------
// 1. Entities & Nouns (Wastewater Digital Twin - Chapter 12)
// ---------------------------------------------------------

export const TreatmentPlantType = defineObjectType({
  id: "TreatmentPlant",
  name: "Treatment Plant",
  description: "Municipal wastewater treatment plant facility",
  typology: "master",
  primaryKey: "plantId",
  properties: {
    plantId: {
      schema: Schema.String,
      description: "Unique plant identifier",
    },
    name: {
      schema: Schema.String,
      description: "Facility designation",
    },
    dailyCapacityM3: {
      schema: Schema.Number,
      description: "Rated hydraulic flow capacity (m3/day)",
    },
  },
});

export const AerationTankType = defineObjectType({
  id: "AerationTank",
  name: "Aeration Tank",
  description: "Biological bioreactor basin with diffused oxygen aeration",
  typology: "master",
  primaryKey: "tankId",
  properties: {
    tankId: {
      schema: Schema.String,
      description: "Unique tank ID (e.g. Tank-3)",
    },
    volumeM3: {
      schema: Schema.Number,
      description: "Basin liquid volume in cubic meters",
    },
    currentSetpointDO: {
      schema: Schema.Number,
      description: "Active dissolved oxygen setpoint (mg/L)",
    },
    operatingStatus: {
      schema: Schema.String,
      description: "operating | maintenance | offline",
    },
  },
});

export const DOSensorType = defineObjectType({
  id: "DOSensor",
  name: "DO Sensor",
  description: "Optical dissolved oxygen luminescent immersion sensor",
  typology: "master",
  primaryKey: "sensorId",
  properties: {
    sensorId: {
      schema: Schema.String,
      description: "Sensor hardware tag",
    },
    tankId: {
      schema: Schema.String,
      description: "Mounted basin location",
    },
    daysSinceCalibration: {
      schema: Schema.Number,
      description: "Elapsed days since chemical zero/span calibration",
    },
    calibrationStatus: {
      schema: Schema.String,
      description: "valid | overdue | uncalibrated",
    },
  },
});

export const PermitVersionType = defineObjectType({
  id: "PermitVersion",
  name: "Permit Version",
  description: "Regulatory EPA discharge permit versioned limits",
  typology: "reference",
  primaryKey: "permitId",
  properties: {
    permitId: {
      schema: Schema.String,
      description: "Permit code (e.g. EPA-NPDES-2026)",
    },
    effectiveDate: {
      schema: CommonValueTypes.ISO8601String.schema,
      description: "Promulgation date",
    },
    maxEffluentCODmgL: {
      schema: Schema.Number,
      description: "Maximum allowable effluent chemical oxygen demand (mg/L)",
    },
    maxEffluentNH4mgL: {
      schema: Schema.Number,
      description: "Maximum allowable effluent ammonia nitrogen (mg/L)",
    },
  },
});

export const TelemetryReadingType = defineObjectType({
  id: "TelemetryReading",
  name: "Telemetry Reading",
  description: "High-frequency SCADA sensor time series observation",
  typology: "observation",
  primaryKey: "readingId",
  properties: {
    readingId: {
      schema: Schema.String,
      description: "Unique observation UUID",
    },
    tankId: {
      schema: Schema.String,
      description: "Target basin",
    },
    measuredDO: {
      schema: Schema.Number,
      description: "Observed dissolved oxygen (mg/L)",
    },
    airFlowRateM3h: {
      schema: Schema.Number,
      description: "Blower air flow rate (m3/h)",
    },
    recordedAt: {
      schema: CommonValueTypes.ISO8601String.schema,
      description: "Timestamp of reading",
    },
  },
});

// ---------------------------------------------------------
// 2. Links & Relationships
// ---------------------------------------------------------

/**
 * Self-referential link explicitly permitting cycles due to hydraulic recirculation (BSM1 model)
 */
export const UpstreamOfLink = defineLinkType({
  id: "upstreamOf",
  description:
    "Hydraulic flow connection between bioreactor basins (cycle-aware)",
  sourceTypeId: "AerationTank",
  targetTypeId: "AerationTank",
  sourceToTargetName: "downstreamTank",
  targetToSourceName: "upstreamTank",
  cardinality: "one-to-many",
});

export const TankSensorLink = defineLinkType({
  id: "tankSensor",
  description: "Mounting link between AerationTank and DOSensor",
  sourceTypeId: "AerationTank",
  targetTypeId: "DOSensor",
  sourceToTargetName: "sensors",
  targetToSourceName: "tank",
  cardinality: "one-to-many",
});

// ---------------------------------------------------------
// 3. Kinetic Elements (Action Types)
// ---------------------------------------------------------

/**
 * Card 1: propose_setpoint_change (Mode 3 entry)
 * Proposed by Shift Operator or Tier 2 Optimization Agent.
 * Strictly guarded by EPA 90% safety margin and sensor calibration validity.
 */
export const ProposeSetpointChangeAction = defineActionType({
  id: "propose_setpoint_change",
  name: "Propose DO Setpoint Change",
  description:
    "Proposes adjustment of dissolved oxygen setpoint to optimize blower energy",
  targetObjectTypeId: "AerationTank",
  riskTier: "high",
  minimumAgentTier: 2,
  defaultExecutionMode: "proposal", // Mode 3: Must route to Action Inbox for Process Engineer approval
  parametersSchema: Schema.Struct({
    tankId: Schema.String,
    proposedDO: Schema.Number.pipe(
      Schema.check(Schema.isBetween({ maximum: 6, minimum: 0.5 }))
    ),
    predictedEffluentCOD: Schema.Number,
    rationale: Schema.String,
  }),
  submissionCriteria: [
    {
      id: "sensor-calibration-guard",
      description: "DO sensor must be calibrated within 30 days",
      evaluate: Effect.fn("evaluateSensorCalibrationGuard")(
        function* (params, context) {
          const sensor = yield* context.getObject(
            "DOSensor" as ObjectTypeId,
            `sensor-${params.tankId}`
          );
          if (
            sensor &&
            (sensor.properties.daysSinceCalibration as number) > 30
          ) {
            return {
              passed: false,
              verdict: "deny",
              failureReason: `Sensor calibration expired (${sensor.properties.daysSinceCalibration} days > 30-day limit). Re-calibration required before setpoint modification.`,
            };
          }
          return { passed: true, verdict: "allow" };
        }
      ),
    },
    {
      id: "epa-compliance-margin-guard",
      description:
        "Predicted effluent COD must not exceed 90% of PermitVersion limit (10% safety margin)",
      evaluate: Effect.fn("evaluateEpaComplianceMarginGuard")(
        function* (params, context) {
          const permit = yield* context.getObject(
            "PermitVersion" as ObjectTypeId,
            "EPA-NPDES-2026"
          );
          const limit = permit
            ? (permit.properties.maxEffluentCODmgL as number)
            : 50;
          const safetyCeiling = limit * 0.9; // 45.0 mg/L

          if (params.predictedEffluentCOD > safetyCeiling) {
            return {
              passed: false,
              verdict: "deny",
              failureReason: `Predicted effluent COD (${params.predictedEffluentCOD} mg/L) exceeds regulatory 90% safety ceiling (${safetyCeiling} mg/L). Risk of EPA compliance breach.`,
            };
          }
          return { passed: true, verdict: "allow" };
        }
      ),
    },
  ],
});

/**
 * Card 2: approve_setpoint_change
 * Process Engineer confirms or overrides with structured reason.
 */
export const ApproveSetpointChangeAction = defineActionType({
  id: "approve_setpoint_change",
  name: "Approve Setpoint Change",
  description: "Process Engineer authorization of proposed aeration change",
  targetObjectTypeId: "AerationTank",
  riskTier: "high",
  minimumAgentTier: 3,
  defaultExecutionMode: "manual",
  parametersSchema: Schema.Struct({
    tankId: Schema.String,
    approvedDO: Schema.Number.pipe(
      Schema.check(Schema.isBetween({ maximum: 6, minimum: 0.5 }))
    ),
    engineerId: Schema.String,
  }),
  submissionCriteria: [
    {
      id: "valid-bounds",
      description:
        "Approved DO must be within physiological biological envelope",
      evaluate: (params) => {
        const approvedDO = params.approvedDO;
        return Effect.succeed(
          approvedDO >= 0.5 && approvedDO <= 6
            ? { passed: true, verdict: "allow" }
            : {
                failureReason: "DO outside bounds",
                passed: false,
                verdict: "deny",
              }
        );
      },
    },
  ],
});

/**
 * Card 3: apply_setpoint_change
 * Writes back to DCS/SCADA PLC with compensatable revert action.
 */
export const ApplySetpointChangeAction = defineActionType({
  id: "apply_setpoint_change",
  name: "Apply Setpoint to DCS",
  description: "Direct writeback to plant Distributed Control System (DCS)",
  targetObjectTypeId: "AerationTank",
  riskTier: "critical",
  minimumAgentTier: 4,
  defaultExecutionMode: "automated",
  parametersSchema: Schema.Struct({
    tankId: Schema.String,
    targetDO: Schema.Number,
  }),
  submissionCriteria: [
    {
      id: "tank-operating",
      description: "Tank must be in operating status",
      evaluate: Effect.fn("evaluateTankOperating")(function* (params, context) {
        const tank = yield* context.getObject(
          "AerationTank" as ObjectTypeId,
          params.tankId
        );
        if (tank?.properties.operatingStatus !== "operating") {
          return {
            passed: false,
            verdict: "deny",
            failureReason: `Tank ${params.tankId} is not in operating state.`,
          };
        }
        return { passed: true, verdict: "allow" };
      }),
    },
  ],
  sideEffects: [
    {
      id: "dcs-webhook-writeback",
      description: "Writeback DO setpoint to DCS SCADA loop",
      execute: () => Effect.void,
      compensate: () => Effect.void, // Revert setpoint on failure
    },
  ],
});
