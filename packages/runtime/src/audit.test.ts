import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { DecisionRecord } from "./audit.js";
import { canonicalJson, InMemoryAuditStore } from "./audit.js";

const makeRecord = (label: string): Omit<DecisionRecord, "recordHash"> => ({
  actionTypeId: "update-order",
  correlationId: "request-1",
  id: "decision-1",
  outcome: "executed",
  parameters: { label },
  ruleVersion: "1.0.0",
  stateSnapshot: { version: 1 },
  subject: {
    id: "reviewer",
    name: "Reviewer",
    roles: ["reviewer"],
    type: "user",
  },
  timestamp: 1000,
  verdict: "allow",
});

describe("Cryptographic SHA-256 AuditStore", () => {
  it("produces deterministic canonical JSON regardless of key insertion order", () => {
    const jsonA = canonicalJson({ b: 2, a: 1, nested: { y: 20, x: 10 } });
    const jsonB = canonicalJson({ a: 1, b: 2, nested: { x: 10, y: 20 } });
    expect(jsonA).toBe(jsonB);
    expect(jsonA).toBe('{"a":1,"b":2,"nested":{"x":10,"y":20}}');
  });

  it("produces distinct SHA-256 hashes for distinct payloads (remedying polynomial collision Aa vs BB)", async () => {
    const storeLeft = new InMemoryAuditStore();
    const storeRight = new InMemoryAuditStore();

    const left = await Effect.runPromise(
      storeLeft.appendDecision(makeRecord("Aa"))
    );
    const right = await Effect.runPromise(
      storeRight.appendDecision(makeRecord("BB"))
    );

    expect(left.recordHash).not.toBe(right.recordHash);
    expect(left.recordHash).toHaveLength(64); // 256-bit hex
    expect(right.recordHash).toHaveLength(64);
  });

  it("isolates stored record from caller input mutation (caller-alias defense)", async () => {
    const store = new InMemoryAuditStore();
    const input = makeRecord("original");
    const output = await Effect.runPromise(store.appendDecision(input));
    const originalHash = output.recordHash;

    (input.parameters as Record<string, unknown>).label =
      "changed-after-append";
    const readOpt = await Effect.runPromise(store.getDecision(input.id));
    const read = Option.getOrUndefined(readOpt);

    expect(read).toBeDefined();
    expect(read?.parameters.label).toBe("original");
    expect(read?.recordHash).toBe(originalHash);
  });

  it("isolates stored record from reader mutation (reader-alias defense)", async () => {
    const store = new InMemoryAuditStore();
    const appended = await Effect.runPromise(
      store.appendDecision(makeRecord("original"))
    );
    const readOpt = await Effect.runPromise(store.getDecision(appended.id));
    const read = Option.getOrUndefined(readOpt);
    expect(read).toBeDefined();

    Effect.try(() => {
      (read!.parameters as Record<string, unknown>).label =
        "changed-through-read";
    }).pipe(Effect.ignore, Effect.runSync);

    const rereadOpt = await Effect.runPromise(store.getDecision(appended.id));
    const reread = Option.getOrUndefined(rereadOpt);
    expect(reread?.parameters.label).toBe("original");
    expect(reread?.recordHash).toBe(appended.recordHash);
  });

  it("cryptographically verifies an intact audit chain", async () => {
    const store = new InMemoryAuditStore();
    await Effect.runPromise(store.appendDecision(makeRecord("record-1")));
    await Effect.runPromise(
      store.appendDecision({
        ...makeRecord("record-2"),
        id: "decision-2",
        timestamp: 2000,
      })
    );
    await Effect.runPromise(
      store.appendDecision({
        ...makeRecord("record-3"),
        id: "decision-3",
        timestamp: 3000,
      })
    );

    const isIntact = await Effect.runPromise(store.verifyAuditChain());
    expect(isIntact).toBe(true);
  });

  it("detects tampering when audit chain is compromised", async () => {
    const store = new InMemoryAuditStore();
    await Effect.runPromise(store.appendDecision(makeRecord("record-1")));
    await Effect.runPromise(
      store.appendDecision({
        ...makeRecord("record-2"),
        id: "decision-2",
        timestamp: 2000,
      })
    );

    // Access internal decisions array through forced tampering
    const internalStore = store as any;
    const tampered = {
      ...internalStore.decisions[0],
      parameters: { label: "tampered-payload" },
    };
    internalStore.decisions[0] = tampered;

    const isIntact = await Effect.runPromise(store.verifyAuditChain());
    expect(isIntact).toBe(false);
  });
});
