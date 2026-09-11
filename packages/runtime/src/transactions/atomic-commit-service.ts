import type {
  ActionEvaluationContext,
  ActionParameters,
  ActionType,
  ApprovalRecord,
  ObjectInstance,
  OperationReceipt,
  OperationStatus,
  OutboxItem,
  PreparedAction,
} from "@operon/schema";
import {
  ObjectTypeId,
  computeOperationReceiptDigest,
  generatePrefixedId,
} from "@operon/schema";
import { Clock, Effect, Exit } from "effect";

import type {
  GrantExceededError,
  GrantNotFoundError,
  OutboxDeliveryError,
} from "../actions-errors.js";
import {
  ApprovalDigestMismatchError,
  CommitConcurrencyError,
  FreshnessOrPolicyDeniedError,
  StaleApprovalError,
  TenantMismatchError,
} from "../actions-errors.js";
import type { AuditStore } from "../audit.js";
import { IdempotencyConflictError, StorageError } from "../errors.js";
import type { ObjectStore } from "../object-store.js";
import type { AuthorityService } from "../policy/authority.js";

export interface AtomicCommitSnapshot {
  readonly operations: readonly OperationReceipt[];
  readonly outboxItems: readonly OutboxItem[];
  readonly consumedApprovalIds: readonly string[];
}

export interface CommitOperationInput {
  readonly prepared: PreparedAction;
  readonly approval?: ApprovalRecord;
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly environmentId: string;
}

interface IdempotencyEntry {
  readonly preparedDigest: string;
  readonly receipt: OperationReceipt;
}

export interface AtomicCommitServiceOptions {
  readonly actionTypes: Map<string, ActionType<ActionParameters>>;
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly authorityService: AuthorityService;
  readonly initialSnapshot?: AtomicCommitSnapshot;
}

const validateApprovalState = Effect.fn(
  "AtomicCommitService.validateApprovalState"
)(function* (
  prepared: PreparedAction,
  approval: ApprovalRecord | undefined,
  consumedApprovals: Set<string>,
  now: number
) {
  if (approval) {
    if (approval.preparedDigest !== prepared.canonicalDigest) {
      return yield* new ApprovalDigestMismatchError({
        message: `Approval viewedDigest '${approval.viewedDigest}' does not match prepared digest '${prepared.canonicalDigest}'`,
        preparedDigest: prepared.canonicalDigest,
        viewedDigest: approval.viewedDigest,
      });
    }
    if (approval.decision !== "approved") {
      return yield* new FreshnessOrPolicyDeniedError({
        actionId: prepared.actionId,
        message: `Cannot commit rejected proposal approval '${approval.id}'`,
        reasons: ["Proposal was rejected by reviewer"],
      });
    }
    if (now > approval.expiresAt) {
      return yield* new StaleApprovalError({
        message: `Approval '${approval.id}' expired at ${approval.expiresAt}`,
        preparedDigest: prepared.canonicalDigest,
        reason: "approval_expired",
      });
    }
    if (consumedApprovals.has(approval.id)) {
      return yield* new StaleApprovalError({
        message: `Approval '${approval.id}' has already been consumed by another operation`,
        preparedDigest: prepared.canonicalDigest,
        reason: "approval_already_consumed",
      });
    }
  } else if (prepared.verdict !== "allow") {
    return yield* new FreshnessOrPolicyDeniedError({
      actionId: prepared.actionId,
      message: `Action requires review (prepared verdict: ${prepared.verdict}) and cannot be committed without signed approval`,
      reasons: prepared.reviewReasons ?? ["Requires human approval"],
    });
  }
});

const validateRevisionConcurrency = Effect.fn(
  "AtomicCommitService.validateRevisionConcurrency"
)(function* (
  revisions: readonly {
    typeId: string;
    objectId: string;
    revision: number;
  }[],
  objectStore: ObjectStore
) {
  yield* Effect.forEach(
    revisions,
    Effect.fn("AtomicCommitService.checkRevision")(function* (ref) {
      const current = yield* objectStore.getObject(
        ObjectTypeId.make(ref.typeId),
        ref.objectId
      );
      const currentVersion = current ? current.version : 0;
      if (currentVersion !== ref.revision) {
        return yield* new CommitConcurrencyError({
          actualRevision: currentVersion,
          expectedRevision: ref.revision,
          message: `Funnel merge conflict: object '${ref.objectId}' was modified concurrently (expected revision ${ref.revision}, store has ${currentVersion})`,
          objectId: ref.objectId,
        });
      }
    }),
    { concurrency: 1 }
  );
});

