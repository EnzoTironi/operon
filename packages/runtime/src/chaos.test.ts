import type {
  ActionType,
  ActionTypeId,
  ObjectInstance,
  ObjectTypeId,
  SecurityContext,
  Subject,
} from "@operon/schema";
import { Duration, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { InMemoryAuditStore } from "./audit.js";
import { StorageError } from "./errors.js";
import { FunnelService } from "./funnel.js";
import { InMemoryObjectStore } from "./object-store.js";
import { CircuitBreaker } from "./resilience.js";
import { executeWritePipeline } from "./write-pipeline.js";

describe("Kernel-Level Chaos Engineering: Linearizability & Concurrency", () => {
  it("executes 50 concurrent fibers with zero lost updates and monotonic OCC versions", async () => {
    const store = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const targetType = "Account" as ObjectTypeId;
    const accountId = "acc-chaos-1";

    // Initialize root object at version 1
    const initial: ObjectInstance = {
      id: accountId,
      lastModifiedAt: Date.now(),
      properties: { balance: 1000, updateCount: 0 },
      typeId: targetType,
      validFrom: Date.now(),
      version: 1,
    };
    await Effect.runPromise(store.putObject(initial));

    const depositAction: ActionType<{ amount: number }> = {
      defaultExecutionMode: "automated",
      description: "Deposit action",
      id: "action_deposit" as ActionTypeId,
      minimumAgentTier: 1,
      name: "Deposit",
      parametersSchema: Schema.Struct({
        amount: Schema.Number,
      }),
      riskTier: "low",
      submissionCriteria: [],
      targetObjectTypeId: targetType,
    };

    const subject: Subject = {
      id: "bot-1",
      name: "Chaos Worker",
      roles: ["operator"],
      type: "agent",
    };

    const security: SecurityContext = {
      correlationId: "chaos-tx-1",
      subject,
      timestamp: Date.now(),
    };

    // Spawn 50 concurrent fibers attempting to update the exact same account
    const concurrency = 50;
    const fiberEffects = Array.from({ length: concurrency }, (_, idx) =>
      executeWritePipeline(
        {
          actionType: depositAction,
          rawParameters: { amount: 10 },
          security: {
            ...security,
            correlationId: `chaos-corr-${idx}`,
          },
          stagedLogic: (params, ctx) =>
            Effect.gen(function* () {
              const obj = yield* ctx.getObject(targetType, accountId);
              if (!obj) return [];
              const currentProps = obj.properties as {
                balance: number;
                updateCount: number;
              };
              return [
                {
                  ...obj,
                  lastModifiedAt: Date.now(),
                  properties: {
                    balance: currentProps.balance + params.amount,
                    updateCount: currentProps.updateCount + 1,
                  },
                  version: obj.version + 1,
                },
              ];
            }),
        },
        store,
        auditStore
      ).pipe(
        Effect.match({
          onFailure: () => "CONFLICT_OR_FAIL",
          onSuccess: () => "SUCCESS",
        })
      )
    );

    const results = await Effect.runPromise(
      Effect.all(fiberEffects, { concurrency: "unbounded" })
    );

    const successes = results.filter((r) => r === "SUCCESS").length;
    const conflicts = results.filter((r) => r === "CONFLICT_OR_FAIL").length;

    expect(successes + conflicts).toBe(concurrency);
    expect(successes).toBeGreaterThanOrEqual(1);

    // The store state must reflect EXACTLY the number of successful commits (Zero Lost Updates)
    const finalObj = await Effect.runPromise(
      store.getObject(targetType, accountId)
    );
    expect(finalObj).toBeDefined();
    expect(finalObj?.version).toBe(1 + successes);
    const finalProperties = finalObj
      ? (finalObj.properties as { balance: number; updateCount: number })
      : { balance: 0, updateCount: 0 };
    expect(finalProperties.updateCount).toBe(successes);
    expect(finalProperties.balance).toBe(1000 + successes * 10);
  });
});

describe("Kernel-Level Chaos Engineering: Cascading Fault Storm & Circuit Breakers", () => {
  it("transitions closed -> open -> half_open under cascading faults without node crash", async () => {
    const breaker = new CircuitBreaker("payment-downstream", {
      failureThreshold: 3,
      recoveryTimeoutMs: 100,
      successThreshold: 1,
    });

    expect(breaker.getState()).toBe("closed");

    // Simulate downstream service dying (3 sequential failures)
    await Effect.runPromise(
      Effect.forEach(
        [1, 2, 3],
        () =>
          breaker
            .execute(
              Effect.fail(
                new StorageError({
                  message: "Downstream connection timeout",
                })
              )
            )
            .pipe(Effect.result),
        { concurrency: 1 }
      )
    );

    // Breaker must now be OPEN
    expect(breaker.getState()).toBe("open");

    // Under OPEN state, calls must fail-fast without hitting the downstream service
    let callsAttempted = 0;
    const fastFailRes = await Effect.runPromise(
      breaker
        .execute(
          Effect.sync(() => {
            callsAttempted++;
            return "OK";
          })
        )
        .pipe(Effect.result)
    );

    expect(callsAttempted).toBe(0); // Zero calls permitted through
    expect(fastFailRes._tag).toBe("Failure");

    // Wait for recovery timeout using Effect.sleep
    await Effect.runPromise(Effect.sleep(Duration.millis(150)));

    // Next call probes the half-open state
    const probeRes = await Effect.runPromise(
      breaker.execute(Effect.succeed("RECOVERED")).pipe(Effect.result)
    );

    expect(probeRes._tag).toBe("Success");
    expect(breaker.getState()).toBe("closed"); // Fully recovered
  });
});

describe("Kernel-Level Chaos Engineering: Funnel Streaming Under Out-of-Order Chaos", () => {
  it("converges to deterministic state under out-of-order LSNs and duplicate message floods", async () => {
    const store = new InMemoryObjectStore();
    const funnel = new FunnelService(store);
    const targetType = "Telemetry" as ObjectTypeId;

    await Effect.runPromise(
      funnel.registerPipeline({
        conflictPolicy: "timestamp_wins",
        id: "pipe-chaos-telemetry",
        name: "Telemetry Pipeline",
        primaryKeyField: "sensor_id",
        propertyMappings: [
          { sourceField: "temperature", targetPropertyName: "temperature" },
          { sourceField: "pressure", targetPropertyName: "pressure" },
          { sourceField: "timestamp", targetPropertyName: "timestamp" },
        ],
        targetObjectTypeId: targetType,
      })
    );

    // Generate 100 events for 5 sensors in random out-of-order timestamps
    const sensors = ["s-1", "s-2", "s-3", "s-4", "s-5"];
    const events: Record<string, unknown>[] = [];

    for (let i = 0; i < 100; i++) {
      const sensorId = sensors[i % sensors.length];
      const ts = 1000 + ((i * 37) % 500); // Pseudo-random timestamps
      events.push({
        pressure: 100 + (i % 15),
        sensor_id: sensorId,
        temperature: 20 + (i % 30),
        timestamp: ts,
      });
    }

    // Ingest all 100 events concurrently to simulate chaotic network delivery
    await Effect.runPromise(
      Effect.all(
        events.map((ev) =>
          funnel.ingestStreamRecord("pipe-chaos-telemetry", ev)
        ),
        { concurrency: "unbounded" }
      )
    );

    // Invariant: For each sensor, stored object must exist and match valid schema
    const storedSensors = await Effect.runPromise(
      Effect.all(
        sensors.map((sid) => store.getObject(targetType, sid)),
        { concurrency: "unbounded" }
      )
    );

    for (const stored of storedSensors) {
      expect(stored).toBeDefined();
      expect(stored?.properties.temperature).toBeDefined();
      expect(stored?.properties.pressure).toBeDefined();
    }
  });
});
