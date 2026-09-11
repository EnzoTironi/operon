import { describe, expect, it } from "vitest";

import { runHigherEducationSimulation } from "./simulation.js";

describe("Higher Education Prerequisite Governance Twin (Book Chapter 13)", () => {
  it("runs prerequisite waiver and curriculum governance simulation and verifies governance invariants", async () => {
    const { decisions, standardResult, workExpResult } =
      await runHigherEducationSimulation();

    // 1. Standard accredited course waiver passes fast-path execution
    expect(standardResult).toBeDefined();
    expect(standardResult.status).toBe("executed");

    // 2. Work experience waiver triggers institutional governance routing to Action Inbox
    expect(workExpResult).toBeDefined();
    expect(workExpResult.status).toBe("proposed");
    expect(workExpResult.proposalId).toBeDefined();

    // 3. Verifies immutable decision records in the audit ledger
    expect(decisions.length).toBeGreaterThanOrEqual(2);
  });
});
