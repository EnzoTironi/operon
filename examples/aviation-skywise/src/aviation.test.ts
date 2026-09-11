import { describe, expect, it } from "vitest";

import { runAviationSimulation } from "./simulation.js";

describe("Aviation Skywise Reference Example", () => {
  it("runs the aviation predictive maintenance simulation and verifies flight maintenance invariants", async () => {
    const { actionLogs, workOrders } = await runAviationSimulation();

    // 1. Scheduled Maintenance Work Order Invariants
    expect(workOrders.length).toBe(1);
    const [wo] = workOrders;
    expect(wo.properties.tailNumber).toBe("F-WZNW");
    expect(wo.properties.status).toBe("scheduled");
    expect(wo.properties.assignedStation).toBe("CDG");
    expect(wo.properties.urgency).toBe("urgent");

    // 2. Materialized 1-to-1 Action Log Traceability
    expect(actionLogs.length).toBeGreaterThanOrEqual(1);
    expect(actionLogs[0].properties.targetObjectId).toBe(wo.properties.orderId);
  });
});
