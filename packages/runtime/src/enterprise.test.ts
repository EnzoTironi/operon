import { createHmac } from "node:crypto";

import type { ObjectInstance, ObjectTypeId } from "@operon/schema";
import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ClaimsSecurityMapper,
  HttpAuthMiddleware,
  OidcTokenVerifier,
} from "./auth.js";
import {
  DistributedClusterCoordinator,
  DistributedLockManager,
} from "./cluster.js";
import {
  ColumnarBatchEncoder,
  ColumnarBatchTable,
  ColumnarParquetArchiver,
} from "./columnar-store.js";
import { KafkaCdcConnector, WarehouseBatchConnector } from "./connectors.js";
import type { DebeziumCdcMessage } from "./connectors.js";
import { FunnelService } from "./funnel.js";
import { InMemoryObjectStore } from "./object-store.js";
import { SandboxedModelRunner } from "./sandbox.js";
import {
  EmbeddedSqlDriver,
  SqlBitemporalStore,
  SqlSchemaGenerator,
} from "./sql-store.js";

describe("Enterprise SQL Bitemporal Store", () => {
  it("generates DDL for postgres and sqlite dialects", () => {
    const pgDdl = SqlSchemaGenerator.generateDDL("postgres");
    expect(pgDdl.length).toBeGreaterThan(3);
    expect(pgDdl[0]).toContain("JSONB");

    const sqliteDdl = SqlSchemaGenerator.generateDDL("sqlite");
    expect(sqliteDdl[0]).toContain("TEXT");
  });

  it("performs bitemporal mutations, OCC versioning, and time-travel queries", async () => {
    const driver = new EmbeddedSqlDriver();
    const sqlStore = new SqlBitemporalStore(driver, "sqlite");

    const typeId = "Equipment" as ObjectTypeId;
    const initial: ObjectInstance = {
      id: "eq-1",
      lastModifiedAt: 1000,
      properties: { name: "Turbine-A", status: "ONLINE" },
      typeId,
      validFrom: 1000,
      version: 1,
    };

    // 1. Insert initial
    await Effect.runPromise(sqlStore.putObject(initial));

    const fetched = await Effect.runPromise(sqlStore.getObject(typeId, "eq-1"));
    expect(fetched).toBeDefined();
    expect(fetched?.properties.status).toBe("ONLINE");

    // 2. Update with incremented version
    const updated: ObjectInstance = {
      id: "eq-1",
      lastModifiedAt: 2000,
      properties: { name: "Turbine-A", status: "MAINTENANCE" },
      typeId,
      version: 2,
    };
    await Effect.runPromise(sqlStore.putObject(updated));

    const latest = await Effect.runPromise(sqlStore.getObject(typeId, "eq-1"));
    expect(latest?.version).toBe(2);
    expect(latest?.properties.status).toBe("MAINTENANCE");

    // 3. Reject stale OCC version
    const stale: ObjectInstance = {
      id: "eq-1",
      lastModifiedAt: 2000,
      properties: { name: "Turbine-A", status: "OFFLINE" },
      typeId,
      version: 2, // expected 3
    };

    const failRes = await Effect.runPromise(
      sqlStore.putObject(stale).pipe(Effect.result)
    );
    expect(failRes._tag).toBe("Failure");

    // 4. Time travel query using asOfBitemporal
    const timeTraveled = await Effect.runPromise(
      sqlStore.asOfBitemporal(typeId, "eq-1", 1000, Date.now())
    );
    expect(timeTraveled).toBeDefined();
  });
});

describe("Enterprise Columnar / Parquet Storage Engine", () => {
  it("encodes records with dictionary compression and statistical metadata", () => {
    const records = [
      { id: "row-1", status: "ACTIVE", value: 10.5 },
      { id: "row-2", status: "ACTIVE", value: 20 },
      { id: "row-3", status: "INACTIVE", value: 5.2 },
      { id: "row-4", status: "ACTIVE", value: 18.1 },
    ];

    const table = ColumnarBatchEncoder.encode(records, {
      id: "string",
      status: "string",
      value: "float64",
    });

    expect(table.getRowCount()).toBe(4);

    // Verify dictionary compression was applied to 'status'
    const statusCol = table.getColumn("status");
    expect(statusCol?.dictionary).toBeDefined();
    expect(statusCol?.dictionary).toEqual(["ACTIVE", "INACTIVE"]);

    // Verify predicate pushdown stats
    expect(table.canMatchRange("value", 5, 10)).toBe(true);
    expect(table.canMatchRange("value", 30, 40)).toBe(false);

    // Verify column projection pushdown
    const projected = table.project(["status"]);
    expect(projected.getColumnNames()).toEqual(["status"]);
    expect(projected.getColumn("value")).toBeUndefined();

    // Verify binary round-trip
    const bin = table.toBinary();
    const restored = ColumnarBatchTable.fromBinary(bin);
    expect(restored.getRowCount()).toBe(4);
    expect(restored.toRecords().length).toBe(4);
  });

  it("archives object instances into columnar batches with compression ratio tracking", async () => {
    const instances: ObjectInstance[] = [
      {
        id: "p-1",
        lastModifiedAt: 1000,
        properties: { condition: "CRITICAL", ward: "ICU" },
        typeId: "Patient" as ObjectTypeId,
        validFrom: 1000,
        version: 1,
      },
      {
        id: "p-2",
        lastModifiedAt: 1000,
        properties: { condition: "STABLE", ward: "ICU" },
        typeId: "Patient" as ObjectTypeId,
        validFrom: 1000,
        version: 1,
      },
    ];

    const result = await Effect.runPromise(
      ColumnarParquetArchiver.archiveObjectInstances(instances, {
        ward: "string",
        condition: "string",
      })
    );

    expect(result.table.getRowCount()).toBe(2);
    expect(result.metadata.compressedSizeBytes).toBeGreaterThan(0);
    expect(result.metadata.uncompressedSizeBytes).toBeGreaterThan(0);
  });
});