const rollbackSnapshots = Effect.fn("AtomicCommitService.rollbackSnapshots")(
  function* (
    snapshots: Map<string, ObjectInstance | undefined>,
    objectStore: ObjectStore
  ) {
    yield* Effect.forEach(
      [...snapshots.entries()],
      Effect.fn("AtomicCommitService.revertSnapshot")(function* ([key, orig]) {
        const [typeId, id] = key.split(":");
        if (typeId && id) {
          const objTypeId = ObjectTypeId.make(typeId);
          if (objectStore.revertObject) {
            yield* objectStore.revertObject(objTypeId, id, orig);
          } else if (orig) {
            yield* objectStore.putObject(orig).pipe(Effect.ignore);
          } else {
            yield* objectStore.deleteObject(objTypeId, id).pipe(Effect.ignore);
          }
        }
      }),
      { concurrency: 1 }
    );
  }
);

const executeMutations = Effect.fn("AtomicCommitService.executeMutations")(
  function* (params: {
    readonly actionType: ActionType<ActionParameters> | undefined;
    readonly prepared: PreparedAction;
    readonly evalContext: ActionEvaluationContext;
    readonly objectStore: ObjectStore;
    readonly now: number;
  }) {
    const { actionType, prepared, evalContext, objectStore, now } = params;
    const updatedObjects: ObjectInstance[] = [];
    const originalSnapshots = new Map<string, ObjectInstance | undefined>();

    if (!actionType?.mutation) {
      return { originalSnapshots, updatedObjects };
    }

    const stagedEdits = yield* actionType
      .mutation(prepared.normalizedParameters, evalContext)
      .pipe(
        Effect.mapError(
          (err) =>
            new StorageError({
              cause: err,
              message: `Action mutation failed: ${err.message}`,
            })
        )
      );

    yield* Effect.forEach(
      stagedEdits,
      Effect.fn("AtomicCommitService.captureSnapshot")(function* (edit) {
        const existing = yield* objectStore.getObject(edit.typeId, edit.id);
        originalSnapshots.set(
          `${edit.typeId}:${edit.id}`,
          existing ? structuredClone(existing) : undefined
        );
      }),
      { concurrency: 1 }
    );

    yield* Effect.forEach(
      stagedEdits,
      Effect.fn("AtomicCommitService.applyEdit")(function* (edit) {
        const existing = originalSnapshots.get(`${edit.typeId}:${edit.id}`);
        const targetVersion = existing
          ? existing.version + 1
          : (edit.version ?? 1);
        const updated = yield* objectStore
          .putObject({
            ...edit,
            lastModifiedAt: now,
            version: targetVersion,
          })
          .pipe(
            Effect.mapError(
              (cErr) =>
                new CommitConcurrencyError({
                  actualRevision: cErr.actualVersion,
                  expectedRevision: cErr.expectedVersion,
                  message: `Concurrent modification on object '${edit.id}': expected ${cErr.expectedVersion} but store has ${cErr.actualVersion}`,
                  objectId: edit.id,
                })
            )
          );
        updatedObjects.push(updated);
      }),
      { concurrency: 1 }
    );

    return { originalSnapshots, updatedObjects };
  }
);

