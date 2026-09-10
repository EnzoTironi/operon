import { describe, expect, it } from "vitest";

import { runClinicalSimulation } from "./simulation.js";

describe("Healthcare CDSS Reference Example", () => {
  it("should run the clinical simulation and prevent trust collapse", async () => {
    const { auditLogs, overrides } = await runClinicalSimulation();

    expect(auditLogs.length).toBeGreaterThan(0);
    expect(overrides.length).toBe(1);

    const [override] = overrides;
    expect(override.reasonCategory).toBe("clinical_discretion");
    expect(override.structuredReason).toContain("Reduced intake (50%)");
    expect(override.humanSubject.name).toContain("Dr. Li");
  });
});
