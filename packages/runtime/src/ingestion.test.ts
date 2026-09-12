import type { ObjectTypeId, Subject } from "@operon/schema";
import { computeMappingProposalDigest } from "@operon/schema";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  SelfReviewDeniedError,
  StaleReviewError,
} from "./errors.js";
import { AccountableIngestionService } from "./funnel.js";
import {
  ContradictoryInputError,
  CorruptInputError,
  HumanReviewRequiredError,
  UnknownSourceError,
} from "./ingestion-errors.js";
import { InMemoryObjectStore } from "./object-store.js";
import { ApprovalsPolicyViolationError } from "./oms.js";

describe("AccountableIngestionService (V0-CH-05)", () => {
  const author: Subject = {
    id: "fde-agent-1",
    name: "FDE Agent",
    roles: ["fde_agent"],
    type: "agent",
  };
  const owner: Subject = {
    id: "owner-clinic",
    name: "Dona da Clínica",
    roles: ["owner"],
    type: "user",
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

    // 3. Admission without a human approval is refused and does not write
    const refused = await Effect.runPromise(
      ingestion.admitProposal(proposal.proposalId, author).pipe(Effect.flip)
    );
    expect(refused).toBeInstanceOf(ApprovalsPolicyViolationError);
    expect((refused as ApprovalsPolicyViolationError).reason).toBe(
      "Requires at least 1 approvals; found 0"
    );
    expect(
      await Effect.runPromise(
        store.getObject("Patient" as ObjectTypeId, "P999")
      )
    ).toBeUndefined();

    // 4. Only a reviewed, approved batch writes candidate records to the store
    await Effect.runPromise(
      ingestion.reviewProposal({
        proposalId: proposal.proposalId,
        review: {
          comments: "Digest checked",
          reviewedAt: 1_000,
          reviewer: owner,
          verdict: "approve",
        },
        viewedDigest: proposal.digest,
      })
    );
    const merged = await Effect.runPromise(
      ingestion.admitProposal(proposal.proposalId, author)
    );
    expect(merged.status).toBe("merged");

    const objectAfter = await Effect.runPromise(
      store.getObject("Patient" as ObjectTypeId, "P999")
    );
    expect(objectAfter).toBeDefined();
    expect(objectAfter?.properties["name"]).toBe("Eve Unadmitted");
  });
});

