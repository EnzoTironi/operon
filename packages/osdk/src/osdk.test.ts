import { InMemoryAuditStore, InMemoryObjectStore } from "@operon/runtime";
import {
  defineActionType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createOperonClient, generateOsdkSource } from "./index.js";

describe("@operon/osdk", () => {
  const PatientType = defineObjectType({
    description: "Inpatient",
    id: "Patient",
    name: "Patient",
    primaryKey: "patientId",
    properties: {
      name: defineProperty({ description: "Full Name", schema: Schema.String }),
      patientId: defineProperty({ description: "ID", schema: Schema.String }),
    },
    typology: "master",
  });

  const UpdatePatientAction = defineActionType({
    defaultExecutionMode: "automated",
    description: "Update info",
    id: "update_patient",
    minimumAgentTier: 1,
    name: "Update Patient",
    parametersSchema: Schema.Struct({
      patientId: Schema.String,
    }),
    riskTier: "low",
  });

  it("should provide fluent client access to objects, sets, and actions", async () => {
    const store = new InMemoryObjectStore();
    const audit = new InMemoryAuditStore();

    await Effect.runPromise(
      store.putObject({
        id: "P1",
        lastModifiedAt: Date.now(),
        properties: { name: "Zhang Minghua", patientId: "P1" },
        typeId: PatientType.id,
        version: 0,
      })
    );

    const client = createOperonClient({
      actionTypes: [UpdatePatientAction],
      auditStore: audit,
      objectStore: store,
      objectTypes: [PatientType],
    });

    // 1. Direct get
    const p1 = await Effect.runPromise(client.objects["Patient"].get("P1"));
    expect(p1).toBeDefined();
    expect(p1?.properties.name).toBe("Zhang Minghua");

    // 2. Direct list with predicate
    const filteredPatients = await Effect.runPromise(
      client.objects["Patient"].list(
        (p) => p.properties.name === "Zhang Minghua"
      )
    );
    expect(filteredPatients.length).toBe(1);
    expect(filteredPatients[0].id).toBe("P1");

    const noPatients = await Effect.runPromise(
      client.objects["Patient"].list((p) => p.properties.name === "Unknown")
    );
    expect(noPatients.length).toBe(0);

    // 3. Set query
    const set = client.objects["Patient"].set();
    const allPatients = await Effect.runPromise(set.all());
    expect(allPatients.length).toBe(1);

    // 4. Action execution with default fallback security
    const defaultActionResult = await Effect.runPromise(
      client.actions["update_patient"].execute({ patientId: "P1" })
    );
    expect(defaultActionResult.status).toBe("executed");
    expect(defaultActionResult.decisionRecord.subject.id).toBe("osdk-client");

    // 5. Action execution with custom SecurityContext
    const customSecurity = {
      correlationId: "osdk-corr-999",
      subject: {
        id: "dr-zhang",
        name: "Dr. Zhang",
        roles: ["physician"],
        type: "user" as const,
      },
      timestamp: Date.now(),
    };
    const actionResult = await Effect.runPromise(
      client.actions["update_patient"].execute(
        { patientId: "P1" },
        customSecurity
      )
    );
    expect(actionResult.status).toBe("executed");
    expect(actionResult.decisionRecord.subject.id).toBe("dr-zhang");
  });

  it("should generate TypeScript client source code from ontology schema including links", () => {
    const source = generateOsdkSource({
      actionTypes: [UpdatePatientAction],
      linkTypes: [
        {
          cardinality: "one-to-one",
          description: "Patient primary doctor link",
          id: "PatientDoctorLink" as any,
          sourceToTargetName: "doctor",
          sourceTypeId: "Patient" as any,
          targetToSourceName: "patient",
          targetTypeId: "Doctor" as any,
        },
      ],
      objectTypes: [PatientType],
    });

    expect(source).toContain("export interface PatientProperties");
    expect(source).toContain(
      "export type PatientInstance = ObjectInstance<PatientProperties>"
    );
    expect(source).toContain(
      "readonly Patient: ObjectTypeAccessor<PatientProperties>"
    );
    expect(source).toContain(
      "readonly update_patient: ActionAccessor<{ patientId: string }>"
    );
  });
});
