import type { IntentGrant, PrincipalContext, UseGrant } from "@operon/schema";
import { describe, expect, it } from "vitest";

import { evaluateAuthority } from "./authority-evaluator.js";

const serverBoundPrincipal: PrincipalContext = {
  actorType: "agent",
  agentTier: 3,
  authenticatedEnvironmentId: "prod-us-east",
  authenticatedTenantId: "hospital_alpha",
  principalId: "agent_clinician_99",
  serverAssignedRoles: ["clinical_assistant"],
};

const baseGrant: IntentGrant = {
  actorId: "agent_clinician_99",
  budget: {
    committedReservations: 10,
    maxReservations: 50,
  },
  createdAt: 1000,
  dataUseConditions: ["hipaa_strictly_confidential"],
  destinationAudiences: ["internal_care_team", "patient_portal"],
  eligibleActions: ["prescribe_medication", "update_vitals"],
  eligibleResources: ["Patient/*"],
  environmentId: "prod-us-east",
  expiresAt: 2000000000,
  id: "grant_med_01",
  mandateId: "mandate_care_2026",
  purpose: "direct_patient_care",
  revocationEpoch: 0,
  tenantId: "hospital_alpha",
  version: "1.0.0",
};

const validUse: UseGrant = {
  actionId: "prescribe_medication",
  audience: "internal_care_team",
  availableEvidenceAgeMs: 5000,
  purpose: "direct_patient_care",
  requestedUnits: 5,
  requiredEvidenceFreshnessMs: 30000,
  resourceId: "Patient/P001",
};

describe("V1-03: Principal, grant and authority evaluator", () => {
  it("does allow invocation when principal, intent, audience, evidence freshness, and budget are satisfied", () => {
    const res = evaluateAuthority({
      intent: baseGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [validUse],
    });

    expect(res.verdict).toBe("ALLOW");
    expect(res.remainingBudget).toBe(35); // (50 - 10) - 5
    expect(res.principalId).toBe("agent_clinician_99");
    expect(res.intentId).toBe("grant_med_01");
  });

  it("does deny access when client asserts different tenant attempting authority elevation", () => {
    // Client tries to spoof tenant "hospital_beta" in payload
    const attackerPrincipal: PrincipalContext = {
      ...serverBoundPrincipal,
      clientAssertedRoles: ["super_admin"],
      clientAssertedTenantId: "hospital_beta",
    };

    // Target grant belongs to hospital_beta
    const targetGrant: IntentGrant = {
      ...baseGrant,
      id: "grant_beta_secret",
      tenantId: "hospital_beta",
    };

    const res = evaluateAuthority({
      intent: targetGrant,
      now: 5000,
      principal: attackerPrincipal,
      uses: [validUse],
    });

    // Evaluator binds to authenticatedTenantId (hospital_alpha), rejecting hospital_beta
    expect(res.verdict).toBe("DENY");
    expect(res.reason).toContain("Tenant access denied");
    expect(
      res.diagnostics.some((d) =>
        d.includes("Client attempted tenant elevation")
      )
    ).toBe(true);
  });

  it("does deny access when client asserts elevated roles not granted by server", () => {
    const attackerPrincipal: PrincipalContext = {
      ...serverBoundPrincipal,
      clientAssertedRoles: ["chief_medical_officer", "super_admin"],
      serverAssignedRoles: ["clinical_assistant"],
    };

    const res = evaluateAuthority({
      intent: baseGrant,
      now: 5000,
      principal: attackerPrincipal,
      uses: [validUse],
    });

    expect(
      res.diagnostics.some((d) => d.includes("Client attempted role elevation"))
    ).toBe(true);
  });

  it("does deny access when aggregate-use budget is completely exhausted", () => {
    const exhaustedGrant: IntentGrant = {
      ...baseGrant,
      budget: {
        committedReservations: 50,
        maxReservations: 50,
      },
    };

    const res = evaluateAuthority({
      intent: exhaustedGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [validUse],
    });

    expect(res.verdict).toBe("DENY");
    expect(res.reason).toContain("Aggregate-use budget exhausted");
    expect(res.remainingBudget).toBe(0);
  });

  it("does require review when requested units exceed remaining budget threshold", () => {
    const limitedGrant: IntentGrant = {
      ...baseGrant,
      budget: {
        committedReservations: 45,
        maxReservations: 50,
      },
    };

    const heavyUse: UseGrant = {
      ...validUse,
      requestedUnits: 10, // Remaining is only 5
    };

    const res = evaluateAuthority({
      intent: limitedGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [heavyUse],
    });

    expect(res.verdict).toBe("REVIEW_REQUIRED");
    expect(res.reason).toContain("Aggregate-use budget exceeded");
    expect(res.remainingBudget).toBe(5);
  });

  it("does require review when requested purpose diverges from authorized grant purpose", () => {
    const divergentUse: UseGrant = {
      ...validUse,
      purpose: "marketing_research", // Grant specifies direct_patient_care
    };

    const res = evaluateAuthority({
      intent: baseGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [divergentUse],
    });

    expect(res.verdict).toBe("REVIEW_REQUIRED");
    expect(res.reason).toContain("Purpose divergence");
  });

  it("does return evidence insufficient when evidence freshness window is exceeded", () => {
    const staleUse: UseGrant = {
      ...validUse,
      availableEvidenceAgeMs: 60000, // 60s old
      requiredEvidenceFreshnessMs: 30000, // max 30s allowed
    };

    const res = evaluateAuthority({
      intent: baseGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [staleUse],
    });

    expect(res.verdict).toBe("EVIDENCE_INSUFFICIENT");
    expect(res.reason).toContain(
      "Evidence insufficient: available evidence age 60000ms exceeds freshness budget 30000ms"
    );
  });

  it("does return evidence insufficient when required evidence freshness is unspecified", () => {
    const missingEvidenceUse: UseGrant = {
      ...validUse,
      availableEvidenceAgeMs: undefined,
      requiredEvidenceFreshnessMs: 30000,
    };

    const res = evaluateAuthority({
      intent: baseGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [missingEvidenceUse],
    });

    expect(res.verdict).toBe("EVIDENCE_INSUFFICIENT");
    expect(res.reason).toContain("evidence age is unknown or missing");
  });

  it("does deny access when destination audience is attenuated", () => {
    const untrustedAudienceUse: UseGrant = {
      ...validUse,
      audience: "public_social_media",
    };

    const res = evaluateAuthority({
      intent: baseGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [untrustedAudienceUse],
    });

    expect(res.verdict).toBe("DENY");
    expect(res.reason).toContain(
      "Audience 'public_social_media' is attenuated"
    );
  });

  it("does deny access when intent grant has expired", () => {
    const expiredGrant: IntentGrant = {
      ...baseGrant,
      expiresAt: 4000,
    };

    const res = evaluateAuthority({
      intent: expiredGrant,
      now: 5000,
      principal: serverBoundPrincipal,
      uses: [validUse],
    });

    expect(res.verdict).toBe("DENY");
    expect(res.reason).toContain("expired at 4000");
  });
});
