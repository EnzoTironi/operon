import { describe, expect, it } from "vitest";

import { runAviationSimulation } from "./simulation.js";

describe("Aviation Skywise Reference Example", () => {
  it("should run the aviation predictive maintenance simulation successfully", async () => {
    const { actionLogs, workOrders } = await runAviationSimulation();
    expect(workOrders.length).toBe(1);
    expect(actionLogs.length).toBeGreaterThanOrEqual(1);
  });
});
