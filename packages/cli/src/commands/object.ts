import { createWorldView, parseJson } from "@operon/schema";
import type {
  ActionParameters,
  ObjectInstance,
  ObjectProperties,
  ObjectTypeId,
} from "@operon/schema";
import { Clock, Effect, Exit } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

function getFlagValue(
  args: readonly string[],
  flag: string
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const handleObjectGet = Effect.fn("handleObjectGet")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const typeId = args[1];
  const id = args[2];
  if (!typeId || !id) {
    printCliError("Error: Missing required arguments: <typeId> <id>");
    printCliError(
      "  Usage: operon object get <typeId> <id> [--json] [--db <path>]"
    );
    printCliError("  Example: operon object get Patient P001 --json");
    return 1;
  }
  // SAFETY: typeId argument from CLI treated as ObjectTypeId
  const obj = yield* ctx.objectStore.getObject(typeId as ObjectTypeId, id);
  if (!obj) {
    printCliError(`Error: Object '${id}' of type '${typeId}' not found.`);
    return 1;
  }
  if (isJson) {
    printCliJson(obj);
  } else {
    printCli(`Object: ${obj.typeId}#${obj.id} (v${obj.version})`);
    printCli(`Last Modified: ${new Date(obj.lastModifiedAt).toISOString()}`);
    printCli("Properties:");
    printCliJson(obj.properties);
  }
  return 0;
});

function parsePutFlags(args: readonly string[]) {
  const typeId = getFlagValue(args, "--type");
  const id = getFlagValue(args, "--id");
  const propsStr = getFlagValue(args, "--properties");
  if (!typeId || !id || !propsStr) {
    return null;
  }
  const versionStr = getFlagValue(args, "--version");
  const version = versionStr ? Math.trunc(Number(versionStr)) : 1;
  return {
    id,
    propsStr,
    // SAFETY: typeId string passed from CLI flag is treated as ObjectTypeId
    typeId: typeId as ObjectTypeId,
    version,
  };
}

const handleObjectPut = Effect.fn("handleObjectPut")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const flags = parsePutFlags(args);
  if (!flags) {
    printCliError(
      "Error: Missing required flags for object put: --type, --id, --properties"
    );
    printCliError(
      "  Usage: operon object put --type <typeId> --id <id> --properties '<json>' [--version <n>]"
    );
    printCliError(
      '  Example: operon object put --type Patient --id P002 --properties \'{"name":"Alice","egfr":70}\''
    );
    return 1;
  }

  const parsedExit = yield* Effect.try({
    catch: (err) => err,
    // SAFETY: parsed JSON properties matching ObjectProperties schema
    try: () => parseJson(flags.propsStr) as ObjectProperties,
  }).pipe(Effect.exit);

  if (Exit.isFailure(parsedExit)) {
    printCliError(`Error: Invalid JSON for --properties: ${flags.propsStr}`);
    return 1;
  }

  const putExit = yield* ctx.objectStore
    .putObject({
      id: flags.id,
      lastModifiedAt: yield* Clock.currentTimeMillis,
      properties: parsedExit.value,
      typeId: flags.typeId,
      version: flags.version,
    })
    .pipe(Effect.exit);

  if (Exit.isFailure(putExit)) {
    printCliError(
      `Error: Concurrent modification conflict or put failed: ${String(putExit.cause)}`
    );
    return 1;
  }

  const instance = putExit.value;
  if (isJson) {
    printCliJson({ object: instance, ok: true, status: "COMMITTED" });
  } else {
    printCli(
      `Committed object ${instance.typeId}#${instance.id} (version ${instance.version})`
    );
  }
  return 0;
});

function printQueryResult(result: {
  readonly coverage: {
    readonly completeness: string | number;
    readonly isStale: boolean;
  };
  readonly rows: readonly ObjectInstance[];
  readonly worldView: {
    readonly digest: string;
    readonly knowledgeRevision: number;
    readonly validTime: number;
  };
}): void {
  printCli("=== BITEMPORAL EXACT QUERY RESULT (S04) ===");
  printCli(`WorldView: ${result.worldView.digest}`);
  printCli(`Valid Time: ${new Date(result.worldView.validTime).toISOString()}`);
  printCli(`Knowledge Revision: ${result.worldView.knowledgeRevision}`);
  printCli(
    `Coverage: ${result.coverage.completeness} (isStale: ${result.coverage.isStale})`
  );
  printCli(`Matched Rows: ${result.rows.length}`);
  for (const row of result.rows) {
    printCli(
      `  - ${row.typeId}#${row.id} (v${row.version}): ${JSON.stringify(row.properties)}`
    );
  }
}

