import * as fs from "node:fs";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PatientType, createRuntimeContext } from "./state.js";

const makeScopedTempDb = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      path.resolve(process.cwd(), `.${prefix}-${Date.now()}.db`)
    ),
    (dbPath) =>
      Effect.sync(() => {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
        const stateFile = `${dbPath}.state.json`;
        if (fs.existsSync(stateFile)) {
          fs.unlinkSync(stateFile);
        }
      })
  );

describe("V0-CH-01: State persistence & two-process SQLite round-trip", () => {
  it("preserves state across two independent processes via durable SQLite profile", () =>
    Effect.gen(function* () {
      const dbFile = yield* makeScopedTempDb("operon-durable-v0");

      // Process A: Initialize, mutate patient, and commit
      const processA = yield* Effect.promise(() =>
        createRuntimeContext(dbFile)
      );
      const patientA = yield* processA.objectStore.getObject(
        PatientType.id,
        "P001"
      );
      expect(patientA).toBeDefined();
      expect(patientA?.properties.currentDose).toBe(14);

      // Process A mutates patient state to dose = 28
      yield* processA.objectStore.putObject({
        ...patientA!,
        lastModifiedAt: Date.now(),
        properties: {
          ...patientA!.properties,
          currentDose: 28,
          room: "ICU-01",
        },
        version: 2,
      });

      // Process A logs a decision
      yield* Effect.promise(() =>
        processA.auditStore.appendDecision({
          actionTypeId: "update_vitals",
          correlationId: "corr-proc-a",
          id: "decision-proc-a",
          outcome: "executed",
          parameters: { currentDose: 28 },
          ruleVersion: "1.0.0",
          stateSnapshot: {},
          subject: { id: "agent-a", roles: ["operator"], type: "agent" },
          timestamp: Date.now(),
          verdict: "allow",
        })
      );

      // Process A closes cleanly
      processA.close();

      // Process B: Independent invocation pointing to the same SQLite storage
      const processB = yield* Effect.promise(() =>
        createRuntimeContext(dbFile)
      );
      const patientB = yield* processB.objectStore.getObject(
        PatientType.id,
        "P001"
      );

      // Verify Process B faithfully sees Process A's mutations
      expect(patientB).toBeDefined();
      expect(patientB?.version).toBe(2);
      expect(patientB?.properties.currentDose).toBe(28);
      expect(patientB?.properties.room).toBe("ICU-01");

      // Process B verifies the audit chain integrity
      const ledger = yield* Effect.promise(() =>
        processB.auditStore.listDecisions()
      );
      expect(ledger.length).toBeGreaterThan(0);
      const isValid = yield* Effect.promise(() =>
        processB.auditStore.verifyAuditChain()
      );
      expect(isValid).toBe(true);

      processB.close();
    }).pipe(Effect.scoped, Effect.runPromise));

  it("respects OPERON_DATABASE_URL environment variable fallback", () =>
    Effect.gen(function* () {
      const envDbFile = yield* makeScopedTempDb("operon-env-db-v0");
      const prevDbUrl = process.env.OPERON_DATABASE_URL;

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.OPERON_DATABASE_URL = envDbFile;
        }),
        () =>
          Effect.sync(() => {
            if (prevDbUrl === undefined) {
              delete process.env.OPERON_DATABASE_URL;
            } else {
              process.env.OPERON_DATABASE_URL = prevDbUrl;
            }
          })
      );

      const ctx = yield* Effect.promise(() => createRuntimeContext());
      expect(fs.existsSync(envDbFile)).toBe(true);

      const patient = yield* ctx.objectStore.getObject(PatientType.id, "P001");
      expect(patient).toBeDefined();

      ctx.close();
    }).pipe(Effect.scoped, Effect.runPromise));
});
