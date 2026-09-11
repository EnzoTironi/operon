import type {
  ActionType,
  ApprovalRecord,
  PreparedAction,
} from "@operon/schema";
import {
  defineActionType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { OutboxDeliveryError } from "../actions-errors.js";
import { GovernedActionService } from "../actions/governed-action-service.js";
import { InMemoryAuditStore } from "../audit.js";
import { IdempotencyConflictError, StorageError } from "../errors.js";
import { InMemoryObjectStore } from "../object-store.js";
import { AuthorityService } from "../policy/authority.js";
import { AtomicCommitService } from "./atomic-commit-service.js";

describe("AtomicCommitService S08 / V1-05 Normative Binary Acceptance Suite", () => {
  let objectStore: InMemoryObjectStore;
  let auditStore: InMemoryAuditStore;
  let authorityService: AuthorityService;
  let actionService: GovernedActionService;
  let commitService: AtomicCommitService;

  const AccountType = defineObjectType({
    description: "Bank Account",
    id: "Account",
    name: "Account",
    primaryKey: "id",
    properties: {
      balance: defineProperty({
        description: "Balance",
        schema: Schema.Number,
      }),
      id: defineProperty({ description: "ID", schema: Schema.String }),
    },
    typology: "master",
  });

  const TransferAction: ActionType<{ targetId: string; amount: number }> =
    defineActionType({
      defaultExecutionMode: "automated",
      description: "Transfer balance between ledger accounts",
      id: "transfer_balance",
      minimumAgentTier: 3,
      mutation: (params, ctx) =>
        Effect.gen(function* () {
          const obj = yield* ctx.getObject(AccountType.id, params.targetId);
          if (!obj) {
            return [];
          }
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
      targetObjectTypeId: AccountType.id,
    });

  let sideEffectShouldFail = false;
  const FlakyAction: ActionType<{ targetId: string; amount: number }> =
    defineActionType({
      defaultExecutionMode: "automated",
      description: "Transfer balance with flaky notification",
      id: "flaky_transfer",
      minimumAgentTier: 3,
      mutation: (params, ctx) =>
        Effect.gen(function* () {
          const obj = yield* ctx.getObject(AccountType.id, params.targetId);
          if (!obj) {
            return [];
          }
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
      name: "Flaky Transfer",
      parametersSchema: Schema.Struct({
        amount: Schema.Number,
        targetId: Schema.String,
      }),
      riskTier: "high",
      sideEffects: [
        {
          description: "External wire transfer notification",
          execute: () =>
            sideEffectShouldFail
              ? Effect.fail(
                  new OutboxDeliveryError({
                    message: "Connection timeout / 504 Gateway Timeout",
                    operationId: "op_flaky",
                    status: "external_unknown",
                  })
                )
              : Effect.void,
          id: "wire_notification",
        },
      ],
      targetObjectTypeId: AccountType.id,
    });

  beforeEach(async () => {
    sideEffectShouldFail = false;
    objectStore = new InMemoryObjectStore();
    auditStore = new InMemoryAuditStore();
    authorityService = new AuthorityService();

    actionService = new GovernedActionService(
      [TransferAction, FlakyAction],
      objectStore,
      authorityService
    );

    const actionTypesMap = new Map([
      [TransferAction.id, TransferAction],
      [FlakyAction.id, FlakyAction],
    ]);

    commitService = new AtomicCommitService({
      actionTypes: actionTypesMap,
      auditStore,
      authorityService,
      objectStore,
    });

    await Effect.runPromise(
      objectStore.putObject({
        id: "ACC-001",
        lastModifiedAt: 1000,
        properties: { balance: 500, id: "ACC-001" },
        typeId: AccountType.id,
        version: 1,
      })
    );
  });

  async function prepareAndApprove(
    actionId = "transfer_balance",
    amount = 100,
    targetId = "ACC-001"
  ): Promise<{ prepared: PreparedAction; approval: ApprovalRecord }> {
    const prepared = await Effect.runPromise(
      actionService.prepareAction({
        actionId,
        environmentId: "prod",
        proposer: {
          agentTier: 3,
          id: "agent-treasury",
          name: "Treasury Agent",
          roles: ["operator"],
          type: "agent",
        },
        rawParameters: { amount, targetId },
        tenantId: "tenant-acme",
      })
    );

    commitService.registerPreparedAction(prepared);

    const approval = await Effect.runPromise(
      actionService.approvePreparedAction({
        decision: "approved",
        preparedDigest: prepared.canonicalDigest,
        reviewerContext: {
          assurance: "human_verified",
          environmentId: "prod",
          reviewer: {
            id: "human-cfo",
            name: "Chief Financial Officer",
            roles: ["approver"],
            type: "user",
          },
          tenantId: "tenant-acme",
        },
        viewedDigest: prepared.canonicalDigest,
      })
    );

    return { approval, prepared };
  }

  it("does commit state, decision record, approval consumption, and outbox enqueue atomically (S08 / V1-05)", async () => {
    const { prepared, approval } = await prepareAndApprove(
      "transfer_balance",
      250
    );

    const receipt = await Effect.runPromise(
      commitService.execute(approval, "idem_atomic_01", prepared)
    );

    expect(receipt).toBeDefined();
    expect(receipt.status).toBe("SUCCEEDED");
    expect(receipt.operationId).toBeDefined();
    expect(receipt.receiptDigest).toBeDefined();
    expect(receipt.receiptDigest).toHaveLength(64);
    expect(receipt.outboxItems).toHaveLength(1);
    expect(receipt.outboxItems[0]!.command).toBe("notify_owner");
    expect(receipt.outboxItems[0]!.status).toBe("succeeded");

    // Verify object store updated with new version
    const account = await Effect.runPromise(
      objectStore.getObject(AccountType.id, "ACC-001")
    );
    expect(account).toBeDefined();
    expect((account!.properties as any).balance).toBe(750); // 500 + 250
    expect(account!.version).toBe(2);

    // Verify approval consumed: re-executing with the same approval fails
    const reUseErr = await Effect.runPromise(
      Effect.flip(
        commitService.execute(approval, "idem_different_key", prepared)
      )
    );
    expect(String(reUseErr)).toContain("StaleApprovalError");
  });

  it("does return cached receipt on identical idempotency key and reject changed input with conflict error (S08 / V1-05)", async () => {
    const { prepared, approval } = await prepareAndApprove(
      "transfer_balance",
      100
    );

    // First commit
    const receipt1 = await Effect.runPromise(
      commitService.execute(approval, "idem_key_repeatable", prepared)
    );

    // Second commit with identical idempotency key & prepared proposal -> returns cached receipt
    const receipt2 = await Effect.runPromise(
      commitService.commit({
        environmentId: "prod",
        idempotencyKey: "idem_key_repeatable",
        prepared,
        tenantId: "tenant-acme",
      })
    );

    expect(receipt2.operationId).toBe(receipt1.operationId);
    expect(receipt2.receiptDigest).toBe(receipt1.receiptDigest);

    // Account should only have been incremented once
    const account = await Effect.runPromise(
      objectStore.getObject(AccountType.id, "ACC-001")
    );
    expect((account!.properties as any).balance).toBe(600); // 500 + 100 once

    // Third commit with same idempotency key but different input -> IdempotencyConflictError
    const { prepared: preparedDifferent } = await prepareAndApprove(
      "transfer_balance",
      999
    );

    const conflictErr = await Effect.runPromise(
      Effect.flip(
        commitService.commit({
          environmentId: "prod",
          idempotencyKey: "idem_key_repeatable",
          prepared: preparedDifferent,
          tenantId: "tenant-acme",
        })
      )
    );

    expect(conflictErr).toBeInstanceOf(IdempotencyConflictError);
  });

  it("does rollback state when audit append crashes during commit (S08 / V1-05 fault injection)", async () => {
    // Fault injection: AuditStore throws on appendDecision
    const crashingAuditStore: InMemoryAuditStore = Object.create(auditStore);
    crashingAuditStore.appendDecision = () =>
      Effect.fail(
        new StorageError({
          cause: "Disk full / write failure",
          message: "Audit persistence crashed at fault injection point",
        })
      );

    const faultCommitService = new AtomicCommitService({
      actionTypes: new Map([[TransferAction.id, TransferAction]]),
      auditStore: crashingAuditStore,
      authorityService,
      objectStore,
    });

    const { prepared, approval } = await prepareAndApprove(
      "transfer_balance",
      400
    );

    const commitErr = await Effect.runPromise(
      Effect.flip(
        faultCommitService.execute(approval, "idem_crash_audit", prepared)
      )
    );

    expect(commitErr).toBeInstanceOf(StorageError);

    // Invariant: Object state must have been restored by rollbackState helper!
    const account = await Effect.runPromise(
      objectStore.getObject(AccountType.id, "ACC-001")
    );
    expect((account!.properties as any).balance).toBe(500); // Balance NOT modified!
    expect(account!.version).toBe(1);

    // Invariant: Outbox must not contain any dispatched items from the failed commit
    const outboxItem = await Effect.runPromise(
      faultCommitService.getOutboxItem("out_any")
    );
    expect(outboxItem).toBeUndefined();
  });

  it("does yield explicit EXTERNAL_UNKNOWN on remote side effect crash and reconcile to truthful outcome (S08 / V1-05 fault injection)", async () => {
    sideEffectShouldFail = true;

    const { prepared, approval } = await prepareAndApprove(
      "flaky_transfer",
      150
    );

    const receipt = await Effect.runPromise(
      commitService.execute(approval, "idem_flaky_01", prepared)
    );

    // S08 Invariant: Crash at side effect dispatch must result in honest EXTERNAL_UNKNOWN status,
    // not manufactured success, not blind retry!
    expect(receipt.status).toBe("EXTERNAL_UNKNOWN");
    expect(receipt.outboxItems).toHaveLength(1);
    expect(receipt.outboxItems[0]!.status).toBe("external_unknown");

    // The local database state was committed
    const account = await Effect.runPromise(
      objectStore.getObject(AccountType.id, "ACC-001")
    );
    expect((account!.properties as any).balance).toBe(650); // 500 + 150

    // Later: Reconciliation is performed to update status to reconciled truth
    const reconciled = await Effect.runPromise(
      commitService.reconcile(receipt.operationId, "tenant-acme", "SUCCEEDED")
    );

    expect(reconciled.status).toBe("SUCCEEDED");
    expect(reconciled.operationId).toBe(receipt.operationId);

    // Querying operation reflects updated truthful outcome
    const fetched = await Effect.runPromise(
      commitService.getOperation(receipt.operationId, "tenant-acme")
    );
    expect(fetched?.status).toBe("SUCCEEDED");
  });

  it("does preserve state and idempotency across snapshot export and import (S08 / V1-05)", async () => {
    const { prepared, approval } = await prepareAndApprove(
      "transfer_balance",
      120
    );

    const receipt = await Effect.runPromise(
      commitService.execute(approval, "idem_snapshot_test", prepared)
    );

    const snapshot = commitService.exportSnapshot();
    expect(snapshot.operations).toHaveLength(1);
    expect(snapshot.consumedApprovalIds).toContain(approval.id);

    // Recreate fresh service and restore snapshot
    const restoredCommitService = new AtomicCommitService({
      actionTypes: new Map([[TransferAction.id, TransferAction]]),
      auditStore,
      authorityService,
      initialSnapshot: snapshot,
      objectStore,
    });

    // Query receipt
    const restoredReceipt = await Effect.runPromise(
      restoredCommitService.getOperation(receipt.operationId, "tenant-acme")
    );
    expect(restoredReceipt).toBeDefined();
    expect(restoredReceipt?.receiptDigest).toBe(receipt.receiptDigest);

    // Approval remains consumed in restored service
    const reUseErr = await Effect.runPromise(
      Effect.flip(
        restoredCommitService.execute(approval, "idem_other", prepared)
      )
    );
    expect(String(reUseErr)).toContain("StaleApprovalError");
  });
});
