/** Frozen with `ai-fde.ts`. Not in the live `@operon/mcp` test graph. */
import { OntologyMetadataService } from "@operon/runtime";
import { describe, expect, it } from "vitest";

import { AIFdeAgent } from "./ai-fde.js";

describe("AIFdeAgent Natural Language Schema Synthesis", () => {
  it("synthesizes ObjectTypes, LinkTypes, and ActionTypes from natural language instructions", () => {
    const oms = new OntologyMetadataService();
    const fde = new AIFdeAgent(oms);

    const instruction = `
      Define object type Aircraft with properties tailNumber: string, maxAltitude: number, isAirworthy: boolean.
      Define link AircraftToMaintenance from Aircraft to MaintenanceRecord cardinality 1:N.
      Define action LogInspection targeting Aircraft with parameters inspectorId: string, remarks: string.
    `;

    const changeSet = fde.synthesizeFromInstruction(instruction);

    // Verify synthesized object type
    expect(changeSet.objectTypes).toHaveLength(1);
    const aircraft = changeSet.objectTypes[0];
    expect(aircraft.id).toBe("Aircraft");
    expect(aircraft.properties.tailNumber).toBeDefined();
    expect(aircraft.properties.maxAltitude).toBeDefined();
    expect(aircraft.properties.isAirworthy).toBeDefined();

    // Verify synthesized link type
    expect(changeSet.linkTypes).toHaveLength(1);
    const link = changeSet.linkTypes[0];
    expect(link.id).toBe("AircraftToMaintenance");
    expect(link.sourceTypeId).toBe("Aircraft");
    expect(link.targetTypeId).toBe("MaintenanceRecord");
    expect(link.cardinality).toBe("one-to-many");

    // Verify synthesized action type
    expect(changeSet.actionTypes).toHaveLength(1);
    const action = changeSet.actionTypes[0];
    expect(action.id).toBe("LogInspection");
    expect(action.targetObjectTypeId).toBe("Aircraft");
  });
});
