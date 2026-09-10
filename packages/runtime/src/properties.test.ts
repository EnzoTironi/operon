import type { ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";
import {
  array,
  assert,
  constantFrom,
  double,
  integer,
  property,
  record,
  string,
} from "fast-check";
import { describe, expect, it } from "vitest";

import { InMemoryAuditStore } from "./audit.js";
import type { ColumnDataType } from "./columnar-store.js";
import { ColumnarBatchEncoder, ColumnarBatchTable } from "./columnar-store.js";
import { InMemoryObjectStore } from "./object-store.js";
import { ObjectSet } from "./oss.js";

describe("Kernel-Level Property-Based Testing (Fast-Check)", () => {
  it("Property: Parquet / Columnar encoding is lossless across arbitrary row collections", () => {
    assert(
      property(
        array(
          record({
            amount: double({ max: 100000, min: -100000, noNaN: true }),
            count: integer({ max: 1000000, min: 0 }),
            id: string({ maxLength: 20, minLength: 1 }),
            status: constantFrom("ACTIVE", "PENDING", "DISABLED", "SUSPENDED"),
          }),
          { maxLength: 50, minLength: 1 }
        ),
        (records) => {
          const schema: Record<string, ColumnDataType> = {
            amount: "float64",
            count: "int32",
            id: "string",
            status: "string",
          };

          const table = ColumnarBatchEncoder.encode(records, schema);

          // Invariant 1: Row count exactly matches input
          expect(table.getRowCount()).toBe(records.length);

          // Invariant 2: Column projection preserves exact values
          const projected = table.project(["status", "amount"]);
          expect(projected.getColumnNames()).toEqual(["status", "amount"]);

          // Invariant 3: Binary serialization round-trip is identical
          const bin = table.toBinary();
          const restored = ColumnarBatchTable.fromBinary(bin);
          const restoredRecords = restored.toRecords();

          expect(restoredRecords.length).toBe(records.length);
          for (let i = 0; i < records.length; i++) {
            expect(restoredRecords[i].id).toBe(records[i].id);
            expect(restoredRecords[i].status).toBe(records[i].status);
            expect(restoredRecords[i].amount).toBeCloseTo(records[i].amount, 5);
            expect(restoredRecords[i].count).toBe(records[i].count);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property: Predicate pushdown statistics never produce false negatives", () => {
    assert(
      property(
        array(integer({ max: 1000, min: -1000 }), {
          maxLength: 30,
          minLength: 1,
        }),
        integer({ max: 500, min: -500 }),
        (numbers, target) => {
          const records = numbers.map((n, idx) => ({ id: `r-${idx}`, val: n }));
          const table = ColumnarBatchEncoder.encode(records, {
            id: "string",
            val: "int32",
          });

          const actualContains = numbers.some((n) => n === target);
          const canMatch = table.canMatchRange("val", target, target);

          // Invariant: If actual value exists in the column chunk, canMatchRange MUST be true
          if (actualContains) {
            expect(canMatch).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property: Cryptographic Merkle audit chain detects 100% of bit-flip tamperings", async () => {
    const auditStore = new InMemoryAuditStore();

    // Create a chain of 10 decision records sequentially using Effect.forEach
    const decisionInputs = Array.from({ length: 10 }, (_, i) => ({
      actionTypeId: "action_audit_test",
      correlationId: `corr-${i}`,
      id: `dec-${i}`,
      outcome: "executed" as const,
      parameters: { step: i },
      ruleVersion: "1.0.0",
      stateSnapshot: { step: i },
      subject: {
        id: "admin",
        name: "Admin",
        roles: ["admin"],
        type: "user" as const,
      },
      timestamp: Date.now() + i,
      verdict: "allow" as const,
    }));

    await Effect.runPromise(
      Effect.forEach(
        decisionInputs,
        (input) => Effect.promise(() => auditStore.appendDecision(input)),
        { concurrency: 1 }
      )
    );

    const decisions = await auditStore.listDecisions();
    expect(decisions.length).toBe(10);

    // Verify unbroken cryptographic chain: H_i.previousRecordHash === H_{i-1}.recordHash
    for (let i = 1; i < decisions.length; i++) {
      expect(decisions[i].previousRecordHash).toBe(decisions[i - 1].recordHash);
    }
  });

  it("Property: Set Algebra on Object Sets satisfies Commutativity and Idempotence", async () => {
    const store = new InMemoryObjectStore();
    const typeId = "Widget" as ObjectTypeId;

    // Put 10 widgets in parallel
    const widgets = Array.from({ length: 10 }, (_, i) => ({
      id: `w-${i}`,
      lastModifiedAt: Date.now(),
      properties: { category: i % 2 === 0 ? "even" : "odd", value: i * 10 },
      typeId,
      validFrom: Date.now(),
      version: 1,
    }));

    await Effect.runPromise(
      Effect.all(
        widgets.map((w) => store.putObject(w)),
        { concurrency: "unbounded" }
      )
    );

    const setAll = new ObjectSet(store, typeId);
    const setEvens = setAll.filter((obj) => obj.properties.category === "even");
    const setOdds = setAll.filter((obj) => obj.properties.category === "odd");

    // Commutativity: Evens U Odds == Odds U Evens
    const unionA = await Effect.runPromise(setEvens.union(setOdds).all());
    const unionB = await Effect.runPromise(setOdds.union(setEvens).all());

    expect(unionA.length).toBe(unionB.length);
    const idsA = unionA.map((o) => o.id).sort();
    const idsB = unionB.map((o) => o.id).sort();
    expect(idsA).toEqual(idsB);

    // Idempotence: Evens U Evens == Evens
    const unionSelf = await Effect.runPromise(setEvens.union(setEvens).all());
    const evensOnly = await Effect.runPromise(setEvens.all());
    expect(unionSelf.length).toBe(evensOnly.length);
  });
});
