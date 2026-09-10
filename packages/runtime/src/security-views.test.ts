import type {
  MultiDatasetObjectMapping,
  ObjectInstance,
  ObjectTypeId,
  RestrictedView,
  Subject,
} from "@operon/schema";
import { describe, expect, it } from "vitest";

import { DynamicSecurityEngine } from "./security-views.js";

describe("DynamicSecurityEngine & Row/Column Level Security (security-views.ts)", () => {
  const typeId = "SensitiveRecord" as ObjectTypeId;

  const adminSubject: Subject = {
    id: "admin-1",
    name: "Admin User",
    roles: ["admin"],
    type: "user",
  };

  const analystSubject: Subject = {
    id: "analyst-1",
    name: "Analyst User",
    roles: ["analyst", "guest"],
    type: "user",
  };

  const guestSubject: Subject = {
    id: "guest-1",
    name: "Guest User",
    roles: ["guest"],
    type: "user",
  };

  const testInstance: ObjectInstance = {
    id: "REC-001",
    lastModifiedAt: 1000,
    properties: {
      financialSecret: "$1,000,000",
      medicalDiagnosis: "Hypertension",
      publicName: "Acme Corp",
      unclassifiedField: "Default public",
    },
    typeId,
    version: 1,
  };

  describe("Row-Level Security (Restricted Views)", () => {
    it("allows access when no restricted views are registered", () => {
      const engine = new DynamicSecurityEngine();
      expect(engine.canRead(testInstance, guestSubject)).toBe(true);
      expect(engine.filterInstances([testInstance], guestSubject)).toEqual([
        testInstance,
      ]);
    });

    it("enforces conjunctive evaluation (every) across multiple restricted views", () => {
      const engine = new DynamicSecurityEngine();

      const rvTenant: RestrictedView = {
        id: "rv-tenant",
        objectTypeId: typeId,
        predicate: (inst, subj) =>
          subj.roles.includes("guest") || subj.roles.includes("admin"),
      };

      const rvClearance: RestrictedView = {
        id: "rv-clearance",
        objectTypeId: typeId,
        predicate: (inst, subj) =>
          subj.roles.includes("analyst") || subj.roles.includes("admin"),
      };

      engine.registerRestrictedView(rvTenant);
      engine.registerRestrictedView(rvClearance);

      // Admin satisfies both -> true
      expect(engine.canRead(testInstance, adminSubject)).toBe(true);

      // Analyst satisfies clearance (true) and tenant (false) -> FALSE (conjunctive!)
      const analystOnly: Subject = {
        id: "a",
        name: "A",
        roles: ["analyst"],
        type: "user",
      };
      expect(engine.canRead(testInstance, analystOnly)).toBe(false);

      // Guest satisfies tenant (true) but not clearance (false) -> FALSE
      expect(engine.canRead(testInstance, guestSubject)).toBe(false);

      // Multi-role satisfying both -> true
      expect(engine.canRead(testInstance, analystSubject)).toBe(true);

      // filterInstances correctly filters
      expect(engine.filterInstances([testInstance], guestSubject)).toHaveLength(
        0
      );
      expect(
        engine.filterInstances([testInstance], analystSubject)
      ).toHaveLength(1);
    });
  });

  describe("Column-Level Security (Multi-Dataset Objects)", () => {
    const mdoMapping: MultiDatasetObjectMapping = {
      authorizedRolesPerClassification: {
        confidential: ["analyst"],
        restricted: ["director"],
      },
      objectTypeId: typeId,
      propertyClassifications: {
        financialSecret: "restricted",
        medicalDiagnosis: "confidential",
        publicName: "public",
        // unclassifiedField omitted to test default 'public' fallback
      },
    };

    it("returns instance unmodified when no MDO mapping exists", () => {
      const engine = new DynamicSecurityEngine();
      const projected = engine.projectInstance(testInstance, guestSubject);
      expect(projected).toEqual(testInstance);
    });

    it("preserves unredacted fields for admin subject across all classifications", () => {
      const engine = new DynamicSecurityEngine();
      engine.registerMdoMapping(mdoMapping);

      const projected = engine.projectInstance(testInstance, adminSubject);
      expect(projected.properties).toEqual({
        financialSecret: "$1,000,000",
        medicalDiagnosis: "Hypertension",
        publicName: "Acme Corp",
        unclassifiedField: "Default public",
      });
    });

    it("redacts restricted fields while permitting authorized roles and public fallback", () => {
      const engine = new DynamicSecurityEngine();
      engine.registerMdoMapping(mdoMapping);

      // Analyst has ["analyst", "guest"] -> authorized for confidential, but not restricted
      const analystProjected = engine.projectInstance(
        testInstance,
        analystSubject
      );
      expect(analystProjected.properties).toEqual({
        financialSecret: "[REDACTED_BY_SECURITY_POLICY]",
        medicalDiagnosis: "Hypertension",
        publicName: "Acme Corp",
        unclassifiedField: "Default public",
      });

      // Guest has only ["guest"] -> redacts both confidential and restricted
      const guestProjected = engine.projectInstance(testInstance, guestSubject);
      expect(guestProjected.properties).toEqual({
        financialSecret: "[REDACTED_BY_SECURITY_POLICY]",
        medicalDiagnosis: "[REDACTED_BY_SECURITY_POLICY]",
        publicName: "Acme Corp",
        unclassifiedField: "Default public",
      });
    });
  });
});
