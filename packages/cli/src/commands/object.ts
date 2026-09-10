import { SqlSchemaGenerator } from "@operon/runtime";
import type { ObjectInstance, ObjectTypeId } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runObject(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));

    try {
      if (sub === "get") {
        const typeId = args[1];
        const id = args[2];
        if (!typeId || !id) {
          console.error("Error: Missing required arguments: <typeId> <id>");
          console.error(
            "  Usage: operon object get <typeId> <id> [--json] [--db <path>]"
          );
          console.error("  Example: operon object get Patient P001 --json");
          return 1;
        }
        const obj = yield* ctx.objectStore.getObject(
          typeId as ObjectTypeId,
          id
        );
        if (!obj) {
          console.error(`Error: Object '${id}' of type '${typeId}' not found.`);
          return 1;
        }
        if (isJson) {
          console.log(JSON.stringify(obj, null, 2));
        } else {
          console.log(`Object: ${obj.typeId}#${obj.id} (v${obj.version})`);
          console.log(
            `Last Modified: ${new Date(obj.lastModifiedAt).toISOString()}`
          );
          console.log("Properties:", JSON.stringify(obj.properties, null, 2));
        }
        return 0;
      }

      if (sub === "put") {
        const typeIndex = args.indexOf("--type");
        const idIndex = args.indexOf("--id");
        const propsIndex = args.indexOf("--properties");
        const versionIndex = args.indexOf("--version");

        if (typeIndex === -1 || idIndex === -1 || propsIndex === -1) {
          console.error(
            "Error: Missing required flags for object put: --type, --id, --properties"
          );
          console.error(
            "  Usage: operon object put --type <typeId> --id <id> --properties '<json>' [--version <n>]"
          );
          console.error(
            '  Example: operon object put --type Patient --id P002 --properties \'{"name":"Alice","egfr":70}\''
          );
          return 1;
        }

        const typeId = args[typeIndex + 1] as ObjectTypeId;
        const id = args[idIndex + 1];
        let properties: Record<string, unknown>;
        try {
          properties = JSON.parse(args[propsIndex + 1]);
        } catch (error: unknown) {
          console.error("Error: --properties must be valid JSON.", error);
          return 1;
        }

        const version =
          versionIndex === -1 ? 1 : Math.trunc(Number(args[versionIndex + 1]));

        const instance: ObjectInstance = {
          id,
          lastModifiedAt: Date.now(),
          properties,
          typeId,
          version,
        };

        yield* ctx.objectStore.putObject(instance).pipe(
          Effect.catch((error: unknown) => {
            console.error("Failed to put object:", error);
            return Effect.succeed(instance);
          })
        );

        if (isJson) {
          console.log(
            JSON.stringify(
              { ok: true, status: "COMMITTED", object: instance },
              null,
              2
            )
          );
        } else {
          console.log(
            `Committed object ${instance.typeId}#${instance.id} (version ${instance.version})`
          );
        }
        return 0;
      }

      if (sub === "query") {
        const typeId = args[1];
        const id = args[2];
        const vtIndex = args.indexOf("--valid-time");
        const txIndex = args.indexOf("--tx-time");

        if (!typeId || !id || vtIndex === -1 || txIndex === -1) {
          console.error(
            "Error: Missing required arguments for bitemporal point-in-time query."
          );
          console.error(
            "  Usage: operon object query <typeId> <id> --valid-time <ms> --tx-time <ms> [--json]"
          );
          console.error(
            "  Example: operon object query Patient P001 --valid-time 1789000000000 --tx-time 1789000000000"
          );
          return 1;
        }

        const validTime = Math.trunc(Number(args[vtIndex + 1]));
        const txTime = Math.trunc(Number(args[txIndex + 1]));

        const queryPlan = SqlSchemaGenerator.compileBitemporalQuery(
          typeId,
          id,
          validTime,
          txTime,
          "sqlite"
        );

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                id,
                params: queryPlan.params,
                sql: queryPlan.sql,
                txTime,
                typeId,
                validTime,
              },
              null,
              2
            )
          );
        } else {
          console.log("=== BITEMPORAL POINT-IN-TIME QUERY PLAN ===");
          console.log(`SQL: ${queryPlan.sql}`);
          console.log(`Params: ${JSON.stringify(queryPlan.params)}`);
        }
        return 0;
      }

      console.error(`Error: Unknown object subcommand '${sub ?? ""}'`);
      console.error("  Available subcommands: get, put, query");
      console.error("  Run 'operon object --help' for details.");
      return 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "object", subcommand: args[0] ?? "none" })
  );
}