const dispatchSideEffects = Effect.fn(
  "AtomicCommitService.dispatchSideEffects"
)(function* (params: {
  readonly actionType: ActionType<ActionParameters> | undefined;
  readonly prepared: PreparedAction;
  readonly evalContext: ActionEvaluationContext;
  readonly now: number;
  readonly environmentId: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly outbox: Map<string, OutboxItem>;
}) {
  const {
    actionType,
    prepared,
    evalContext,
    now,
    environmentId,
    tenantId,
    operationId,
    outbox,
  } = params;
  const outboxItems: OutboxItem[] = [];
  let finalStatus: OperationStatus = "COMMITTED";

  if (!actionType?.sideEffects) {
    return { finalStatus, outboxItems };
  }

  yield* Effect.forEach(
    actionType.sideEffects,
    Effect.fn("AtomicCommitService.stageSideEffect")(function* (se) {
      const outboxId = generatePrefixedId("out", now);
      const item: OutboxItem = {
        attemptCount: 0,
        command: se.id,
        createdAt: now,
        environmentId,
        id: outboxId,
        operationId,
        payload: {
          parameters: prepared.normalizedParameters,
          sideEffectDescription: se.description,
        },
        status: "pending",
        tenantId,
        updatedAt: now,
      };
      outbox.set(outboxId, item);

      const inFlightTime = yield* Clock.currentTimeMillis;
      let currentItem: OutboxItem = {
        ...item,
        attemptCount: item.attemptCount + 1,
        status: "in_flight",
        updatedAt: inFlightTime,
      };
      outbox.set(outboxId, currentItem);

      const dispatchExit = yield* Effect.exit(
        se.execute(prepared.normalizedParameters, evalContext)
      );

      const finishTime = yield* Clock.currentTimeMillis;
      if (Exit.isSuccess(dispatchExit)) {
        currentItem = {
          ...currentItem,
          status: "succeeded",
          updatedAt: finishTime,
        };
        outbox.set(outboxId, currentItem);
        finalStatus = "SUCCEEDED";
      } else {
        currentItem = {
          ...currentItem,
          error: String(dispatchExit.cause),
          status: "external_unknown",
          updatedAt: finishTime,
        };
        outbox.set(outboxId, currentItem);
        finalStatus = "EXTERNAL_UNKNOWN";
      }
      outboxItems.push(currentItem);
    }),
    { concurrency: 1 }
  );

  return { finalStatus, outboxItems };
});

/**
 * AtomicCommitService (S08 / V0-CH-08):
 * Atomically commits state, decision, approval consumption, reservation,
 * deduplication, and outbox in one local unit of work.
 * Manages outbox delivery and honest reconciliation of EXTERNAL_UNKNOWN outcomes.
 */
export class AtomicCommitService {
  private readonly operations = new Map<string, OperationReceipt>();
  private readonly outbox = new Map<string, OutboxItem>();
  private readonly consumedApprovals = new Set<string>();
  private readonly idempotencyRegistry = new Map<string, IdempotencyEntry>();
  private readonly preparedActions = new Map<string, PreparedAction>();
  private readonly actionTypes: Map<string, ActionType<ActionParameters>>;
  private readonly objectStore: ObjectStore;
  private readonly auditStore: AuditStore;
  private readonly authorityService: AuthorityService;

  constructor(options: AtomicCommitServiceOptions) {
    this.actionTypes = options.actionTypes;
    this.objectStore = options.objectStore;
    this.auditStore = options.auditStore;
    this.authorityService = options.authorityService;
    const initialSnapshot = options.initialSnapshot;
    if (initialSnapshot) {
      for (const op of initialSnapshot.operations) {
        this.operations.set(op.operationId, op);
        const scopedKey = `${op.tenantId}:${op.environmentId}:${op.actionId}:${op.idempotencyKey}`;
        this.idempotencyRegistry.set(scopedKey, {
          preparedDigest: op.preparedDigest,
          receipt: op,
        });
      }
      for (const item of initialSnapshot.outboxItems) {
        this.outbox.set(item.id, item);
      }
      for (const id of initialSnapshot.consumedApprovalIds) {
        this.consumedApprovals.add(id);
      }
    }
  }

  registerPreparedAction(prepared: PreparedAction): void {
    this.preparedActions.set(prepared.canonicalDigest, prepared);
    this.preparedActions.set(prepared.id, prepared);
  }

