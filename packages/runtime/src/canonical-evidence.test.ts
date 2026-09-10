import type { CanonicalEvidenceEnvelope, Subject } from "@operon/schema";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { CanonicalEvidenceEngine } from "./canonical-evidence.js";
import { EmbeddedSqlDriver, SqlBitemporalStore } from "./sql-store.js";

const operatorSubject: Subject = {
  id: "operator_1",
  name: "Field Operator",
  roles: ["operator"],
  type: "user",
};

const specialistSubject: Subject = {
  id: "specialist_1",
  name: "Domain Specialist",
  roles: ["domain_specialist"],
  type: "user",
};

const unauthorizedSubject: Subject = {
  id: "guest_user",
  name: "Guest User",
  roles: ["viewer"],
  type: "user",
};

describe("V1-02: Canonical evidence and bitemporal state", () => {
  it("admits valid evidence envelope and writes accepted claims to bitemporal store", async () => {
    const engine = new CanonicalEvidenceEngine();
    const effectiveTime = 1000000;

    const envelope: CanonicalEvidenceEnvelope = {
      author: operatorSubject,
      classification: "operational",
      contentDigest: "sha256:digest_heartrate_75",
      effectiveTime,
      envelopeId: "env_001",
      externalId: "Patient_01",
      rawPayload: { heartRate: 75, room: "401-B" },
      receivedAt: 1000010,
      sourceSystem: "bedside_monitor",
      targetTypeId: "Patient",
    };

    const receipt = await Effect.runPromise(
      engine.admit(envelope, operatorSubject)
    );

    expect(receipt.status).toBe("admitted");
    expect(receipt.claims).toHaveLength(2);
    expect(receipt.conflictingClaims).toHaveLength(0);
    expect(receipt.subjectId).toBe("Patient_01");
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);

    const claims = engine.getClaimsForSubject("Patient", "Patient_01");
    expect(claims).toHaveLength(2);
    expect(claims[0]?.state).toBe("accepted");
  });

  it("retains conflicting evidence as attributed and unresolved without silent overwrite", async () => {
    const engine = new CanonicalEvidenceEngine();
    const effectiveTime = 1000000;

    // First source: telemetry monitor reports heartRate: 75
    const env1: CanonicalEvidenceEnvelope = {
      author: operatorSubject,
      classification: "operational",
      contentDigest: "sha256:telemetry_heartrate",
      effectiveTime,
      envelopeId: "env_telemetry",
      externalId: "Patient_02",
      rawPayload: { heartRate: 75 },
      receivedAt: 1000010,
      sourceSystem: "telemetry_monitor",
      targetTypeId: "Patient",
    };

    const receipt1 = await Effect.runPromise(
      engine.admit(env1, operatorSubject)
    );
    expect(receipt1.status).toBe("admitted");

    // Second source: manual nurse observation reports heartRate: 98 at the same effective time
    const env2: CanonicalEvidenceEnvelope = {
      author: specialistSubject,
      classification: "operational",
      contentDigest: "sha256:nurse_manual_observation",
      effectiveTime,
      envelopeId: "env_nurse",
      externalId: "Patient_02",
      rawPayload: { heartRate: 98 },
      receivedAt: 1000020,
      sourceSystem: "nurse_manual_chart",
      targetTypeId: "Patient",
    };

    const receipt2 = await Effect.runPromise(
      engine.admit(env2, specialistSubject)
    );

    // Contradictory evidence remains visible, attributed and contested (S03)
    expect(receipt2.status).toBe("contested");
    expect(receipt2.conflictingClaims).toHaveLength(1);
    expect(receipt2.conflictingClaims[0]?.state).toBe("contested");
    expect(receipt2.conflictingClaims[0]?.sourceSystem).toBe(
      "nurse_manual_chart"
    );
    expect(receipt2.conflictingClaims[0]?.conflictReason).toContain(
      "Conflicting value '98' from 'nurse_manual_chart' vs existing '75' from 'telemetry_monitor'"
    );

    const allClaims = engine.getClaimsForSubject("Patient", "Patient_02");
    expect(allClaims).toHaveLength(2);
    expect(
      allClaims.some((c) => c.state === "accepted" && c.propertyValue === 75)
    ).toBe(true);
    expect(
      allClaims.some((c) => c.state === "contested" && c.propertyValue === 98)
    ).toBe(true);
  });

  it("ensures valid-time correction does not rewrite transaction history", async () => {
    const driver = new EmbeddedSqlDriver();
    const store = new SqlBitemporalStore(driver, "postgres");
    const engine = new CanonicalEvidenceEngine(store, driver);

    const t_v1 = 1000;

    // 1. Initial observation recorded at t_t1: patient scheduled for surgery at t_v1
    const res1 = await Effect.runPromise(
      store.putObject({
        id: "Patient_03",
        properties: { status: "scheduled" },
        typeId: "Patient",
        validFrom: t_v1,
        version: 1,
      })
    );
    const t_t1 = res1.lastModifiedAt;

    // Query as-of (valid: t_v1, transaction: t_t1)
    const q1 = await Effect.runPromise(
      engine.query("Patient", { transaction: t_t1, valid: t_v1 })
    );
    expect(q1.objects).toHaveLength(1);
    expect((q1.objects[0] as any).properties.status).toBe("scheduled");

    // 2. Retroactive correction recorded at later transaction time t_t2
    // Fact at valid time t_v1 was actually "cancelled"
    await Effect.runPromise(Effect.sleep("10 millis"));
    const res2 = await Effect.runPromise(
      store.putObject({
        id: "Patient_03",
        properties: { status: "cancelled" },
        typeId: "Patient",
        validFrom: t_v1,
        version: 2,
      })
    );
    const t_t2 = res2.lastModifiedAt;

    // 3. Historical inquiry as-of transaction time t_t1 STILL returns "scheduled"
    // Transaction history is NOT rewritten by the retroactive correction (S04)
    const historicalQuery = await Effect.runPromise(
      engine.query("Patient", { transaction: t_t1, valid: t_v1 })
    );
    expect(historicalQuery.objects).toHaveLength(1);
    expect((historicalQuery.objects[0] as any).properties.status).toBe(
      "scheduled"
    );

    // 4. Current inquiry as-of transaction time t_t2 returns the corrected "cancelled"
    const currentQuery = await Effect.runPromise(
      engine.query("Patient", { transaction: t_t2, valid: t_v1 })
    );
    expect(currentQuery.objects).toHaveLength(1);
    expect((currentQuery.objects[0] as any).properties.status).toBe(
      "cancelled"
    );
  });

  it("matches independent SQL oracle query directly against underlying tables", async () => {
    const driver = new EmbeddedSqlDriver();
    const store = new SqlBitemporalStore(driver, "postgres");
    const engine = new CanonicalEvidenceEngine(store, driver);

    const validTime = 10000;

    const res = await Effect.runPromise(
      store.putObject({
        id: "Patient_Oracle",
        properties: { bloodPressure: "120/80" },
        typeId: "Patient",
        validFrom: validTime,
        version: 1,
      })
    );
    const txTime = res.lastModifiedAt;

    // 1. Query via engine API
    const apiResult = await Effect.runPromise(
      engine.query("Patient", { transaction: txTime, valid: validTime })
    );
    expect(apiResult.objects).toHaveLength(1);
    const apiObj = apiResult.objects[0] as any;

    // 2. Query via independent raw SQL oracle
    const sqlOracleRow = (await Effect.runPromise(
      engine.executeIndependentSqlOracle(
        "Patient",
        "Patient_Oracle",
        validTime,
        txTime
      )
    )) as any;

    expect(sqlOracleRow).toBeDefined();
    expect(sqlOracleRow.id).toBe(apiObj.id);
    expect(sqlOracleRow.type_id).toBe(apiObj.typeId);
    expect(sqlOracleRow.version).toBe(apiObj.version);
    expect(JSON.parse(sqlOracleRow.properties)).toEqual(apiObj.properties);
  });

  it("denies admission when caller lacks required authorization role", async () => {
    const engine = new CanonicalEvidenceEngine();
    const envelope: CanonicalEvidenceEnvelope = {
      author: unauthorizedSubject,
      classification: "operational",
      contentDigest: "sha256:unauthorized_digest",
      effectiveTime: 1000,
      envelopeId: "env_unauth",
      externalId: "Patient_99",
      rawPayload: { heartRate: 70 },
      receivedAt: 1000,
      sourceSystem: "external_untrusted",
      targetTypeId: "Patient",
    };

    const exit = await Effect.runPromiseExit(
      engine.admit(envelope, unauthorizedSubject)
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("AuthorizationError");
    }
  });
});
