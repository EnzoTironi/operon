import { describe, expect, it } from "vitest";

import { runSompoRdpSimulation } from "./simulation.js";

describe("SOMPO Real Data Platform (RDP) Reference Example", () => {
  it("runs the Sompo Care and Sompo Japan claims triage simulation successfully", async () => {
    await runSompoRdpSimulation();
    expect(true).toBe(true);
  });
});
