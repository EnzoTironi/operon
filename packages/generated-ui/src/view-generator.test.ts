import type { IntentGrant } from "@operon/schema";
import { describe, expect, it } from "vitest";

import { generateDisposableAppView } from "./view-generator.js";

describe("Disposable Generated UI (S13 / V0-CH-09)", () => {
  it("renders a markdown table view with lifecycle state badge", () => {
    const view = generateDisposableAppView({
      data: [
        { id: "PAT-001", name: "John Doe", status: "admitted" },
        { id: "PAT-002", name: "Jane Smith", status: "discharged" },
      ],
      format: "table",
      state: "CONFIRMED",
      title: "Patient Roster",
    });

    expect(view.isDisposable).toBe(true);
    expect(view.sourceOfTruth).toBe("OPERON_KERNEL");
    expect(view.state).toBe("CONFIRMED");
    expect(view.rendered).toContain("[STATE: CONFIRMED]");
    expect(view.rendered).toContain("| id | name | status |");
    expect(view.rendered).toContain("John Doe");
    expect(view.rendered).toContain("sole source of truth");
  });

  it("attenuates sensitive properties according to IntentGrant data-use conditions", () => {
    const mockGrant: IntentGrant = {
      actorId: "agent-1",
      budget: { committedReservations: 0, maxReservations: 10 },
      createdAt: Date.now(),
      dataUseConditions: ["mask_pii", "no_export"],
      destinationAudiences: ["clinical_staff"],
      eligibleActions: ["*"],
      eligibleResources: ["*"],
      environmentId: "test",
      expiresAt: Date.now() + 60000,
      id: "grant-1",
      mandateId: "mandate-1",
      purpose: "treatment",
      revocationEpoch: 1,
      tenantId: "tenant-1",
      version: "1.0.0",
    };

    const view = generateDisposableAppView({
      audience: "clinical_staff",
      data: {
        diagnosis: "Normal",
        id: "REC-1",
        ssn: "123-45-6789",
      },
      format: "markdown",
      grant: mockGrant,
      state: "PROPOSED",
      title: "Patient Medical Record",
    });

    expect(view.state).toBe("PROPOSED");
    expect(view.filteredPropertiesCount).toBe(1);
    expect(view.rendered).toContain("[REDACTED_BY_GRANT]");
    expect(view.rendered).not.toContain("123-45-6789");
    expect(view.rendered).toContain("Normal");
  });

  it("completely attenuates view if destination audience is unauthorized by grant", () => {
    const mockGrant: IntentGrant = {
      actorId: "agent-1",
      budget: { committedReservations: 0, maxReservations: 10 },
      createdAt: Date.now(),
      dataUseConditions: [],
      destinationAudiences: ["auditors"],
      eligibleActions: ["*"],
      eligibleResources: ["*"],
      environmentId: "test",
      expiresAt: Date.now() + 60000,
      id: "grant-1",
      mandateId: "mandate-1",
      purpose: "audit",
      revocationEpoch: 1,
      tenantId: "tenant-1",
      version: "1.0.0",
    };

    const view = generateDisposableAppView({
      audience: "public_room", // unauthorized!
      data: {
        financials: "$1,000,000",
        id: "FIN-1",
      },
      format: "json",
      grant: mockGrant,
      state: "HYPOTHETICAL",
      title: "Financial Forecast",
    });

    expect(view.filteredPropertiesCount).toBe(2);
    expect(view.rendered).not.toContain("$1,000,000");
  });
});
