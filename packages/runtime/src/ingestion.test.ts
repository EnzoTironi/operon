import type { ObjectTypeId, Subject } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { IdempotencyConflictError } from "./errors.js";
import { AccountableIngestionService } from "./funnel.js";
import {
  ContradictoryInputError,
  CorruptInputError,
  UnknownSourceError,
} from "./ingestion-errors.js";
import { InMemoryObjectStore } from "./object-store.js";

describe("AccountableIngestionService (V0-CH-05)", () => {
  const author: Subject = {
    id: "fde-agent-1",
    name: "FDE Agent",
    roles: ["fde_agent"],
    type: "agent",
  };

  it("ingests raw source and supports idempotent replay with identical receipt", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const payload = [{ id: "FL-101", origin: "JFK", destination: "LHR" }];
    const receipt1 = await Effect.runPromise(
      ingestion.ingestRawSource({
        idempotencyKey: "ingest-key-101",
        locator: "s3://skywise-lake/flights/2026-09-10/batch1.json",
        mediaType: "application/json",
        rawPayload: payload,
        tenantId: "tenant_skywise",
      })
    );

    expect(receipt1.status).toBe("ingested");
    expect(receipt1.sourceArtifact.sourceId).toBeDefined();
    expect(receipt1.sourceArtifact.digest).toHaveLength(64);

    // Replay same source with same idempotency key and identical payload
    const receipt2 = await Effect.runPromise(
      ingestion.ingestRawSource({
        idempotencyKey: "ingest-key-101",
        locator: "s3://skywise-lake/flights/2026-09-10/batch1.json",
        mediaType: "application/json",
        rawPayload: payload,
        tenantId: "tenant_skywise",
      })
    );

    expect(receipt2.status).toBe("replayed");
    expect(receipt2.sourceArtifact.sourceId).toBe(
      receipt1.sourceArtifact.sourceId
    );
    expect(receipt2.batchId).toBe(receipt1.batchId);
  });

  it("fails with IdempotencyConflictError when same key has different payload", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    await Effect.runPromise(
      ingestion.ingestRawSource({
        idempotencyKey: "key-conflict-test",
        locator: "kafka://telemetry.sensor/0",
        mediaType: "application/json",
        rawPayload: { sensor: "S1", temp: 21.5 },
      })
    );

    const error = await Effect.runPromise(
      ingestion
        .ingestRawSource({
          idempotencyKey: "key-conflict-test",
          locator: "kafka://telemetry.sensor/0",
          mediaType: "application/json",
          rawPayload: { sensor: "S1", temp: 99.9 }, // Conflicting payload
        })
        .pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).idempotencyKey).toBe(
      "key-conflict-test"
    );
  });

  it("fails with CorruptInputError for empty or malformed input", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const emptyErr = await Effect.runPromise(
      ingestion
        .ingestRawSource({
          locator: "upload://empty.json",
          mediaType: "application/json",
          rawPayload: "",
        })
        .pipe(Effect.flip)
    );
    expect(emptyErr).toBeInstanceOf(CorruptInputError);

    const malformedErr = await Effect.runPromise(
      ingestion
        .ingestRawSource({
          locator: "upload://broken.json",
          mediaType: "application/json",
          rawPayload: "{ invalid json ...",
        })
        .pipe(Effect.flip)
    );
    expect(malformedErr).toBeInstanceOf(CorruptInputError);
  });

  it("does not disclose source existence on tenant mismatch", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const receipt = await Effect.runPromise(
      ingestion.ingestRawSource({
        locator: "s3://records/data.json",
        mediaType: "application/json",
        rawPayload: { foo: "bar" },
        tenantId: "tenant_alpha",
      })
    );

    // Matching tenant succeeds
    const source = await Effect.runPromise(
      ingestion.getSource(receipt.sourceArtifact.sourceId, "tenant_alpha")
    );
    expect(source.sourceId).toBe(receipt.sourceArtifact.sourceId);

    // Mismatched tenant fails with identical UnknownSourceError as non-existent
    const error = await Effect.runPromise(
      ingestion
        .getSource(receipt.sourceArtifact.sourceId, "tenant_bravo")
        .pipe(Effect.flip)
    );
    expect(error).toBeInstanceOf(UnknownSourceError);
    expect((error as UnknownSourceError).sourceId).toBe(
      receipt.sourceArtifact.sourceId
    );
  });

  it("tracks complete field-level provenance across mapped candidate records", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const receipt = await Effect.runPromise(
      ingestion.ingestRawSource({
        locator: "s3://skywise/flights/day1.json",
        mediaType: "application/json",
        rawPayload: [
          { flightNumber: "AA100", originCode: "JFK", destCode: "LHR" },
        ],
      })
    );

    const proposal = await Effect.runPromise(
      ingestion.proposeMapping({
        author,
        definitionDigest: "def_sha256_mock",
        primaryKeyField: "flightNumber",
        propertyMappings: [
          { sourceField: "originCode", targetPropertyName: "origin" },
          { sourceField: "destCode", targetPropertyName: "destination" },
        ],
        sourceIds: [receipt.sourceArtifact.sourceId],
        targetObjectTypeId: "Flight" as ObjectTypeId,
      })
    );

    expect(proposal.records).toHaveLength(1);
    const candidate = proposal.records[0];
    expect(candidate.rawRecordId).toBe("AA100");
    expect(candidate.targetObjectTypeId).toBe("Flight");
    expect(candidate.properties).toEqual({
      destination: "LHR",
      origin: "JFK",
    });

    // Verify S15 provenance integrity: every accepted field resolves to artifact/locator/mapping/batch
    const originProv = candidate.provenance.fieldProvenances["origin"];
    expect(originProv.sourceId).toBe(receipt.sourceArtifact.sourceId);
    expect(originProv.locator).toBe("s3://skywise/flights/day1.json");
    expect(originProv.batchId).toBe(receipt.batchId);
    expect(originProv.digest).toBe(receipt.sourceArtifact.digest);
    expect(originProv.fieldPath).toBe("originCode");
  });

  it("detects contradictory input within a proposal and rejects with ContradictoryInputError", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const receipt = await Effect.runPromise(
      ingestion.ingestRawSource({
        locator: "s3://skywise/flights/conflicts.json",
        mediaType: "application/json",
        rawPayload: [
          { flightNumber: "AA100", origin: "JFK" },
          { flightNumber: "AA100", origin: "ORD" }, // Contradictory origin for same AA100!
        ],
      })
    );

    const error = await Effect.runPromise(
      ingestion
        .proposeMapping({
          author,
          definitionDigest: "def_sha256_mock",
          primaryKeyField: "flightNumber",
          propertyMappings: [
            { sourceField: "origin", targetPropertyName: "origin" },
          ],
          sourceIds: [receipt.sourceArtifact.sourceId],
          targetObjectTypeId: "Flight" as ObjectTypeId,
        })
        .pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(ContradictoryInputError);
    expect((error as ContradictoryInputError).recordId).toBe("AA100");
    expect((error as ContradictoryInputError).conflictingProperties).toContain(
      "origin"
    );
  });

  it("enforces S03 invariant: raw evidence cannot silently become admitted truth", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const receipt = await Effect.runPromise(
      ingestion.ingestRawSource({
        locator: "s3://lake/record.json",
        mediaType: "application/json",
        rawPayload: [{ id: "P999", name: "Eve Unadmitted" }],
      })
    );

    // 1. Raw ingestion has occurred, but Object Store MUST NOT contain the object!
    const objectBefore = await Effect.runPromise(
      store.getObject("Patient" as ObjectTypeId, "P999")
    );
    expect(objectBefore).toBeUndefined();

    // 2. Proposing mapping also does NOT mutate the object store
    const proposal = await Effect.runPromise(
      ingestion.proposeMapping({
        author,
        definitionDigest: "def_mock",
        primaryKeyField: "id",
        propertyMappings: [{ sourceField: "name", targetPropertyName: "name" }],
        sourceIds: [receipt.sourceArtifact.sourceId],
        targetObjectTypeId: "Patient" as ObjectTypeId,
      })
    );

    const objectDuring = await Effect.runPromise(
      store.getObject("Patient" as ObjectTypeId, "P999")
    );
    expect(objectDuring).toBeUndefined();

    // 3. Only explicit admission writes candidate records to canonical Object Store
    await Effect.runPromise(
      ingestion.admitProposal(proposal.proposalId, author)
    );

    const objectAfter = await Effect.runPromise(
      store.getObject("Patient" as ObjectTypeId, "P999")
    );
    expect(objectAfter).toBeDefined();
    expect(objectAfter?.properties["name"]).toBe("Eve Unadmitted");
  });
});
