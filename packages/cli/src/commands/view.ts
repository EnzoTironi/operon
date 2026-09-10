import { generateDisposableAppView } from "@operon/generated-ui";
import type { IntentGrant } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    );
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function runView(args: string[]): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const sub = args[0];
    const isJson = args.includes("--json");
    const useStdin = args.includes("--stdin");

    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));

    try {
      if (sub === "generate") {
        const titleIndex = args.indexOf("--title");
        const title =
          titleIndex === -1 || !args[titleIndex + 1]
            ? "Operon Operational View"
            : args[titleIndex + 1];

        const stateIndex = args.indexOf("--state");
        const rawState =
          stateIndex === -1 || !args[stateIndex + 1]
            ? "PROPOSED"
            : args[stateIndex + 1].toUpperCase();

        const validStates = [
          "ACCEPTED",
          "PROPOSED",
          "RUNNING",
          "CONFIRMED",
          "HYPOTHETICAL",
        ] as const;

        const state = validStates.includes(rawState as any)
          ? (rawState as (typeof validStates)[number])
          : "PROPOSED";

        const formatIndex = args.indexOf("--format");
        const format = (
          formatIndex === -1 || !args[formatIndex + 1]
            ? "markdown"
            : args[formatIndex + 1]
        ) as "markdown" | "table" | "card" | "json";

        const audienceIndex = args.indexOf("--audience");
        const audience =
          audienceIndex === -1 ? undefined : args[audienceIndex + 1];

        let rawData:
          | Record<string, unknown>
          | readonly Record<string, unknown>[] = {};
        if (useStdin) {
          try {
            const stdinBuffer = yield* Effect.promise(() => readStdin());
            rawData = JSON.parse(String(stdinBuffer).trim() || "{}");
          } catch (error: unknown) {
            console.error("Error: Failed to parse JSON from stdin.", error);
            return 1;
          }
        } else {
          const dataIndex = args.indexOf("--data");
          if (dataIndex === -1 || !args[dataIndex + 1]) {
            // keep default empty object
          } else {
            try {
              rawData = JSON.parse(args[dataIndex + 1]);
            } catch (error: unknown) {
              console.error("Error: --data must be valid JSON.", error);
              return 1;
            }
          }
        }

        const grantIndex = args.indexOf("--grant-id");
        const grantId = grantIndex === -1 ? undefined : args[grantIndex + 1];
        let grant: IntentGrant | undefined;
        if (grantId) {
          const grantExit = yield* Effect.exit(
            ctx.authority.getGrant(grantId, "default")
          );
          grant = grantExit._tag === "Success" ? grantExit.value : undefined;
        }

        const view = generateDisposableAppView({
          audience,
          data: rawData,
          format,
          grant,
          state,
          title,
        });

        if (isJson) {
          console.log(JSON.stringify(view, null, 2));
        } else {
          console.log(view.rendered);
        }

        return 0;
      }

      console.error(`Error: Unknown view subcommand '${sub ?? ""}'`);
      console.error("  Available subcommands: generate");
      console.error("  Run 'operon view --help' for details.");
      return 1;
    } finally {
      ctx.close();
    }
  }).pipe(
    Effect.annotateLogs({ command: "view", subcommand: args[0] ?? "none" })
  );
}