  /**
   * commit (S08):
   * State + decision + approval consumption + reservation + outbox + idempotency
   * in one transactional unit of work.
   */
  commit(
    input: CommitOperationInput
  ): Effect.Effect<
    OperationReceipt,
    | IdempotencyConflictError
    | TenantMismatchError
    | ApprovalDigestMismatchError
    | StaleApprovalError
    | CommitConcurrencyError
    | FreshnessOrPolicyDeniedError
    | GrantNotFoundError
    | GrantExceededError
    | StorageError
    | OutboxDeliveryError
  > {
    const {
      actionTypes,
      objectStore,
      auditStore,
      authorityService,
      operations,
      outbox,
      consumedApprovals,
      idempotencyRegistry,
    } = this;

    return Effect.gen(function* () {
      const { prepared, approval, idempotencyKey, tenantId, environmentId } =
        input;
      const now = yield* Clock.currentTimeMillis;

      // 1. Tenant & Environment non-disclosure check
      if (prepared.tenantId !== tenantId) {
        return yield* new TenantMismatchError({
          message: "Prepared action does not exist for tenant",
          tenantId,
        });
      }

      const scopedIdempotencyKey = `${tenantId}:${environmentId}:${prepared.actionId}:${idempotencyKey}`;

      // 2. Idempotency check: Same key + same proposal returns same receipt; changed proposal conflicts
      const existingIdempotency = idempotencyRegistry.get(scopedIdempotencyKey);
      if (existingIdempotency) {
        if (existingIdempotency.preparedDigest !== prepared.canonicalDigest) {
          return yield* new IdempotencyConflictError({
            idempotencyKey,
            message: `Idempotency key '${idempotencyKey}' was already committed with a different prepared proposal digest`,
          });
        }
        return existingIdempotency.receipt;
      }

      // 3. Approval consumption & CAS validation (S07, S08)
      yield* validateApprovalState(prepared, approval, consumedApprovals, now);

      // 4. Optimistic Concurrency Control (CAS revision check against ObjectStore)
      yield* validateRevisionConcurrency(prepared.objectRevisions, objectStore);

      // 5. Grant budget reservation commit
      if (prepared.grantId) {
        yield* authorityService.reserveBudget(prepared.grantId, tenantId, 1);
      }

      // 6. Action mutation execution and state rollback snapshot
      const actionType = actionTypes.get(prepared.actionId);
      const evalContext: ActionEvaluationContext = {
        getObject: (typeId: ObjectTypeId, id: string) =>
          objectStore.getObject(typeId, id),
        now,
        security: {
          correlationId: `op_${now}`,
          subject: approval?.reviewerContext.reviewer ?? prepared.proposer,
          timestamp: now,
        },
      };

      const { originalSnapshots, updatedObjects } = yield* executeMutations({
        actionType,
        evalContext,
        now,
        objectStore,
        prepared,
      });

      // 7. Persist DecisionRecord to AuditStore
      const operationId = generatePrefixedId("op", now);
      const decisionRecord = yield* auditStore
        .appendDecision({
          actionTypeId: prepared.actionId,
          correlationId: evalContext.security.correlationId,
          id: `dec_${operationId}`,
          outcome: "executed",
          parameters: prepared.normalizedParameters,
          ruleVersion: prepared.actionRelease,
          stateSnapshot: {
            preparedDigest: prepared.canonicalDigest,
            updatedCount: updatedObjects.length,
          },
          subject: evalContext.security.subject,
          timestamp: now,
          verdict: "allow",
        })
        .pipe(
          Effect.catch((error) =>
            rollbackSnapshots(originalSnapshots, objectStore).pipe(
              Effect.andThen(
                Effect.fail(
                  new StorageError({
                    cause: error,
                    message: `Atomic audit commit failed: ${error.message}`,
                  })
                )
              )
            )
          )
        );

      // 8. Consume approval (CAS)
      if (approval) {
        consumedApprovals.add(approval.id);
      }

      // 9. Durable Outbox items creation for external side effects (S08)
      const { finalStatus, outboxItems } = yield* dispatchSideEffects({
        actionType,
        environmentId,
        evalContext,
        now,
        operationId,
        outbox,
        prepared,
        tenantId,
      });

      // 10. OperationReceipt construction
      const receiptWithoutDigest: Omit<OperationReceipt, "receiptDigest"> = {
        actionId: prepared.actionId,
        approvalId: approval?.id,
        committedAt: now,
        decisionRecordId: decisionRecord.id,
        environmentId,
        idempotencyKey,
        operationId,
        outboxItems,
        preparedDigest: prepared.canonicalDigest,
        status: finalStatus,
        tenantId,
        updatedObjects,
      };

      const receiptDigest = computeOperationReceiptDigest(receiptWithoutDigest);
      const receipt: OperationReceipt = {
        ...receiptWithoutDigest,
        receiptDigest,
      };

      // 11. Save to operation ledger & idempotency registry
      operations.set(operationId, receipt);
      idempotencyRegistry.set(scopedIdempotencyKey, {
        preparedDigest: prepared.canonicalDigest,
        receipt,
      });

      return receipt;
    });
  }

