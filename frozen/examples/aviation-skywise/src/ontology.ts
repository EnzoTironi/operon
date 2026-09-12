import {
  defineActionType,
  defineObjectType,
  defineProperty,
  defineValueType,
} from "@operon/schema";
import { Effect, Schema } from "effect";

// Value Types
export const VibrationMmS = defineValueType({
  description: "Turbine radial vibration velocity in mm/s",
  id: "VibrationMmS",
  schema: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ maximum: 50, minimum: 0 })),
    Schema.brand("VibrationMmS")
  ),
  unit: "mm/s",
});

export const TemperatureC = defineValueType({
  description: "Exhaust gas temperature in Celsius",
  id: "TemperatureC",
  schema: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ maximum: 1500, minimum: -50 })),
    Schema.brand("TemperatureC")
  ),
  unit: "Celsius",
});

// Object Types
export const AircraftType = defineObjectType({
  description: "Commercial aircraft airframe digital twin",
  id: "Aircraft",
  name: "Aircraft",
  primaryKey: "tailNumber",
  properties: {
    model: defineProperty({
      description: "Aircraft model",
      schema: Schema.String,
    }),
    status: defineProperty({
      description: "Airworthiness status",
      schema: Schema.Literals(["in_service", "maintenance", "grounded"]),
    }),
    tailNumber: defineProperty({
      description: "Aircraft tail registration",
      schema: Schema.String,
    }),
    totalFlightHours: defineProperty({
      description: "Cumulative flight hours",
      schema: Schema.Number,
    }),
  },
  typology: "master",
});

export const TurbineTelemetryType = defineObjectType({
  description: "High-frequency engine vibration and sensor telemetry",
  id: "TurbineTelemetry",
  name: "Turbine Telemetry",
  primaryKey: "telemetryId",
  properties: {
    egtCelsius: defineProperty({
      description: "Exhaust gas temperature",
      schema: Schema.Number,
    }),
    enginePosition: defineProperty({
      description: "Engine location (left/right)",
      schema: Schema.Literals(["left", "right"]),
    }),
    tailNumber: defineProperty({
      description: "Associated aircraft",
      schema: Schema.String,
    }),
    telemetryId: defineProperty({
      description: "Unique sample ID",
      schema: Schema.String,
    }),
    vibrationMmS: defineProperty({
      description: "Radial vibration in mm/s",
      freshnessBudget: {
        maxStalenessMs: 15 * 60 * 1000, // 15-minute freshness budget for telemetry
        onStale: "reject",
      },
      schema: Schema.Number,
    }),
  },
  typology: "observation",
});

export const MaintenanceWorkOrderType = defineObjectType({
  description: "Scheduled or unscheduled maintenance task",
  id: "MaintenanceWorkOrder",
  name: "Maintenance Work Order",
  primaryKey: "orderId",
  properties: {
    assignedStation: defineProperty({
      description: "Airport IATA code",
      schema: Schema.String,
    }),
    orderId: defineProperty({
      description: "Work order identifier",
      schema: Schema.String,
    }),
    reason: defineProperty({
      description: "Maintenance trigger reason",
      schema: Schema.String,
    }),
    status: defineProperty({
      description: "Order status",
      schema: Schema.Literals(["scheduled", "in_progress", "completed"]),
    }),
    tailNumber: defineProperty({
      description: "Target aircraft",
      schema: Schema.String,
    }),
    urgency: defineProperty({
      description: "Urgency tier",
      schema: Schema.Literals(["routine", "urgent", "aog"]),
    }),
  },
  typology: "transaction",
});

// Actions
export const ScheduleMaintenanceAction = defineActionType({
  defaultExecutionMode: "proposal",
  description:
    "Propose or schedule aircraft maintenance based on predictive anomaly detection",
  id: "schedule_aircraft_maintenance",
  minimumAgentTier: 2,
  name: "Schedule Aircraft Maintenance",
  parametersSchema: Schema.Struct({
    assignedStation: Schema.String,
    reason: Schema.String,
    tailNumber: Schema.String,
    urgency: Schema.Literals(["routine", "urgent", "aog"]),
  }),
  riskTier: "high",
  submissionCriteria: [
    {
      description:
        "Urgent or AOG maintenance proposals must be reviewed by the Chief Fleet Engineer",
      evaluate: (params) => {
        const urgency = params.urgency;
        const isRoutine = urgency === "routine";
        if (isRoutine) {
          return Effect.succeed({
            passed: true,
            verdict: "allow",
          } as const);
        }
        return Effect.succeed({
          failureReason:
            "Critical fleet intervention requires Chief Fleet Engineer review",
          passed: false,
          verdict: "review",
        } as const);
      },
      id: "fleet_engineer_safety_guard",
    },
  ],
  targetObjectTypeId: "MaintenanceWorkOrder",
});
