import type {
  ActionType,
  ActionTypeId,
  ObjectInstance,
  ObjectTypeId,
  SecurityContext,
  Subject,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { InMemoryAuditStore } from "./audit.js";
import { DistributedLockManager } from "./cluster.js";
import { InMemoryObjectStore } from "./object-store.js";
import { executeWritePipeline } from "./write-pipeline.js";

describe("Kernel-Level Mutation Testing: 7-Step Pipeline Fault Injection & Rollbacks", () => {
  const subject: Subject = {
    agentTier: 1,
    id: "fuzz-tester",
    name: "Chaos Injector",
    roles: ["operator"],
    type: "agent",
  };

  const security: SecurityContext = {
    correlationId: "mut-tx-1",
    subject,
    timestamp: Date.now(),
  };

  it("Mutation Fault at Step 1: Missing required parameter fails validation before any mutation", async () => {
    const store = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const typeId = "Vessel" as ObjectTypeId;
    const vesselId = "vessel-mut-1";

    await Effect.runPromise(
      store.putObject({
        id: vesselId,
        lastModifiedAt: 1000,
        properties: { pressurePsi: 50 },
        typeId,
        validFrom: 1000,
        version: 1,
      })
    );

    const pressurizeAction: ActionType<{ targetPsi: number }> = {
      defaultExecutionMode: "automated",
      description: "Pressurize vessel",
      id: "pressurize" as ActionTypeId,
      minimumAgentTier: 1,
      mutations: [],
      name: "Pressurize",
      parametersSchema: Schema.Struct({
        targetPsi: Schema.Number,
      }),
      preconditions: [],
      targetObjectTypeId: typeId,
    };

    // Attempt execution with empty parameters (missing required targetPsi)
    const result = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: pressurizeAction,
          rawParameters: {},
          security,
        },
        store,
        auditStore
      ).pipe(Effect.result)
    );

    expect(result._tag).toBe("Failure");

    // Invariant: Object remains completely untouched at version 1
    const objBefore = await Effect.runPromise(
      store.getObject(typeId, vesselId)
    );
    expect(objBefore?.version).toBe(1);
    expect(objBefore?.properties.pressurePsi).toBe(50);
  });

  it("Mutation Fault at Step 2: Precondition failure intercepts to Action Inbox with zero state mutation", async () => {
    const store = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const typeId = "Vessel" as ObjectTypeId;
    const vesselId = "vessel-mut-2";

    await Effect.runPromise(
      store.putObject({
        id: vesselId,
        lastModifiedAt: 1000,
        properties: { pressurePsi: 150 }, // Over safety limit
        typeId,
        validFrom: 1000,
        version: 1,
      })
    );

    const pressurizeAction: ActionType<{ addPsi: number; vesselId: string }> = {
      defaultExecutionMode: "automated",
      description: "Pressurize vessel",
      id: "pressurize" as ActionTypeId,
      minimumAgentTier: 1,
      mutations: [],
      name: "Pressurize",
      parametersSchema: Schema.Struct({
        addPsi: Schema.Number,
        vesselId: Schema.String,
      }),
      preconditions: [],
      submissionCriteria: [
        {
          description: "Pressure must be under 100 psi to pressurize further",
          evaluate: () =>
            Effect.succeed({
              failureReason: "Pressure exceeded safe threshold (150 >= 100)",
              passed: false,
              verdict: "review",
            }),
          id: "safe_operating_limit",
        },
      ],
      targetObjectTypeId: typeId,
    };

    const result = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: pressurizeAction,
          rawParameters: { addPsi: 50, vesselId },
          security,
          stagedLogic: () =>
            Effect.sync(() => [
              {
                id: vesselId,
                lastModifiedAt: Date.now(),
                properties: { pressurePsi: 200 },
                typeId,
                validFrom: 1000,
                version: 2,
              },
            ]),
        },
        store,
        auditStore
      )
    );

    // Invariant: Mutation was intercepted into inbox as proposal
    expect(result.status).toBe("proposed");

    // Invariant: Underlying object was NEVER mutated
    const objAfter = await Effect.runPromise(store.getObject(typeId, vesselId));
    expect(objAfter?.version).toBe(1);
    expect(objAfter?.properties.pressurePsi).toBe(150);
  });

  it("Mutation Fault at Step 3: Stale OCC version triggers abort with rollback", async () => {
    const store = new InMemoryObjectStore();
    const typeId = "Inventory" as ObjectTypeId;
    const itemId = "item-occ-1";

    await Effect.runPromise(
      store.putObject({
        id: itemId,
        lastModifiedAt: 1000,
        properties: { stock: 50 },
        typeId,
        validFrom: 1000,
        version: 5, // Currently at version 5
      })
    );

    // A stale attempt believing the object is at version 1 should fail OCC
    const staleInstance: ObjectInstance = {
      id: itemId,
      lastModifiedAt: 2000,
      properties: { stock: 20 },
      typeId,
      validFrom: 2000,
      version: 2, // Expected version 6
    };

    const res = await Effect.runPromise(
      store.putObject(staleInstance).pipe(Effect.result)
    );

    expect(res._tag).toBe("Failure");

    // Invariant: Object remains at original version 5 with stock 50
    const current = await Effect.runPromise(store.getObject(typeId, itemId));
    expect(current?.version).toBe(5);
    expect(current?.properties.stock).toBe(50);
  });

  it("Distributed Clustering Fault: Stale fencing token blocks split-brain writes", async () => {
    const dlm = new DistributedLockManager();
    const resource = "cluster:resource:db-1";

    // Node 1 acquires lock (Token = 1)
    const lock1 = await Effect.runPromise(
      dlm.acquire(resource, "node-1", 1000)
    );
    expect(lock1.fencingToken).toBe(1);

    // Node 1 lease expires or Node 2 pre-empts
    await Effect.runPromise(dlm.release(lock1));

    // Node 2 acquires lock (Token = 2)
    const lock2 = await Effect.runPromise(
      dlm.acquire(resource, "node-2", 1000)
    );
    expect(lock2.fencingToken).toBe(2);

    // Node 1 attempts to validate or commit using its old stale token (1 < 2)
    const validateRes = await Effect.runPromise(
      dlm.validateFencingToken(resource, lock1.fencingToken).pipe(Effect.result)
    );

    expect(validateRes._tag).toBe("Failure");
  });

  it("Idempotency Fault: Same idempotency key with different input conflicts and aborts", async () => {
    const store = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const typeId = "Vessel" as ObjectTypeId;

    const action: ActionType<{ targetPsi: number }> = {
      defaultExecutionMode: "automated",
      description: "Pressurize vessel",
      id: "pressurize_idempotent" as ActionTypeId,
      minimumAgentTier: 1,
      mutations: [],
      name: "Pressurize Idempotent",
      parametersSchema: Schema.Struct({
        targetPsi: Schema.Number,
      }),
      preconditions: [],
      sideEffects: [],
      submissionCriteria: [],
      targetObjectTypeId: typeId,
    };

    // First call with key-123 and targetPsi 100
    const firstRes = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: action,
          idempotencyKey: "idem-key-v0-001",
          rawParameters: { targetPsi: 100 },
          security,
        },
        store,
        auditStore
      )
    );
    expect(firstRes.status).toBe("executed");

    // Second call with same key and same parameters -> returns cached result idempotently
    const replayRes = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: action,
          idempotencyKey: "idem-key-v0-001",
          rawParameters: { targetPsi: 100 },
          security,
        },
        store,
        auditStore
      )
    );
    expect(replayRes.status).toBe("executed");
    expect(replayRes.decisionRecord.id).toBe(firstRes.decisionRecord.id);

    // Third call with same key but DIFFERENT parameters -> fails with IdempotencyConflictError
    const conflictRes = await Effect.runPromise(
      executeWritePipeline(
        {
          actionType: action,
          idempotencyKey: "idem-key-v0-001",
          rawParameters: { targetPsi: 200 }, // Changed input!
          security,
        },
        store,
        auditStore
      ).pipe(Effect.result)
    );

    expect(conflictRes._tag).toBe("Failure");
    if (conflictRes._tag === "Failure") {
      expect((conflictRes.failure as any)._tag).toBe(
        "IdempotencyConflictError"
      );
    }
  });
});
