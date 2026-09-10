import { defineActionType } from "@operon/schema";
import type { ActionType } from "@operon/schema";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { OutboxDeliveryError } from "./actions-errors.js";
import { GovernedActionService } from "./actions/governed-action-service.js";
import { InMemoryAuditStore } from "./audit.js";
import { InMemoryObjectStore } from "./object-store.js";
import { OperonServiceImpl } from "./operon-service.js";
import { AuthorityService } from "./policy/authority.js";
import { ReconciliationService } from "./reconciliation.js";
import { AtomicCommitService } from "./transactions/atomic-commit-service.js";

describe("Gate V0-E: Governed Action, Atomic Commit & OperonService (V0-CH-07, 08, 09)", () => {
  let objectStore: InMemoryObjectStore;
  let auditStore: InMemoryAuditStore;
  let authorityService: AuthorityService;
  let actionService: GovernedActionService;
  let commitService: AtomicCommitService;
  let reconciliationService: ReconciliationService;
  let operonService: OperonServiceImpl;

  const testAction: ActionType<{ targetId: string; amount: number }> =
    defineActionType({
      defaultExecutionMode: "automated",
      description: "Transfer balance between ledger accounts",
      id: "transfer_balance",
      minimumAgentTier: 3,
      mutation: (params, ctx) =>
        Effect.gen(function* () {
          const obj = yield* ctx.getObject("Account" as any, params.targetId);
          if (!obj) return [];
          const currentBalance = Number((obj.properties as any).balance ?? 0);
          return [
            {
              ...obj,
              properties: {
                ...(obj.properties as Record<string, unknown>),
                balance: currentBalance + params.amount,
              },
            },
          ];
        }),
      name: "Transfer Balance",
      parametersSchema: Schema.Struct({
        amount: Schema.Number,
        targetId: Schema.String,
      }),
      riskTier: "high",
      sideEffects: [
        {
          description: "Dispatch notification to account owner",
          execute: () => Effect.void,
          id: "notify_owner",
        },
      ],
      submissionCriteria: [
        {
          description: "Transfer amount must be positive",
          evaluate: (params) =>
            Effect.succeed(
              params.amount > 0
                ? { passed: true as const }
                : {
                    failureReason: "Transfer amount must be greater than zero",
                    passed: false as const,
                    verdict: "deny" as const,
                  }
            ),
          id: "positive_amount",
        },
        {
          description: "High-value transfers (> 1000) require human review",
          evaluate: (params) =>
            Effect.succeed(
              params.amount <= 1000
                ? { passed: true as const }
                : {
                    failureReason: "Transfer exceeds $1,000 threshold",
                    passed: false as const,
                    verdict: "review" as const,
                  }
            ),
          id: "review_threshold",
        },
      ],
      targetObjectTypeId: "Account",
    });

  beforeEach(async () => {
    objectStore = new InMemoryObjectStore();
    auditStore = new InMemoryAuditStore();
    authorityService = new AuthorityService();
    const actionTypesMap = new Map([[testAction.id, testAction]]);
    actionService = new GovernedActionService(
      [testAction],
      objectStore,
      authorityService
    );
    commitService = new AtomicCommitService(
      actionTypesMap,
      objectStore,
      auditStore,
      authorityService
    );
    reconciliationService = new ReconciliationService();
    operonService = new OperonServiceImpl(
      actionService,
      commitService,
      authorityService,
      reconciliationService,
      objectStore
    );

    // Seed test object
    await Effect.runPromise(
      objectStore.putObject({
        id: "ACC-001",
        lastModifiedAt: Date.now() - 1000,
        properties: { balance: 500 },
        typeId: "Account" as any,
        version: 1,
      })
    );
  });

  describe("V0-CH-07: Preparation and Exact Proposal Approval", () => {
    it("prepare checks policy, criteria, records revisions and produces PreparedAction without modifying state", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 4,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },

          rawParameters: { amount: 500, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      expect(prepared.id).toBeDefined();
      expect(prepared.canonicalDigest).toBeDefined();
      expect(prepared.verdict).toBe("allow");
      expect(prepared.objectRevisions).toHaveLength(1);
      expect(prepared.objectRevisions[0]!.objectId).toBe("ACC-001");
      expect(prepared.objectRevisions[0]!.revision).toBe(1);
      expect(prepared.predicateDependencies).toHaveLength(2);
      expect(prepared.evidenceClosure).toHaveLength(1);

      // Verify DRY-RUN INVARIANT: Canonical business state remains 100% unchanged
      const account = await Effect.runPromise(
        objectStore.getObject("Account" as any, "ACC-001")
      );
      expect(account).toBeDefined();
      expect((account!.properties as any).balance).toBe(500);
      expect(account!.version).toBe(1);
    });

    it("evaluates submission criteria and flags review requirement for high value actions", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 5000, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      expect(prepared.verdict).toBe("review");
      expect(prepared.reviewReasons).toContain(
        "Transfer exceeds $1,000 threshold"
      );
    });

    it("denies self-approval when proposer attempts to approve own proposal (S07)", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "human-1",
            name: "John Proposer",
            roles: ["approver"],
            type: "user",
          },
          rawParameters: { amount: 2000, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      const result = await Effect.runPromise(
        Effect.exit(
          actionService.approvePreparedAction({
            decision: "approved",
            preparedDigest: prepared.canonicalDigest,
            reviewerContext: {
              assurance: "human_verified",
              environmentId: "prod",
              reviewer: {
                id: "human-1", // Same as proposer!
                name: "John Proposer",
                roles: ["approver"],
                type: "user",
              },
              tenantId: "tenant-acme",
            },
            viewedDigest: prepared.canonicalDigest,
          })
        )
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("SelfApprovalDeniedError");
      }
    });

    it("denies approval when viewedDigest does not strictly match preparedDigest (S07)", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 2000, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      const result = await Effect.runPromise(
        Effect.exit(
          actionService.approvePreparedAction({
            decision: "approved",
            preparedDigest: prepared.canonicalDigest,
            reviewerContext: {
              assurance: "human_verified",
              environmentId: "prod",
              reviewer: {
                id: "human-2",
                name: "Reviewer Jane",
                roles: ["approver"],
                type: "user",
              },
              tenantId: "tenant-acme",
            },
            viewedDigest: "tampered_digest_1234567890abcdef", // Tampered!
          })
        )
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("ApprovalDigestMismatchError");
      }
    });

    it("denies fabricated approval when AI agent attempts to satisfy human approval requirement (S07)", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 2000, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      const result = await Effect.runPromise(
        Effect.exit(
          actionService.approvePreparedAction({
            decision: "approved",
            preparedDigest: prepared.canonicalDigest,
            reviewerContext: {
              assurance: "human_verified",
              environmentId: "prod",
              reviewer: {
                id: "agent-auto-approver",
                name: "Auto Approver Bot",
                roles: ["approver"],
                type: "agent", // Sentinel / AI Agent!
              },
              tenantId: "tenant-acme",
            },
            viewedDigest: prepared.canonicalDigest,
          })
        )
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("FabricatedApprovalError");
      }
    });

    it("denies approval for expired proposal (stale approval)", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 2000, targetId: "ACC-001" },
          tenantId: "tenant-acme",
          ttlMs: -1000, // Expired immediately!
        })
      );

      const result = await Effect.runPromise(
        Effect.exit(
          actionService.approvePreparedAction({
            decision: "approved",
            preparedDigest: prepared.canonicalDigest,
            reviewerContext: {
              assurance: "human_verified",
              environmentId: "prod",
              reviewer: {
                id: "human-2",
                name: "Reviewer Jane",
                roles: ["approver"],
                type: "user",
              },
              tenantId: "tenant-acme",
            },
            viewedDigest: prepared.canonicalDigest,
          })
        )
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("StaleApprovalError");
      }
    });

    it("tenant non-disclosure: accessing prepared proposal under wrong tenant fails without disclosing existence", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 500, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      const result = await Effect.runPromise(
        Effect.exit(
          actionService.getPreparedAction(
            prepared.canonicalDigest,
            "tenant-competitor" // Wrong tenant!
          )
        )
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("TenantMismatchError");
      }
    });
  });

  describe("V0-CH-08: Atomic Commit, Concurrency, and Durable Delivery", () => {
    it("atomically commits state mutation, audit record, approval consumption, and outbox item", async () => {
      // 1. Prepare
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 3,
            id: "agent-1",
            name: "Finance Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 1500, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      // 2. Approve
      const approval = await Effect.runPromise(
        actionService.approvePreparedAction({
          decision: "approved",
          preparedDigest: prepared.canonicalDigest,
          reviewerContext: {
            assurance: "human_verified",
            environmentId: "prod",
            reviewer: {
              id: "human-supervisor",
              name: "Supervisor Sam",
              roles: ["approver"],
              type: "user",
            },
            tenantId: "tenant-acme",
          },
          viewedDigest: prepared.canonicalDigest,
        })
      );

      // 3. Commit
      const receipt = await Effect.runPromise(
        commitService.commit({
          approval,
          environmentId: "prod",
          idempotencyKey: "idem_001",
          prepared,
          tenantId: "tenant-acme",
        })
      );

      expect(receipt.operationId).toBeDefined();
      expect(receipt.status).toBe("SUCCEEDED");
      expect(receipt.outboxItems).toHaveLength(1);
      expect(receipt.outboxItems[0]!.command).toBe("notify_owner");
      expect(receipt.outboxItems[0]!.status).toBe("succeeded");

      // Verify business state changed
      const account = await Effect.runPromise(
        objectStore.getObject("Account" as any, "ACC-001")
      );
      expect(account).toBeDefined();
      expect((account!.properties as any).balance).toBe(2000); // 500 + 1500
      expect(account!.version).toBe(2);

      // Verify approval consumption: re-using the same approval fails
      const replay = await Effect.runPromise(
        Effect.exit(
          commitService.commit({
            approval,
            environmentId: "prod",
            idempotencyKey: "idem_002", // different key
            prepared,
            tenantId: "tenant-acme",
          })
        )
      );
      expect(replay._tag).toBe("Failure");
      if (replay._tag === "Failure") {
        expect(String(replay.cause)).toContain("StaleApprovalError");
      }
    });

    it("idempotency replay returns identical receipt on same key and payload; conflicts on changed payload", async () => {
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 4,
            id: "agent-autonomous",
            name: "Auto Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 100, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      // First commit
      const receipt1 = await Effect.runPromise(
        commitService.commit({
          environmentId: "prod",
          idempotencyKey: "unique_transfer_1",
          prepared,
          tenantId: "tenant-acme",
        })
      );

      // Identical retry -> returns cached receipt
      const receipt2 = await Effect.runPromise(
        commitService.commit({
          environmentId: "prod",
          idempotencyKey: "unique_transfer_1",
          prepared,
          tenantId: "tenant-acme",
        })
      );

      expect(receipt2.operationId).toBe(receipt1.operationId);
      expect(receipt2.receiptDigest).toBe(receipt1.receiptDigest);

      // Different payload with same key -> IdempotencyConflictError
      const preparedDifferent = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 4,
            id: "agent-autonomous",
            name: "Auto Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 200, targetId: "ACC-001" }, // different amount!
          tenantId: "tenant-acme",
        })
      );

      const conflictRes = await Effect.runPromise(
        Effect.exit(
          commitService.commit({
            environmentId: "prod",
            idempotencyKey: "unique_transfer_1", // same key!
            prepared: preparedDifferent,
            tenantId: "tenant-acme",
          })
        )
      );

      expect(conflictRes._tag).toBe("Failure");
      if (conflictRes._tag === "Failure") {
        expect(String(conflictRes.cause)).toContain("IdempotencyConflictError");
      }
    });

    it("detects concurrent revision drift between prepare and commit (CAS failure)", async () => {
      // 1. Prepare with object at revision 1
      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "transfer_balance",
          environmentId: "prod",
          proposer: {
            agentTier: 4,
            id: "agent-autonomous",
            name: "Auto Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { amount: 50, targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      // 2. Concurrent writer modifies object in store before commit
      await Effect.runPromise(
        objectStore.putObject({
          id: "ACC-001",
          lastModifiedAt: Date.now(),
          properties: { balance: 999 },
          typeId: "Account" as any,
          version: 2, // Bumped revision!
        })
      );

      // 3. Commit should fail with CommitConcurrencyError
      const commitRes = await Effect.runPromise(
        Effect.exit(
          commitService.commit({
            environmentId: "prod",
            idempotencyKey: "idem_cas_test",
            prepared,
            tenantId: "tenant-acme",
          })
        )
      );

      expect(commitRes._tag).toBe("Failure");
      if (commitRes._tag === "Failure") {
        expect(String(commitRes.cause)).toContain("CommitConcurrencyError");
      }
    });

    it("side effect dispatch failure or timeout results in honest EXTERNAL_UNKNOWN status and reconciliation", async () => {
      // Action with failing/timeout side effect
      const failingAction: ActionType<{ targetId: string }> = defineActionType({
        defaultExecutionMode: "automated",
        description: "Action with flaky external integration",
        id: "flaky_external_call",
        minimumAgentTier: 4,
        parametersSchema: Schema.Struct({ targetId: Schema.String }),
        riskTier: "low",
        sideEffects: [
          {
            description: "External payment gateway call",
            execute: () =>
              Effect.fail(
                new OutboxDeliveryError({
                  message: "Connection timeout / 504",
                  operationId: "op_test",
                })
              ),
            id: "payment_gw",
          },
        ],
      });

      actionService.registerActionType(failingAction);
      const actionTypesMap = new Map([
        [testAction.id, testAction],
        [failingAction.id, failingAction],
      ]);
      const localCommitService = new AtomicCommitService(
        actionTypesMap,
        objectStore,
        auditStore,
        authorityService
      );

      const prepared = await Effect.runPromise(
        actionService.prepareAction({
          actionId: "flaky_external_call",
          environmentId: "prod",
          proposer: {
            agentTier: 4,
            id: "agent-autonomous",
            name: "Auto Agent",
            roles: ["operator"],
            type: "agent",
          },
          rawParameters: { targetId: "ACC-001" },
          tenantId: "tenant-acme",
        })
      );

      const receipt = await Effect.runPromise(
        localCommitService.commit({
          environmentId: "prod",
          idempotencyKey: "flaky_001",
          prepared,
          tenantId: "tenant-acme",
        })
      );

      // S08: A lost response leads to EXTERNAL_UNKNOWN, NOT blind repeat
      expect(receipt.status).toBe("EXTERNAL_UNKNOWN");
      expect(receipt.outboxItems[0]!.status).toBe("external_unknown");

      // Reconcile truthfully
      const reconciled = await Effect.runPromise(
        localCommitService.reconcileExternalUnknown(
          receipt.operationId,
          "tenant-acme",
          "SUCCEEDED"
        )
      );
      expect(reconciled.status).toBe("SUCCEEDED");
    });
  });

  describe("V0-CH-09: OperonService Unified Invocation & Transport Parity", () => {
    it("executes prepare, approve, and commit through OperonService with unified ResultEnvelope", async () => {
      const ctx = {
        actor: {
          agentTier: 3 as const,
          id: "unified-agent",
          name: "Unified Agent",
          roles: ["operator"],
          type: "agent" as const,
        },
        environmentId: "prod",
        tenantId: "tenant-acme",
      };

      // 1. Prepare via OperonService
      const prepRes = await operonService.invoke(ctx, "action.prepare", {
        actionId: "transfer_balance",
        rawParameters: { amount: 1500, targetId: "ACC-001" },
      });

      expect(prepRes.status).toBe("REVIEW_REQUIRED");
      const prepObj = prepRes.result as any;
      expect(prepObj.canonicalDigest).toBeDefined();

      // 2. Approve via OperonService
      const humanCtx = {
        ...ctx,
        actor: {
          id: "human-boss",
          name: "Boss",
          roles: ["approver"],
          type: "user" as const,
        },
      };

      const appRes = await operonService.invoke(humanCtx, "action.approve", {
        decision: "approved",
        preparedDigest: prepObj.canonicalDigest,
        viewedDigest: prepObj.canonicalDigest,
      });

      expect(appRes.status).toBe("SUCCESS");
      const appObj = appRes.result as any;
      expect(appObj.id).toBeDefined();

      // 3. Commit via OperonService
      const commitRes = await operonService.invoke(ctx, "action.commit", {
        approvalId: appObj.id,
        idempotencyKey: "os_commit_1",
        preparedDigest: prepObj.canonicalDigest,
      });

      expect(commitRes.status).toBe("SUCCESS");
      const receiptObj = commitRes.result as any;
      expect(receiptObj.status).toBe("SUCCEEDED");

      // 4. Generate disposable view via OperonService
      const viewRes = await operonService.invoke(ctx, "view.generate", {
        data: receiptObj,
        format: "card",
        state: "CONFIRMED",
        title: "Execution Receipt Card",
      });

      expect(viewRes.status).toBe("SUCCESS");
      const viewObj = viewRes.result as any;
      expect(viewObj.rendered).toContain("[STATE: CONFIRMED]");
      expect(viewObj.isDisposable).toBe(true);
    });
  });
});
