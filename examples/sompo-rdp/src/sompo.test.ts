import { describe, expect, it } from "vitest";

import { runSompoRdpSimulation } from "./simulation.js";

describe("SOMPO Real Data Platform (RDP) Reference Example", () => {
  it("runs the Sompo Care and Sompo Japan claims triage simulation and verifies governance invariants", async () => {
    const {
      approvedClaim,
      maskedClaimant,
      totalDecisionRecords,
      updatedResident,
    } = await runSompoRdpSimulation();

    // 1. Sompo Care: Resident emergency alert state
    expect(updatedResident).toBeDefined();
    expect(updatedResident?.properties.alertStatus).toBe("emergency");
    expect(updatedResident?.properties.name).toBe("Tanaka Kenji");

    // 2. Sompo Japan: Claim payout approval & fraud triage
    expect(approvedClaim).toBeDefined();
    expect(approvedClaim?.properties.claimStatus).toBe("approved");
    expect(approvedClaim?.properties.triageCategory).toBe("fraud_alert");
    expect(approvedClaim?.properties.lossAmountJpy).toBe(7_500_000);

    // 3. Security & MDO PII masking
    expect(maskedClaimant).toBeDefined();
    expect(maskedClaimant.properties.name).toBe(
      "[REDACTED_BY_SECURITY_POLICY]"
    );

    // 4. Immutable audit ledger
    expect(totalDecisionRecords.length).toBeGreaterThanOrEqual(2);
  });
});