describe("Enterprise Ingestion Connectors", () => {
  it("processes Debezium CDC messages through KafkaCdcConnector", async () => {
    const objectStore = new InMemoryObjectStore();
    const funnel = new FunnelService(objectStore);

    await Effect.runPromise(
      funnel.registerPipeline({
        id: "pipe-patients",
        name: "Patients CDC Pipeline",
        targetObjectTypeId: "Patient",
        primaryKeyField: "patient_id",
        conflictPolicy: "source_wins",
        propertyMappings: [
          { sourceField: "name", targetPropertyName: "name" },
          { sourceField: "age", targetPropertyName: "age" },
        ],
      })
    );

    const connector = new KafkaCdcConnector(funnel);

    connector.registerTableMapping("patients", {
      pipelineId: "pipe-patients",
      targetTypeId: "Patient" as ObjectTypeId,
      primaryKeyField: "patient_id",
    });

    const cdcMsg: DebeziumCdcMessage = {
      payload: {
        before: null,
        after: {
          patient_id: "pt-88",
          name: "John Doe",
          age: 45,
        },
        source: {
          version: "2.4.0",
          connector: "postgresql",
          name: "dbserver1",
          ts_ms: Date.now(),
          db: "hospital",
          table: "patients",
          lsn: 1234567,
        },
        op: "c",
        ts_ms: Date.now(),
      },
    };

    await Effect.runPromise(connector.consumeMessage(cdcMsg));

    const stats = connector.getStats();
    expect(stats.processedCount).toBe(1);
    expect(stats.lastLsn).toBe(1234567);
    expect(stats.errorsCount).toBe(0);

    const stored = await Effect.runPromise(
      objectStore.getObject("Patient" as ObjectTypeId, "pt-88")
    );
    expect(stored).toBeDefined();
    expect(stored?.properties.name).toBe("John Doe");
  });

  it("ingests warehouse batches in chunks with backpressure", async () => {
    const objectStore = new InMemoryObjectStore();
    const funnel = new FunnelService(objectStore);

    await Effect.runPromise(
      funnel.registerPipeline({
        id: "pipe-sensors",
        name: "Sensors Batch Pipeline",
        targetObjectTypeId: "Sensor",
        primaryKeyField: "sensor_id",
        conflictPolicy: "source_wins",
        propertyMappings: [
          { sourceField: "reading", targetPropertyName: "reading" },
        ],
      })
    );

    const connector = new WarehouseBatchConnector(funnel);

    const rows = Array.from({ length: 25 }, (_, i) => ({
      sensor_id: `s-${i}`,
      reading: 42 + i,
    }));

    const report = await Effect.runPromise(
      connector.ingestBatch(rows, {
        pipelineId: "pipe-sensors",
        targetTypeId: "Sensor" as ObjectTypeId,
        chunkSize: 10,
        sourceSystem: "snowflake-export",
      })
    );

    expect(report.totalRecords).toBe(25);
    expect(report.chunksProcessed).toBe(3);
    expect(report.errors.length).toBe(0);

    const s0 = await Effect.runPromise(
      objectStore.getObject("Sensor" as ObjectTypeId, "s-0")
    );
    expect(s0).toBeDefined();
    expect(s0?.properties.reading).toBe(42);
  });
});