function parseObjectId(rawId?: string): string | undefined {
  if (rawId && !rawId.startsWith("--")) {
    return rawId;
  }
  return undefined;
}

function parseTemporalTimes(args: readonly string[], now: number) {
  const vtStr = getFlagValue(args, "--valid-time");
  const validTime = vtStr ? Math.trunc(Number(vtStr)) : now;
  const txStr = getFlagValue(args, "--tx-time");
  const txTime = txStr ? Math.trunc(Number(txStr)) : 1;
  return { txTime, validTime };
}

const handleObjectQuery = Effect.fn("handleObjectQuery")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const typeId = args[1];
  const id = parseObjectId(args[2]);

  if (!typeId) {
    printCliError(
      "Error: Missing required argument <typeId> for object query."
    );
    printCliError(
      "  Usage: operon object query <typeId> [id] [--valid-time <ms>] [--tx-time <ms>] [--json]"
    );
    printCliError(
      "  Example: operon object query Patient P001 --valid-time 1789000000000 --json"
    );
    return 1;
  }

  const now = yield* Clock.currentTimeMillis;
  const { txTime, validTime } = parseTemporalTimes(args, now);

  const worldView = createWorldView({
    definitionReleaseRef: "operon.active.release",
    environmentId: "default",
    evidenceCoverage: [],
    knowledgeRevision: txTime,
    ontologyId: "operon.ontology",
    pinnedAt: now,
    policyContext: {},
    tenantId: "default",
    validTime,
  });

  const params: ActionParameters = id ? { id } : {};
  const result = yield* ctx.reconciliation.query(
    {
      cursor: null,
      params,
      queryId: typeId,
      releaseRef: "operon.active.release",
      worldView,
    },
    ctx.objectStore
  );

  if (isJson) {
    printCliJson(result);
  } else {
    printQueryResult(result);
  }
  return 0;
});

const handleObjectExplain = Effect.fn("handleObjectExplain")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean
) {
  const typeId = args[1];
  const id = args[2];

  if (!typeId || !id) {
    printCliError(
      "Error: Missing required arguments: <typeId> <id> for object explain."
    );
    printCliError(
      "  Usage: operon object explain <typeId> <id> [--valid-time <ms>] [--tx-time <ms>] [--json]"
    );
    printCliError(
      "  Example: operon object explain Patient P001 --valid-time 1789000000000"
    );
    return 1;
  }

  const now = yield* Clock.currentTimeMillis;
  const vtStr = getFlagValue(args, "--valid-time");
  const validTime = vtStr ? Math.trunc(Number(vtStr)) : now;
  const txStr = getFlagValue(args, "--tx-time");
  const txTime = txStr ? Math.trunc(Number(txStr)) : now;

  const queryPlan = ctx.reconciliation.explainQuery({
    dialect: "sqlite",
    id,
    txTime,
    typeId,
    validTime,
  });

  if (isJson) {
    printCliJson({
      id,
      params: queryPlan.params,
      sql: queryPlan.sql,
      txTime,
      typeId,
      validTime,
    });
  } else {
    printCli("=== BITEMPORAL POINT-IN-TIME QUERY PLAN (S04 EXPLAIN) ===");
    printCli(`SQL: ${queryPlan.sql}`);
    printCli("Params:");
    printCliJson(queryPlan.params);
  }
  return 0;
});

const executeObject = Effect.fn("executeObject")(function* (
  ctx: RuntimeContext,
  sub: string | undefined,
  args: string[],
  isJson: boolean
) {
  if (sub === "get") {
    return yield* handleObjectGet(ctx, args, isJson);
  }
  if (sub === "put") {
    return yield* handleObjectPut(ctx, args, isJson);
  }
  if (sub === "query") {
    return yield* handleObjectQuery(ctx, args, isJson);
  }
  if (sub === "explain") {
    return yield* handleObjectExplain(ctx, args, isJson);
  }

  printCliError(`Error: Unknown object subcommand '${sub ?? ""}'`);
  printCliError("  Available subcommands: get, put, query, explain");
  printCliError("  Run 'operon object --help' for details.");
  return 1;
});

export function runObject(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const dbPath = getFlagValue(args, "--db");

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => executeObject(ctx, sub, args, isJson),
    (ctx) => Effect.promise(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "object", subcommand: args[0] ?? "none" })
  );
}
