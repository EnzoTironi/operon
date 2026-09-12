import { describe, expect, it } from "vitest";

import {
  EMAIL_BOOTSTRAP_CHANGESET,
  EMAIL_LINK_TYPES,
  EMAIL_OBJECT_TYPE_IDS,
  EMAIL_OBJECT_TYPES,
} from "./email-types.js";

describe("email types", () => {
  it("defines exactly Pessoa, Organização, Conversa, and Compromisso", () => {
    expect(EMAIL_OBJECT_TYPES.map((type) => type.id).toSorted()).toEqual([
      ...EMAIL_OBJECT_TYPE_IDS,
    ]);
    expect(EMAIL_OBJECT_TYPES).toHaveLength(4);
    expect(EMAIL_BOOTSTRAP_CHANGESET.addedObjectTypes).toHaveLength(4);
    expect(EMAIL_BOOTSTRAP_CHANGESET.addedActionTypes).toHaveLength(0);
  });

  it("assigns Zhang typology: master, observation, transaction", () => {
    const byId = Object.fromEntries(
      EMAIL_OBJECT_TYPES.map((type) => [type.id, type.typology])
    );
    expect(byId.Pessoa).toBe("master");
    expect(byId.Organização).toBe("master");
    expect(byId.Conversa).toBe("observation");
    expect(byId.Compromisso).toBe("transaction");
  });

  it("wires the minimum links between the four types and no others", () => {
    expect(EMAIL_LINK_TYPES.map((link) => link.id).toSorted()).toEqual([
      "com",
      "em",
      "membroDe",
      "participantes",
    ]);
    const typeIds = new Set<string>(EMAIL_OBJECT_TYPE_IDS);
    for (const link of EMAIL_LINK_TYPES) {
      expect(typeIds.has(link.sourceTypeId)).toBe(true);
      expect(typeIds.has(link.targetTypeId)).toBe(true);
    }
    expect(EMAIL_BOOTSTRAP_CHANGESET.addedLinkTypes).toEqual(EMAIL_LINK_TYPES);
  });

  it("does not include Patient, ClarifierTank, or AircraftTwin", () => {
    const ids = new Set(EMAIL_OBJECT_TYPES.map((type) => type.id));
    expect(ids.has("Patient")).toBe(false);
    expect(ids.has("ClarifierTank")).toBe(false);
    expect(ids.has("AircraftTwin")).toBe(false);
    expect(
      EMAIL_BOOTSTRAP_CHANGESET.addedObjectTypes.some(
        (type) => type.id === "Patient"
      )
    ).toBe(false);
  });
});
