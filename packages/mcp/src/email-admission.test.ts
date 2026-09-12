import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CellAuth, CellSessionVerifier } from "@operon/cell-auth";
import {
  AccountableIngestionService,
  InMemoryAuditStore,
  InMemoryObjectStore,
  OntologyMetadataService,
  ReconciliationService,
  SessionVerifier,
} from "@operon/runtime";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type { ApproverBinding, McpKey } from "./index.js";
import { createOperonMcpServer, unboundApprover } from "./index.js";

const consumerKey: McpKey = {
  agentId: "companion-consumer",
  agentTier: 2,
  keyId: "ck-companion",
  name: "Companion",
  role: "consumer",
};

const builderKey: McpKey = {
  agentId: "companion-builder",
  agentTier: 4,
  keyId: "bk-companion",
  name: "Companion Builder",
  role: "builder",
};

const mailbox = [
  {
    displayName: "Ana Silva",
    email: "Ana.Silva@Unimed.com.br",
    threadId: "thread-1",
  },
  { displayName: "Bruno Lima", email: "bruno@gmail.com", threadId: "thread-2" },
  {
    displayName: "Carla Souza",
    email: "carla@unimed.com.br",
    threadId: "thread-3",
  },
];

interface Harness {
  readonly objectStore: InMemoryObjectStore;
  readonly ingestionService: AccountableIngestionService;
  readonly reconciliationService: ReconciliationService;
}

async function connect(
  key: McpKey,
  harness: Harness,
  approver: ApproverBinding = unboundApprover
): Promise<Client> {
  const server = createOperonMcpServer({
    actionTypes: [],
    approver,
    auditStore: new InMemoryAuditStore(),
    defaultCallerKey: key,
    ingestionService: harness.ingestionService,
    objectStore: harness.objectStore,
    objectTypes: [],
    oms: new OntologyMetadataService(),
    reconciliationService: harness.reconciliationService,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: `test-${key.role}`, version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return client;
}

interface OwnerSession {
  readonly binding: ApproverBinding;
  readonly userId: string;
  readonly verifier: SessionVerifier["Service"];
}

/** The clinic owner with a live session on a memory-backed cell auth store. */
async function issueOwnerSession(): Promise<OwnerSession> {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* CellAuth;
      const verifier = yield* SessionVerifier;
      const issued = yield* auth.issueApproverSession({
        email: "owner@clinica.example",
        name: "Dona da clínica",
      });
      return {
        binding: { _tag: "Session", token: issued.token, verifier },
        userId: issued.userId,
        verifier,
      } satisfies OwnerSession;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          CellSessionVerifier,
          CellAuth.layer({
            secret: Redacted.make("email-admission-secret-32-chars!!!"),
            store: { kind: "memory" },
          })
        )
      ),
      Effect.scoped
    )
  );
}

async function call(client: Client, name: string, args: object) {
  const res = (await client.callTool({
    arguments: args as Record<string, unknown>,
    name,
  })) as { isError?: boolean; content: { text: string }[] };
  return { body: JSON.parse(res.content[0].text), isError: res.isError };
}

function makeHarness(): Harness {
  const objectStore = new InMemoryObjectStore();
  return {
    ingestionService: new AccountableIngestionService(objectStore),
    objectStore,
    reconciliationService: ReconciliationService.make(),
  };
}

async function ingestAndPropose(builder: Client) {
  const ingest = await call(builder, "operon_ingest_source", {
    idempotencyKey: "gmail-sync-1",
    locator: "gmail://inbox+sent/last-30-days",
    mediaType: "application/json",
    payload: mailbox,
    tenantId: "clinic",
  });
  expect(ingest.isError).toBeFalsy();
  const sourceId: string = ingest.body.sourceArtifact.sourceId;

  const propose = await call(builder, "operon_propose_mapping", {
    definitionDigest: "def_pessoa_v1",
    primaryKeyField: "email",
    propertyMappings: [
      { sourceField: "displayName", targetPropertyName: "displayName" },
      { sourceField: "email", targetPropertyName: "email" },
    ],
    sourceIds: [sourceId],
    targetObjectTypeId: "Pessoa",
    tenantId: "clinic",
  });
  expect(propose.isError).toBeFalsy();
  return { proposal: propose.body, sourceId };
}