describe("batch admission (Q -> C -> L -> D)", () => {
  const builder: Subject = {
    id: "fde-agent-1",
    name: "FDE Agent",
    roles: ["fde_agent"],
    type: "agent",
  };
  const owner: Subject = {
    id: "owner-clinic",
    name: "Dona da Clínica",
    roles: ["owner"],
    type: "user",
  };

  const mailbox = [
    {
      displayName: "Ana Silva",
      email: "ana.silva@unimed.com.br",
      threadId: "t-1",
    },
    { displayName: "Bruno Lima", email: "bruno@gmail.com", threadId: "t-2" },
  ];

  async function proposePeople(ingestion: AccountableIngestionService) {
    const receipt = await Effect.runPromise(
      ingestion.ingestRawSource({
        locator: "gmail://inbox/2026-09",
        mediaType: "application/json",
        rawPayload: mailbox,
        tenantId: "clinic",
      })
    );
    const proposal = await Effect.runPromise(
      ingestion.proposeMapping({
        author: builder,
        definitionDigest: "def_pessoa_v1",
        primaryKeyField: "email",
        propertyMappings: [
          { sourceField: "displayName", targetPropertyName: "displayName" },
          { sourceField: "email", targetPropertyName: "email" },
        ],
        sourceIds: [receipt.sourceArtifact.sourceId],
        targetObjectTypeId: "Pessoa" as ObjectTypeId,
        tenantId: "clinic",
      })
    );
    return { proposal, receipt };
  }

  it("opens a mapping proposal with a digest, no reviews and real confidence", async () => {
    const ingestion = new AccountableIngestionService(
      new InMemoryObjectStore()
    );
    const { proposal } = await proposePeople(ingestion);

    expect(proposal.status).toBe("open");
    expect(proposal.reviews).toEqual([]);
    expect(proposal.digest).toHaveLength(64);
    expect(proposal.digest).toBe(
      computeMappingProposalDigest({
        definitionDigest: proposal.definitionDigest,
        openQuestions: proposal.openQuestions,
        primaryKeyField: "email",
        propertyMappings: proposal.propertyMappings,
        records: proposal.records,
        sources: proposal.sources,
        targetObjectTypeId: "Pessoa" as ObjectTypeId,
      })
    );
    expect(proposal.confidence).toBe(1);
    expect(proposal.records.map((r) => r.confidence)).toEqual([1, 1]);
  });

  it("lowers candidate confidence when mapped fields are missing", async () => {
    const ingestion = new AccountableIngestionService(
      new InMemoryObjectStore()
    );
    const receipt = await Effect.runPromise(
      ingestion.ingestRawSource({
        locator: "gmail://inbox/partial",
        mediaType: "application/json",
        rawPayload: [{ email: "carla@unimed.com.br" }],
      })
    );
    const proposal = await Effect.runPromise(
      ingestion.proposeMapping({
        author: builder,
        definitionDigest: "def_pessoa_v1",
        primaryKeyField: "email",
        propertyMappings: [
          { sourceField: "displayName", targetPropertyName: "displayName" },
          { sourceField: "email", targetPropertyName: "email" },
        ],
        sourceIds: [receipt.sourceArtifact.sourceId],
        targetObjectTypeId: "Pessoa" as ObjectTypeId,
      })
    );
    expect(proposal.records[0].confidence).toBe(0.5);
    expect(proposal.confidence).toBe(0.5);
  });

  it("searches quarantine and candidates without any object in main", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);
    const { proposal, receipt } = await proposePeople(ingestion);

    const hits = await Effect.runPromise(
      ingestion.searchQuarantine({ tenantId: "clinic", text: "ana" })
    );
    expect(hits).toEqual([
      {
        admission: {
          batchId: receipt.batchId,
          grade: "quarantine",
          itemIndex: 0,
          locator: "gmail://inbox/2026-09",
          receivedAt: receipt.sourceArtifact.receivedAt,
          sourceId: receipt.sourceArtifact.sourceId,
        },
        item: mailbox[0],
      },
      {
        admission: {
          confidence: 1,
          grade: "candidate",
          mappingProposalId: proposal.proposalId,
          proposalDigest: proposal.digest,
          rawRecordId: "ana.silva@unimed.com.br",
          reviewStage: "open",
          targetObjectTypeId: "Pessoa",
        },
        record: proposal.records[0],
      },
    ]);

    const onlyCandidates = await Effect.runPromise(
      ingestion.searchQuarantine({ grade: "candidate", tenantId: "clinic" })
    );
    expect(onlyCandidates.map((h) => h.admission.grade)).toEqual([
      "candidate",
      "candidate",
    ]);

    expect(
      await Effect.runPromise(store.findObjects("Pessoa" as ObjectTypeId))
    ).toEqual([]);
  });

  it("refuses agent reviewers, self review and stale digests", async () => {
    const ingestion = new AccountableIngestionService(
      new InMemoryObjectStore()
    );
    const { proposal } = await proposePeople(ingestion);

    const agentReview = await Effect.runPromise(
      ingestion
        .reviewProposal({
          proposalId: proposal.proposalId,
          review: {
            comments: "LLM says ok",
            reviewedAt: 1,
            reviewer: {
              id: "llm-reviewer",
              name: "LLM",
              roles: ["ai_agent"],
              type: "agent",
            },
            verdict: "approve",
          },
          viewedDigest: proposal.digest,
        })
        .pipe(Effect.flip)
    );
    expect(agentReview).toBeInstanceOf(HumanReviewRequiredError);

    const selfReview = await Effect.runPromise(
      ingestion
        .reviewProposal({
          proposalId: proposal.proposalId,
          review: {
            comments: "approving my own batch",
            reviewedAt: 1,
            reviewer: { ...builder, type: "user" },
            verdict: "approve",
          },
          viewedDigest: proposal.digest,
        })
        .pipe(Effect.flip)
    );
    expect(selfReview).toBeInstanceOf(SelfReviewDeniedError);

    const stale = await Effect.runPromise(
      ingestion
        .reviewProposal({
          proposalId: proposal.proposalId,
          review: {
            comments: "saw an older digest",
            reviewedAt: 1,
            reviewer: owner,
            verdict: "approve",
          },
          viewedDigest: "0".repeat(64),
        })
        .pipe(Effect.flip)
    );
    expect(stale).toBeInstanceOf(StaleReviewError);

    const untouched = await Effect.runPromise(
      ingestion.getProposal(proposal.proposalId)
    );
    expect(untouched.status).toBe("open");
    expect(untouched.reviews).toEqual([]);
  });

  it("rejects a batch and keeps quarantine navigable", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);
    const { proposal } = await proposePeople(ingestion);

    const rejected = await Effect.runPromise(
      ingestion.reviewProposal({
        proposalId: proposal.proposalId,
        review: {
          comments: "too broad",
          reviewedAt: 5,
          reviewer: owner,
          verdict: "reject",
        },
        viewedDigest: proposal.digest,
      })
    );
    expect(rejected.status).toBe("rejected");

    const refused = await Effect.runPromise(
      ingestion.admitProposal(proposal.proposalId, builder).pipe(Effect.flip)
    );
    expect(refused).toBeInstanceOf(ApprovalsPolicyViolationError);

    const hits = await Effect.runPromise(
      ingestion.searchQuarantine({ tenantId: "clinic" })
    );
    expect(hits.map((h) => h.admission.grade)).toEqual([
      "quarantine",
      "quarantine",
    ]);
  });

  it("admits an approved batch to main at grade batch and replays merges", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);
    const { proposal } = await proposePeople(ingestion);

    const approved = await Effect.runPromise(
      ingestion.reviewProposal({
        proposalId: proposal.proposalId,
        review: {
          comments: "people I talked to this month",
          reviewedAt: 7,
          reviewer: owner,
          verdict: "approve",
        },
        viewedDigest: proposal.digest,
      })
    );
    expect(approved.status).toBe("approved");

    const merged = await Effect.runPromise(
      ingestion.admitProposal(proposal.proposalId, builder)
    );
    expect(merged.status).toBe("merged");

    const people = await Effect.runPromise(
      store.findObjects("Pessoa" as ObjectTypeId)
    );
    expect(people.map((p) => p.id)).toEqual([
      "ana.silva@unimed.com.br",
      "bruno@gmail.com",
    ]);

    const admission = await Effect.runPromise(
      ingestion.admissionOf("Pessoa" as ObjectTypeId, "bruno@gmail.com")
    );
    const recorded = Option.getOrThrow(admission);
    expect(recorded.grade).toBe("batch");
    expect(recorded.objectId).toBe("bruno@gmail.com");
    expect(recorded.typeId).toBe("Pessoa");
    expect(recorded.admittedBy).toEqual(builder);
    expect(recorded.mappingProposalId).toBe(proposal.proposalId);
    expect(recorded.proposalDigest).toBe(proposal.digest);

    const replay = await Effect.runPromise(
      ingestion.admitProposal(proposal.proposalId, builder)
    );
    expect(replay).toEqual(merged);
    const peopleAfterReplay = await Effect.runPromise(
      store.findObjects("Pessoa" as ObjectTypeId)
    );
    expect(peopleAfterReplay).toHaveLength(2);

    const candidatesLeft = await Effect.runPromise(
      ingestion.searchQuarantine({ grade: "candidate", tenantId: "clinic" })
    );
    expect(candidatesLeft).toEqual([]);
  });

  it("reports decision grade for objects an executed Action wrote", async () => {
    const store = new InMemoryObjectStore();
    const ingestion = new AccountableIngestionService(store);
    await Effect.runPromise(
      store.putObject({
        id: "log_dec_1",
        lastModifiedAt: 10,
        properties: {
          actionTypeId: "cancelar_consulta",
          decisionRecordId: "dec_1",
          recordHash: "hash_1",
          status: "executed",
          targetObjectId: "C-1",
          targetObjectTypeId: "Consulta",
        },
        typeId: "ActionLog" as ObjectTypeId,
        version: 1,
      })
    );

    const admission = await Effect.runPromise(
      ingestion.admissionOf("Consulta" as ObjectTypeId, "C-1")
    );
    expect(Option.getOrThrow(admission)).toEqual({
      decisionRecordId: "dec_1",
      grade: "decision",
      objectId: "C-1",
      recordHash: "hash_1",
      typeId: "Consulta",
    });

    const unknown = await Effect.runPromise(
      ingestion.admissionOf("Consulta" as ObjectTypeId, "C-2")
    );
    expect(Option.isNone(unknown)).toBe(true);
  });
});