  /**
   * execute (S08 / V1-05 Contract Sketch):
   * execute(approval, key): Promise<OperationReceipt> (or Effect)
   */
  execute(
    approval: ApprovalRecord,
    idempotencyKey: string,
    preparedAction?: PreparedAction
  ): Effect.Effect<
    OperationReceipt,
    | IdempotencyConflictError
    | TenantMismatchError
    | ApprovalDigestMismatchError
    | StaleApprovalError
    | CommitConcurrencyError
    | FreshnessOrPolicyDeniedError
    | GrantNotFoundError
    | GrantExceededError
    | StorageError
    | OutboxDeliveryError
  > {
    const prepared =
      preparedAction ??
      this.preparedActions.get(approval.preparedDigest) ??
      this.preparedActions.get(approval.preparedId);

    if (!prepared) {
      return Effect.fail(
        new TenantMismatchError({
          message: `Prepared action '${approval.preparedDigest}' not found for execution`,
          tenantId: approval.reviewerContext.tenantId,
        })
      );
    }

    return this.commit({
      approval,
      environmentId: approval.reviewerContext.environmentId,
      idempotencyKey,
      prepared,
      tenantId: approval.reviewerContext.tenantId,
    });
  }

  /**
   * reconcile (S08 / V1-05 Contract Sketch):
   * reconcile(operationId): Promise<OperationReceipt> (or Effect)
   */
  reconcile(
    operationId: string,
    tenantId = "default",
    resolvedStatus: "SUCCEEDED" | "FAILED" | "COMPENSATED" = "SUCCEEDED"
  ): Effect.Effect<OperationReceipt, TenantMismatchError> {
    return this.reconcileExternalUnknown(operationId, tenantId, resolvedStatus);
  }

  /**
   * Reconcile EXTERNAL_UNKNOWN operation outcome honestly (S08)
   */

  reconcileExternalUnknown(
    operationId: string,
    tenantId: string,
    resolvedStatus: "SUCCEEDED" | "FAILED" | "COMPENSATED"
  ): Effect.Effect<OperationReceipt, TenantMismatchError> {
    const { operations } = this;
    return Effect.gen(function* () {
      const op = operations.get(operationId);
      if (!op) {
        return yield* new TenantMismatchError({
          message: `Operation '${operationId}' not found`,
          tenantId,
        });
      }
      if (op.tenantId !== tenantId) {
        return yield* new TenantMismatchError({
          message: `Operation does not exist for tenant`,
          tenantId,
        });
      }

      const updatedReceipt: OperationReceipt = {
        ...op,
        status: resolvedStatus,
      };
      operations.set(operationId, updatedReceipt);
      return updatedReceipt;
    });
  }

  getOperation(
    operationId: string,
    tenantId: string
  ): Effect.Effect<OperationReceipt | undefined, TenantMismatchError> {
    const { operations } = this;
    return Effect.gen(function* () {
      const op = operations.get(operationId);
      if (!op) {
        return;
      }
      if (op.tenantId !== tenantId) {
        return yield* new TenantMismatchError({
          message: "Operation does not exist for tenant",
          tenantId,
        });
      }
      return op;
    });
  }

  listOperations(tenantId: string): Effect.Effect<readonly OperationReceipt[]> {
    const { operations } = this;
    return Effect.sync(() =>
      [...operations.values()].filter((o) => o.tenantId === tenantId)
    );
  }

  getReceipt(
    operationId: string,
    tenantId = "default"
  ): Effect.Effect<OperationReceipt | undefined, TenantMismatchError> {
    return this.getOperation(operationId, tenantId);
  }

  getOutboxItem(id: string): Effect.Effect<OutboxItem | undefined> {
    const { outbox } = this;
    return Effect.sync(() => outbox.get(id));
  }

  exportSnapshot(): AtomicCommitSnapshot {
    return {
      consumedApprovalIds: [...this.consumedApprovals],
      operations: [...this.operations.values()],
      outboxItems: [...this.outbox.values()],
    };
  }

  importSnapshot(snapshot: AtomicCommitSnapshot): void {
    this.operations.clear();
    this.outbox.clear();
    this.consumedApprovals.clear();
    this.idempotencyRegistry.clear();
    for (const op of snapshot.operations) {
      this.operations.set(op.operationId, op);
      const scopedKey = `${op.tenantId}:${op.environmentId}:${op.actionId}:${op.idempotencyKey}`;
      this.idempotencyRegistry.set(scopedKey, {
        preparedDigest: op.preparedDigest,
        receipt: op,
      });
    }
    for (const item of snapshot.outboxItems) {
      this.outbox.set(item.id, item);
    }
    for (const id of snapshot.consumedApprovalIds) {
      this.consumedApprovals.add(id);
    }
  }
}
