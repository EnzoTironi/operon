import { describe, expect, it } from "vitest";

import { runWastewaterSimulation } from "./simulation.js";

describe("Wastewater Treatment Compliance Twin (Book Chapter 12)", () => {
  it("runs aeration control and EPA compliance simulation and verifies governance invariants", async () => {
    const { decisions, finalTank, overrides } = await runWastewaterSimulation();

    // 1. Bioreactor basin tank state
    expect(finalTank).toBeDefined();
    expect(finalTank?.properties.operatingStatus).toBe("operating");
    expect(finalTank?.properties.tankId).toBe("Tank-3");

    // 2. Process engineer safety override recorded
    expect(overrides.length).toBe(1);
    expect(overrides[0].reasonCategory).toBe("operational_override");
    expect(overrides[0].humanSubject.id).toBe("eng_vance");

    // 3. Verifies immutable decision records in the audit ledger
    expect(decisions.length).toBeGreaterThanOrEqual(1);
  });
});