describe("email magic factor through MCP (Q -> C -> L)", () => {
  it("lets a Consumer see quarantine and candidates before anything is an object", async () => {
    const harness = makeHarness();
    const builder = await connect(builderKey, harness);
    const consumer = await connect(consumerKey, harness);
    const { proposal, sourceId } = await ingestAndPropose(builder);

    expect(proposal.status).toBe("open");
    expect(proposal.confidence).toBe(1);
    expect(proposal.digest).toHaveLength(64);

    const all = await call(consumer, "operon_search_quarantine", {
      tenantId: "clinic",
    });
    expect(all.isError).toBeFalsy();
    expect(all.body.count).toBe(6);
    expect(all.body.hits.map((h: any) => h.admission.grade)).toEqual([
      "quarantine",
      "quarantine",
      "quarantine",
      "candidate",
      "candidate",
      "candidate",
    ]);

    const ana = await call(consumer, "operon_search_quarantine", {
      tenantId: "clinic",
      text: "ana silva",
    });
    expect(ana.body.count).toBe(2);
    expect(ana.body.hits[0]).toEqual({
      admission: {
        batchId: expect.any(String),
        grade: "quarantine",
        itemIndex: 0,
        locator: "gmail://inbox+sent/last-30-days",
        receivedAt: expect.any(Number),
        sourceId,
      },
      item: mailbox[0],
    });
    expect(ana.body.hits[1].admission).toEqual({
      confidence: 1,
      grade: "candidate",
      mappingProposalId: proposal.proposalId,
      proposalDigest: proposal.digest,
      rawRecordId: "Ana.Silva@Unimed.com.br",
      reviewStage: "open",
      targetObjectTypeId: "Pessoa",
    });

    const objects = await call(consumer, "operon_query_objects", {
      typeId: "Pessoa",
    });
    expect(objects.body.count).toBe(0);

    const admission = await call(consumer, "operon_get_admission", {
      objectId: "bruno@gmail.com",
      typeId: "Pessoa",
    });
    expect(admission.body).toEqual({
      admission: null,
      objectId: "bruno@gmail.com",
      typeId: "Pessoa",
    });
  });

  it("refuses Consumer keys on review and admission, self review, stale digests and unreviewed merges", async () => {
    const harness = makeHarness();
    const builder = await connect(builderKey, harness);
    const consumer = await connect(consumerKey, harness);
    const { proposal } = await ingestAndPropose(builder);

    const consumerReview = await call(
      consumer,
      "operon_review_mapping_proposal",
      {
        proposalId: proposal.proposalId,
        reviewerId: "owner-clinic",
        verdict: "approve",
        viewedDigest: proposal.digest,
      }
    );
    expect(consumerReview.isError).toBe(true);
    expect(consumerReview.body.error).toBe("McpSecurityError");

    const consumerAdmit = await call(
      consumer,
      "operon_admit_mapping_proposal",
      { proposalId: proposal.proposalId }
    );
    expect(consumerAdmit.isError).toBe(true);
    expect(consumerAdmit.body.error).toBe("McpSecurityError");

    const unboundReview = await call(
      builder,
      "operon_review_mapping_proposal",
      {
        proposalId: proposal.proposalId,
        reviewerId: "owner-clinic",
        verdict: "approve",
        viewedDigest: proposal.digest,
      }
    );
    expect(unboundReview.isError).toBe(true);
    expect(unboundReview.body.error).toBe("ApproverNotBoundError");

    const unboundAdmit = await call(builder, "operon_admit_mapping_proposal", {
      proposalId: proposal.proposalId,
    });
    expect(unboundAdmit.isError).toBe(true);
    expect(unboundAdmit.body.error).toBe("ApproverNotBoundError");

    const owner = await issueOwnerSession();
    const boundBuilder = await connect(builderKey, harness, owner.binding);
    const staleReview = await call(
      boundBuilder,
      "operon_review_mapping_proposal",
      {
        proposalId: proposal.proposalId,
        verdict: "approve",
        viewedDigest: "0".repeat(64),
      }
    );
    expect(staleReview.isError).toBe(true);
    expect(staleReview.body.error).toBe("StaleReviewError");

    const admitUnreviewed = await call(
      boundBuilder,
      "operon_admit_mapping_proposal",
      { proposalId: proposal.proposalId }
    );
    expect(admitUnreviewed.isError).toBe(true);
    expect(admitUnreviewed.body).toEqual({
      details: undefined,
      error: "ApprovalsPolicyViolationError",
      message: expect.any(String),
    });

    const people = await Effect.runPromise(
      harness.objectStore.findObjects("Pessoa" as any)
    );
    expect(people).toEqual([]);
  });

  it("refuses review and admit when the bound Better Auth token is unknown", async () => {
    const harness = makeHarness();
    const owner = await issueOwnerSession();
    const builder = await connect(builderKey, harness, {
      _tag: "Session",
      token: Redacted.make("not-a-session"),
      verifier: owner.verifier,
    });
    const { proposal } = await ingestAndPropose(builder);

    const review = await call(builder, "operon_review_mapping_proposal", {
      proposalId: proposal.proposalId,
      reviewerId: "spoofed-owner",
      verdict: "approve",
      viewedDigest: proposal.digest,
    });
    expect(review.isError).toBe(true);
    expect(review.body.error).toBe("AuthenticationError");

    const admit = await call(builder, "operon_admit_mapping_proposal", {
      proposalId: proposal.proposalId,
    });
    expect(admit.isError).toBe(true);
    expect(admit.body.error).toBe("AuthenticationError");
  });

  it("admits one approved digest to main at grade batch and clears the candidates", async () => {
    const harness = makeHarness();
    const owner = await issueOwnerSession();
    const builder = await connect(builderKey, harness, owner.binding);
    const consumer = await connect(consumerKey, harness);
    const { proposal } = await ingestAndPropose(builder);

    const review = await call(builder, "operon_review_mapping_proposal", {
      comments: "As 3 pessoas com quem falei nos últimos 30 dias",
      proposalId: proposal.proposalId,
      reviewerId: "spoofed-owner",
      reviewerRoles: ["owner"],
      verdict: "approve",
      viewedDigest: proposal.digest,
    });
    expect(review.isError).toBeFalsy();
    expect(review.body.status).toBe("approved");
    expect(review.body.reviews).toEqual([
      {
        comments: "As 3 pessoas com quem falei nos últimos 30 dias",
        reviewedAt: expect.any(Number),
        reviewer: {
          id: owner.userId,
          metadata: {
            email: "owner@clinica.example",
            issuer: "operon-cell",
            sessionId: expect.any(String),
          },
          name: "Dona da clínica",
          roles: ["approver"],
          type: "user",
        },
        verdict: "approve",
      },
    ]);

    const admit = await call(builder, "operon_admit_mapping_proposal", {
      proposalId: proposal.proposalId,
    });
    expect(admit.isError).toBeFalsy();
    expect(admit.body.status).toBe("merged");

    const people = await call(consumer, "operon_query_objects", {
      typeId: "Pessoa",
    });
    expect(people.body.count).toBe(3);
    expect(people.body.objects.map((o: any) => o.id)).toEqual([
      "Ana.Silva@Unimed.com.br",
      "bruno@gmail.com",
      "carla@unimed.com.br",
    ]);

    const admission = await call(consumer, "operon_get_admission", {
      objectId: "carla@unimed.com.br",
      typeId: "Pessoa",
    });
    expect(admission.body.admission).toEqual({
      admittedAt: expect.any(Number),
      admittedBy: {
        agentTier: 4,
        id: "companion-builder",
        name: "Companion Builder",
        roles: ["ai_agent"],
        type: "agent",
      },
      grade: "batch",
      mappingProposalId: proposal.proposalId,
      objectId: "carla@unimed.com.br",
      proposalDigest: proposal.digest,
      typeId: "Pessoa",
    });

    const candidates = await call(consumer, "operon_search_quarantine", {
      grade: "candidate",
      tenantId: "clinic",
    });
    expect(candidates.body).toEqual({ count: 0, hits: [] });

    const quarantine = await call(consumer, "operon_search_quarantine", {
      grade: "quarantine",
      tenantId: "clinic",
    });
    expect(quarantine.body.count).toBe(3);
  });

  it("derives email and domain identity keys and feeds identity resolution", async () => {
    const harness = makeHarness();
    const builder = await connect(builderKey, harness);
    const consumer = await connect(consumerKey, harness);

    const ana = await call(consumer, "operon_derive_identity_keys", {
      email: " Ana.Silva@Unimed.com.br ",
    });
    expect(ana.isError).toBeFalsy();
    expect(ana.body).toEqual({
      organization: {
        confidence: 0.95,
        key: { kind: "domain", value: "unimed.com.br" },
        status: "derived",
      },
      person: {
        confidence: 1,
        key: { kind: "email", value: "ana.silva@unimed.com.br" },
      },
    });

    const bruno = await call(consumer, "operon_derive_identity_keys", {
      email: "bruno@gmail.com",
    });
    expect(bruno.body.organization).toEqual({
      domain: "gmail.com",
      status: "suppressed",
    });

    const noreply = await call(consumer, "operon_derive_identity_keys", {
      email: "noreply@unimed.com.br",
      suppressedDomains: ["unimed.com.br"],
    });
    expect(noreply.body.organization).toEqual({
      domain: "unimed.com.br",
      status: "suppressed",
    });

    const gmailEmptyExtras = await call(
      consumer,
      "operon_derive_identity_keys",
      {
        email: "bruno@gmail.com",
        suppressedDomains: [],
      }
    );
    expect(gmailEmptyExtras.body.organization).toEqual({
      domain: "gmail.com",
      status: "suppressed",
    });

    const forgedOrg = await call(
      builder,
      "operon_propose_identity_resolution",
      {
        action: "link",
        confidence: 0.95,
        key: { kind: "domain", value: "gmail.com" },
        targetCanonicalId: "org-gmail",
      }
    );
    expect(forgedOrg.isError).toBe(true);
    expect(forgedOrg.body.error).toBe("InvalidIdentityKey");

    const invalid = await call(consumer, "operon_derive_identity_keys", {
      email: "not-an-address",
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.body.error).toBe("InvalidEmailAddress");

    const rawKey = await call(builder, "operon_propose_identity_resolution", {
      action: "link",
      confidence: 1,
      key: { kind: "email", value: "Ana.Silva@Unimed.com.br" },
      targetCanonicalId: "pessoa-ana",
    });
    expect(rawKey.isError).toBe(true);
    expect(rawKey.body.error).toBe("InvalidIdentityKey");

    const proposed = await call(builder, "operon_propose_identity_resolution", {
      action: "link",
      confidence: ana.body.person.confidence,
      key: ana.body.person.key,
      proposalId: "idp-ana-email",
      targetCanonicalId: "pessoa-ana",
    });
    expect(proposed.isError).toBeFalsy();
    expect(proposed.body.key).toEqual({
      kind: "email",
      value: "ana.silva@unimed.com.br",
    });
    expect(proposed.body.status).toBe("proposed");

    const resolved = await call(builder, "operon_resolve_identity", {
      decisionRef: "digest-lote-30-dias",
      proposalId: "idp-ana-email",
    });
    expect(resolved.isError).toBeFalsy();
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.historicalReferences).toEqual([
      "email:ana.silva@unimed.com.br",
    ]);
    expect(resolved.body.invalidatedProjections).toEqual([
      "projection:email:ana.silva@unimed.com.br",
      "projection:canonical:pessoa-ana",
    ]);

    const org = await call(builder, "operon_propose_identity_resolution", {
      action: "link",
      confidence: ana.body.organization.confidence,
      key: ana.body.organization.key,
      proposalId: "idp-unimed-domain",
      targetCanonicalId: "org-unimed",
    });
    expect(org.body.key).toEqual({ kind: "domain", value: "unimed.com.br" });

    const listed = await call(consumer, "operon_list_identity_proposals", {});
    expect(listed.body.map((p: any) => p.proposalId)).toEqual([
      "idp-ana-email",
      "idp-unimed-domain",
    ]);
  });
});
