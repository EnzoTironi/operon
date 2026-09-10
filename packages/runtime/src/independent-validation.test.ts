import { createHmac, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";

import type { ObjectInstance, Subject } from "@operon/schema";
import { defineActionType } from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { InMemoryAuditStore, computeRecordHash } from "./audit.js";
import { OidcTokenVerifier } from "./auth.js";
import { StorageError } from "./errors.js";
import { ActionInbox } from "./inbox.js";
import { InMemoryObjectStore } from "./object-store.js";
import { OntologyMetadataService } from "./oms.js";
import { SqlSchemaGenerator } from "./sql-store.js";
import type { ActionSubmission } from "./write-pipeline.js";
import { executeWritePipeline } from "./write-pipeline.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};

const enc = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

const reviewer: Subject = {
  id: "reviewer",
  name: "Reviewer",
  type: "user",
  roles: ["reviewer"],
};

const agent = (tier: 1 | 2 | 3 | 4 = 2): Subject => ({
  id: "agent",
  name: "Agent",
  type: "agent",
  roles: [],
  agentTier: tier,
});

const item = (version = 1): ObjectInstance => ({
  id: "item-1",
  typeId: "Item" as ObjectInstance["typeId"],
  version,
  properties: { value: version },
  lastModifiedAt: Date.now(),
});

const submit = (
  actionType: ActionSubmission["actionType"],
  subject = agent(),
  rawParameters: unknown = {}
): ActionSubmission => ({
  actionType,
  rawParameters,
  security: {
    subject,
    timestamp: Date.now(),
    correlationId: "independent-local-test",
  },
});

const emptyChanges = () => ({
  addedObjectTypes: [],
  modifiedObjectTypes: [],
  deletedObjectTypeIds: [],
  addedLinkTypes: [],
  modifiedLinkTypes: [],
  deletedLinkTypeIds: [],
  addedActionTypes: [],
  modifiedActionTypes: [],
  deletedActionTypeIds: [],
});

describe("Independent validation — safety invariants", () => {
  it("P03 rejects HS256 signed with an RSA verifier's public key", async () => {
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const header = enc({ alg: "HS256" });
    const payload = enc({
      sub: "synthetic",
      iss: "issuer",
      aud: "operon",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const data = `${header}.${payload}`;
    const signature = createHmac("sha256", publicKey)
      .update(data)
      .digest("base64url");
    const token = `${data}.${signature}`;
    const verifier = new OidcTokenVerifier({
      secretOrPublicKey: publicKey,
      expectedIssuer: "issuer",
      expectedAudience: "operon",
    });
    await expect(
      Effect.runPromise(verifier.verifyToken(token))
    ).rejects.toBeDefined();
  });

  for (const tier of [1, 3] as const) {
    it(`P05 tier ${tier} cannot execute without its required authority`, () =>
      Effect.gen(function* () {
        let externalCount = 0;
        const action = defineActionType({
          id: "tier_test",
          name: "Tier test",
          description: "Synthetic effect",
          parametersSchema: Schema.Struct({}),
          riskTier: "high",
          minimumAgentTier: tier,
          defaultExecutionMode: "automated",
          sideEffects: [
            {
              id: "counter",
              description: "local only",
              execute: () =>
                Effect.sync(() => {
                  externalCount++;
                }),
            },
          ],
        });
        yield* executeWritePipeline(
          submit(action, agent(tier)),
          new InMemoryObjectStore(),
          new InMemoryAuditStore()
        ).pipe(Effect.ignore);
        expect(externalCount).toBe(0);
      }).pipe(Effect.runPromise));
  }

  it("P06 cannot execute changed parameters with an old approval hash", async () => {
    const audit = new InMemoryAuditStore();
    const store = new InMemoryObjectStore();
    const inbox = new ActionInbox(audit, store);
    let executedAmount: number | undefined;
    const action = defineActionType({
      id: "amount",
      name: "Amount",
      description: "Synthetic effect",
      parametersSchema: Schema.Struct({ amount: Schema.Number }),
      riskTier: "high",
      minimumAgentTier: 2,
      defaultExecutionMode: "proposal",
      sideEffects: [
        {
          id: "capture",
          description: "local only",
          execute: (p) =>
            Effect.sync(() => {
              executedAmount = p.amount;
            }),
        },
      ],
    });
    const params = { amount: 1 };
    const submission = submit(action, agent(), params);
    const result = await Effect.runPromise(
      executeWritePipeline(submission, store, audit)
    );
    expect(result.status).toBe("proposed");
    const proposal = inbox.addProposal(submission, result.decisionRecord);
    params.amount = 999;
    const approved = await Effect.runPromise(
      inbox.approveProposal(proposal.id, reviewer, proposal.evidenceHash)
    ).then(
      () => true,
      () => false
    );
    // Freezing a snapshot OR rejecting the mutation is acceptable; executing 999 is not.
    expect(approved && executedAmount === 999).toBe(false);
  });

  it("P07 role not-an-admin does not qualify as admin", async () => {
    const audit = new InMemoryAuditStore();
    const store = new InMemoryObjectStore();
    const inbox = new ActionInbox(audit, store);
    const action = defineActionType({
      id: "roles",
      name: "Roles",
      description: "Local",
      parametersSchema: Schema.Struct({}),
      riskTier: "high",
      minimumAgentTier: 2,
      defaultExecutionMode: "proposal",
    });
    const submission = submit(action);
    const result = await Effect.runPromise(
      executeWritePipeline(submission, store, audit)
    );
    const p = inbox.addProposal(submission, result.decisionRecord);
    await expect(
      Effect.runPromise(
        inbox.approveProposal(p.id, { ...reviewer, roles: ["not-an-admin"] })
      )
    ).rejects.toBeDefined();
  });

  it("P08 a mandatory audit outage cannot leave an unrecorded committed mutation", async () => {
    const store = new InMemoryObjectStore();
    await Effect.runPromise(store.putObject(item()));
    const audit = new InMemoryAuditStore();
    audit.appendDecision = () =>
      Effect.fail(new StorageError({ message: "injected audit outage" }));
    const action = defineActionType({
      id: "audit_atomicity",
      name: "Audit",
      description: "Local",
      parametersSchema: Schema.Struct({}),
      riskTier: "high",
      minimumAgentTier: 4,
      defaultExecutionMode: "automated",
      mutation: () => Effect.succeed([item(2)]),
    });
    await expect(
      Effect.runPromise(
        executeWritePipeline(submit(action, agent(4)), store, audit)
      )
    ).rejects.toBeDefined();
    const currentItem = await Effect.runPromise(
      store.getObject(item().typeId, "item-1")
    );
    expect(currentItem?.version).toBe(1);
  });

  it("P10 SQLite historical query binds all placeholders", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) =>
        Effect.sync(() => {
          for (const sql of SqlSchemaGenerator.generateDDL("sqlite")) {
            db.exec(sql);
          }
          db.prepare(
            "INSERT INTO operon_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run("a", "Thing", 1, "{}", 0, null, 0, null, "main");
          const q = SqlSchemaGenerator.compileBitemporalQuery(
            "Thing",
            "a",
            100,
            100,
            "sqlite"
          );
          // Adapt the seed insertion if a legitimate schema migration changes the table.
          expect(db.prepare(q.sql).all(...(q.params as any[]))).toHaveLength(1);
        }),
      (db) => Effect.sync(() => db.close())
    ).pipe(Effect.runSync));

  it("P16 a rejected ontology proposal cannot merge", async () => {
    const oms = new OntologyMetadataService();
    await Effect.runPromise(oms.createBranch("change", reviewer));
    const p = await Effect.runPromise(
      oms.createProposal({
        author: { ...reviewer, id: "author-p16" },
        changeSet: emptyChanges(),
        description: "Test",
        sourceBranch: "change",
        title: "Test",
      })
    );
    await Effect.runPromise(
      oms.reviewProposal(p.id, {
        comments: "yes",
        reviewedAt: 1,
        reviewer,
        verdict: "approve",
      })
    );
    await Effect.runPromise(
      oms.reviewProposal(p.id, {
        comments: "no",
        reviewedAt: 2,
        reviewer: { ...reviewer, id: "other" },
        verdict: "reject",
      })
    );
    await expect(
      Effect.runPromise(oms.mergeProposal(p.id, reviewer))
    ).rejects.toBeDefined();
  });

  it("P17 specialist review cannot be ignored at merge", async () => {
    const oms = new OntologyMetadataService();
    await Effect.runPromise(oms.createBranch("change", reviewer));
    const p = await Effect.runPromise(
      oms.createProposal({
        author: { ...reviewer, id: "author-p17" },
        changeSet: emptyChanges(),
        description: "Test",
        sourceBranch: "change",
        title: "Test",
      })
    );
    await Effect.runPromise(
      oms.reviewProposal(p.id, {
        reviewer,
        verdict: "approve",
        comments: "yes",
        reviewedAt: 1,
      })
    );
    await expect(
      Effect.runPromise(
        oms.mergeProposal(p.id, reviewer, {
          requiredMinApprovals: 1,
          requireComplianceReview: false,
          requireDomainSpecialistReview: true,
        })
      )
    ).rejects.toBeDefined();
  });

  it("P20 audit hashing is stable across its persistence encoding", async () => {
    const audit = new InMemoryAuditStore();
    const r = await Effect.runPromise(
      audit.appendDecision({
        actionTypeId: "local",
        correlationId: "test",
        id: "record",
        outcome: "executed",
        parameters: {},
        reason: undefined,
        ruleVersion: "1",
        stateSnapshot: { agentTier: undefined },
        subject: reviewer,
        timestamp: 1,
        verdict: "allow",
      })
    );
    const serialized = JSON.stringify(r);
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    const { recordHash, ...body } = JSON.parse(serialized);
    expect(computeRecordHash(body, body.previousRecordHash)).toBe(recordHash);
  });
});