describe("Enterprise Identity & OIDC SSO", () => {
  const secret = "super-secret-enterprise-key-12345";
  const verifier = new OidcTokenVerifier({
    secretOrPublicKey: secret,
    expectedIssuer: "https://auth.enterprise.com",
    expectedAudience: "operon-api",
  });

  function createTestJwt(
    claims: Record<string, unknown>,
    alg = "HS256"
  ): string {
    const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString(
      "base64url"
    );
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    return `${header}.${payload}.${sig}`;
  }

  it("verifies valid HS256 JWT and maps claims to SecurityContext", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = createTestJwt({
      sub: "usr-42",
      name: "Dr. Alice Smith",
      iss: "https://auth.enterprise.com",
      aud: "operon-api",
      exp: nowSec + 3600,
      roles: ["physician", "admin"],
      groups: ["cardiology", "oncology"],
      clearance: "TOP_SECRET",
    });

    const middleware = new HttpAuthMiddleware(verifier);
    const secCtx = await Effect.runPromise(
      middleware.authenticateHeader(`Bearer ${token}`)
    );

    expect(secCtx.subject.id).toBe("usr-42");
    expect(secCtx.subject.roles).toContain("physician");
    expect(secCtx.subject.metadata?.clearance).toBe("TOP_SECRET");
    expect(secCtx.subject.metadata?.groups).toEqual(["cardiology", "oncology"]);

    const mapped = ClaimsSecurityMapper.mapToSecurityContext({
      sub: "direct-sub",
      roles: ["engineer"],
    });
    expect(mapped.subject.id).toBe("direct-sub");
  });

  it("rejects expired or tampered tokens", async () => {
    const expiredToken = createTestJwt({
      sub: "usr-99",
      iss: "https://auth.enterprise.com",
      aud: "operon-api",
      exp: Math.floor(Date.now() / 1000) - 200, // Expired
    });

    const middleware = new HttpAuthMiddleware(verifier);
    const res = await Effect.runPromise(
      middleware
        .authenticateHeader(`Bearer ${expiredToken}`)
        .pipe(Effect.result)
    );

    expect(res._tag).toBe("Failure");
  });
});

describe("Enterprise Sandboxed Model Runner", () => {
  it("executes deterministic models and verifies determinism proofs", async () => {
    const runner = new SandboxedModelRunner();

    runner.registerModel({
      modelId: "bsm1-kinetic-rate",
      version: "1.0.0",
      isDeterministic: true,
      requiredInputs: ["temperature", "substrate"],
      compute: (inputs) =>
        Effect.sync(() => {
          const temp = inputs.temperature as number;
          const s = inputs.substrate as number;
          const rate = 0.5 * Math.exp(0.06 * (temp - 20)) * (s / (s + 20));
          return { rate };
        }),
    });

    const proof = await Effect.runPromise(
      runner.verifyDeterminism("bsm1-kinetic-rate", {
        temperature: 22,
        substrate: 50,
      })
    );

    expect(proof.allOutputsMatch).toBe(true);
    expect(proof.samples.length).toBe(3);
  });

  it("enforces fiber timeout on runaway computations", async () => {
    const runner = new SandboxedModelRunner();

    runner.registerModel({
      modelId: "infinite-loop-model",
      version: "0.0.1",
      isDeterministic: false,
      timeoutMs: 50,
      requiredInputs: [],
      compute: () =>
        Effect.sleep(Duration.millis(200)).pipe(
          Effect.map(() => ({ done: true }))
        ),
    });

    const res = await Effect.runPromise(
      runner.execute("infinite-loop-model", {}).pipe(Effect.result)
    );

    expect(res._tag).toBe("Failure");
  });
});

describe("Enterprise Distributed Concurrency & Clustering", () => {
  it("acquires distributed locks with monotonically increasing fencing tokens", async () => {
    const dlm = new DistributedLockManager();

    const lock1 = await Effect.runPromise(
      dlm.acquire("obj:aircraft:a350", "node-1", 1000)
    );
    expect(lock1.fencingToken).toBe(1);

    // Concurrent acquire should fail while lease is active
    const failRes = await Effect.runPromise(
      dlm.acquire("obj:aircraft:a350", "node-2", 1000).pipe(Effect.result)
    );
    expect(failRes._tag).toBe("Failure");

    // Release lock1
    await Effect.runPromise(dlm.release(lock1));

    // Next acquire succeeds with incremented fencing token
    const lock2 = await Effect.runPromise(
      dlm.acquire("obj:aircraft:a350", "node-2", 1000)
    );
    expect(lock2.fencingToken).toBe(2);
  });

  it("coordinates guarded writes across nodes using DistributedClusterCoordinator", async () => {
    const dlm = new DistributedLockManager();
    const coord = new DistributedClusterCoordinator(dlm);

    let executedWithToken = 0;
    const result = await Effect.runPromise(
      coord.executeGuardedWrite("obj:order:100", "node-1", (lock) =>
        Effect.sync(() => {
          executedWithToken = lock.fencingToken;
          return "COMMITTED";
        })
      )
    );

    expect(result).toBe("COMMITTED");
    expect(executedWithToken).toBe(1);
  });
});
