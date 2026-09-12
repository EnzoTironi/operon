import { generateDisposableAppView } from "@operon/generated-ui";
import type { ViewLifecycleState, ViewRecord } from "@operon/generated-ui";
import { parseJson } from "@operon/schema";
import type { IntentGrant } from "@operon/schema";
import { Effect, Exit } from "effect";

import { readStdinSync } from "../fs-io.js";
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

const VALID_STATES: ReadonlySet<string> = new Set([
  "ACCEPTED",
  "PROPOSED",
  "RUNNING",
  "CONFIRMED",
  "HYPOTHETICAL",
]);

function parseViewState(raw?: string): ViewLifecycleState {
  if (!raw) {
    return "PROPOSED";
  }
  const upper = raw.toUpperCase();
  if (VALID_STATES.has(upper)) {
    // SAFETY: upper verified present in VALID_STATES set
    return upper as ViewLifecycleState;
  }
  return "PROPOSED";
}

const VALID_FORMATS: ReadonlySet<string> = new Set([
  "card",
  "json",
  "markdown",
  "table",
]);
type ViewFormat = "markdown" | "table" | "card" | "json";

function parseFormat(raw?: string): ViewFormat {
  if (!raw) {
    return "markdown";
  }
  const lower = raw.toLowerCase();
  if (VALID_FORMATS.has(lower)) {
    // SAFETY: lower verified present in VALID_FORMATS set
    return lower as ViewFormat;
  }
  return "markdown";
}

function readRawData(
  useStdin: boolean,
  args: readonly string[]
): Effect.Effect<ViewRecord | readonly ViewRecord[], Error> {
  if (useStdin) {
    return Effect.try({
      catch: (cause) =>
        new Error(`Failed to parse JSON from stdin: ${String(cause)}`),
      // SAFETY: parse stdin JSON content as ViewRecord
      try: () =>
        parseJson(readStdinSync()) as ViewRecord | readonly ViewRecord[],
    });
  }
  const dataStr = getFlagValue(args, "--data");
  if (!dataStr) {
    return Effect.succeed({});
  }
  return Effect.try({
    catch: (cause) => new Error(`--data must be valid JSON: ${String(cause)}`),
    // SAFETY: parse --data flag JSON as ViewRecord
    try: () => JSON.parse(dataStr) as ViewRecord | readonly ViewRecord[],
  });
}

function loadGrant(
  ctx: RuntimeContext,
  grantId?: string
): Effect.Effect<IntentGrant | undefined> {
  if (!grantId) {
    return Effect.void as Effect.Effect<undefined>;
  }
  return ctx.authority.getGrant(grantId, "default").pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: (grant) => grant,
    })
  );
}

const handleViewGenerate = Effect.fn("handleViewGenerate")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  isJson: boolean,
  useStdin: boolean
) {
  const title = getFlagValue(args, "--title") ?? "Operon Operational View";
  const state = parseViewState(getFlagValue(args, "--state"));
  const format = parseFormat(getFlagValue(args, "--format"));
  const audience = getFlagValue(args, "--audience");
  const grantId = getFlagValue(args, "--grant-id");

  const dataExit = yield* readRawData(useStdin, args).pipe(Effect.exit);
  if (Exit.isFailure(dataExit)) {
    printCliError(dataExit.cause);
    return 1;
  }
  const rawData = dataExit.value;

  const grant = yield* loadGrant(ctx, grantId);

  const view = generateDisposableAppView({
    audience,
    data: rawData,
    format,
    grant,
    state,
    title,
  });

  if (isJson) {
    printCliJson(view);
  } else {
    printCli(view.rendered);
  }
  return 0;
});

export function runView(args: string[]): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const useStdin = args.includes("--stdin");
  const dbPath = getFlagValue(args, "--db");

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => {
      if (sub === "generate") {
        return handleViewGenerate(ctx, args, isJson, useStdin);
      }
      printCliError(`Error: Unknown view subcommand '${sub ?? ""}'`);
      printCliError("  Available subcommands: generate");
      printCliError("  Run 'operon view --help' for details.");
      return Effect.succeed(1);
    },
    (ctx) => Effect.promise(() => ctx.close())
  ).pipe(
    Effect.annotateLogs({ command: "view", subcommand: args[0] ?? "none" })
  );
}
