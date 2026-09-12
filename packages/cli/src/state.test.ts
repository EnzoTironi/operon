import { EMAIL_OBJECT_TYPE_IDS, PessoaType } from "@operon/schema";
import type { ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fileExistsSync, resolvePath, unlinkFileSync } from "./fs-io.js";
import { createRuntimeContext } from "./state.js";

const makeScopedTempDb = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      resolvePath(process.cwd(), `.${prefix}-${Date.now()}.db`)
    ),
    (dbPath) =>
      Effect.sync(() => {
        unlinkFileSync(dbPath);
        unlinkFileSync(`${dbPath}.state.json`);
      })
  );

const industryTypeIds = ["AircraftTwin", "ClarifierTank", "Patient"] as const;

const expectEmailTypesOnMain = Effect.fn("expectEmailTypesOnMain")(function* (
  ctx: Awaited<ReturnType<typeof createRuntimeContext>>
) {
  expect(ctx.objectTypes.map((type) => type.id).toSorted()).toEqual([
    ...EMAIL_OBJECT_TYPE_IDS,
  ]);
  expect(ctx.actionTypes).toHaveLength(0);
  const schema = yield* ctx.oms.getSchema("main");
  expect([...schema.objectTypes.keys()].toSorted()).toEqual([
    ...EMAIL_OBJECT_TYPE_IDS,
  ]);
  expect([...schema.linkTypes.keys()].toSorted()).toEqual([
    "com",
    "em",
    "membroDe",
    "participantes",
  ]);
  for (const id of industryTypeIds) {
    expect(schema.objectTypes.has(id)).toBe(false);
    expect(ctx.objectTypes.some((type) => type.id === id)).toBe(false);
  }
});

describe("CLI bootstrap email types", () => {
  it("installs the four email types on main and not Patient, ClarifierTank, or AircraftTwin", () =>
    Effect.gen(function* () {
      const ctx = yield* Effect.promise(() => createRuntimeContext());
      yield* expectEmailTypesOnMain(ctx);
      const patient = yield* ctx.objectStore.getObject(
        "Patient" as ObjectTypeId,
        "P001"
      );
      expect(patient).toBeUndefined();
      yield* Effect.promise(() => ctx.close());
    }).pipe(Effect.scoped, Effect.runPromise));

  it("preserves a Pessoa the operator wrote across two SQLite processes", () =>
    Effect.gen(function* () {
      const dbFile = yield* makeScopedTempDb("operon-durable-v0");

      const processA = yield* Effect.promise(() =>
        createRuntimeContext(dbFile)
      );
      yield* expectEmailTypesOnMain(processA);

      const now = Date.now();
      yield* processA.objectStore.putObject({
        id: "ana-silva",
        lastModifiedAt: now,
        properties: {
          displayName: "Ana Silva",
          emails: ["ana.silva@unimed.com.br"],
        },
        typeId: PessoaType.id,
        version: 1,
      });
      yield* processA.auditStore.appendDecision({
        actionTypeId: "none",
        correlationId: "corr-proc-a",
        id: "decision-proc-a",
        outcome: "executed",
        parameters: { displayName: "Ana Silva" },
        ruleVersion: "1.0.0",
        stateSnapshot: {},
        subject: { id: "agent-a", roles: ["operator"], type: "agent" },
        timestamp: now,
        verdict: "allow",
      });
      yield* processA.objectStore.putObject({
        id: "ana-silva",
        lastModifiedAt: now,
        properties: {
          displayName: "Ana Silva Unimed",
          emails: ["ana.silva@unimed.com.br"],
        },
        typeId: PessoaType.id,
        version: 2,
      });
      yield* Effect.promise(() => processA.close());

      const processB = yield* Effect.promise(() =>
        createRuntimeContext(dbFile)
      );
      yield* expectEmailTypesOnMain(processB);
      const person = yield* processB.objectStore.getObject(
        PessoaType.id,
        "ana-silva"
      );
      expect(person).toBeDefined();
      expect(person?.version).toBe(2);
      expect(person?.properties.displayName).toBe("Ana Silva Unimed");
      const ledger = yield* processB.auditStore.listDecisions();
      expect(ledger.length).toBeGreaterThan(0);
      const isValid = yield* processB.auditStore.verifyAuditChain();
      expect(isValid).toBe(true);
      yield* Effect.promise(() => processB.close());
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
      expect(fileExistsSync(envDbFile)).toBe(true);
      yield* expectEmailTypesOnMain(ctx);
      yield* Effect.promise(() => ctx.close());
    }).pipe(Effect.scoped, Effect.runPromise));
});
