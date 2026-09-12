import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Redacted } from "effect";

import { ensureCellEnv } from "./env-file.ts";

const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

const randomSecret = () =>
  Effect.sync(() => Redacted.make(randomBytes(32).toString("base64url")));

/**
 * Writes the cell keys into the repository `.env` (ignored by git) when they
 * are missing: a Postgres password, the Better Auth secret, the stage port
 * and the derived `OPERON_DATABASE_URL`. Prints key names only.
 */
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stage = yield* Config.string("STAGE").pipe(Config.withDefault("local"));
  const exists = yield* fs.exists(ENV_FILE);
  const existing = exists ? yield* fs.readFileString(ENV_FILE) : "";

  const result = ensureCellEnv(existing, stage, {
    authSecret: yield* randomSecret(),
    postgresPassword: yield* randomSecret(),
  });

  if (result.added.length === 0) {
    yield* Effect.log(
      `${ENV_FILE} already has the cell keys for stage ${stage}`
    );
    return;
  }

  yield* fs.writeFileString(ENV_FILE, result.content, { mode: 0o600 });
  yield* fs.chmod(ENV_FILE, 0o600);
  yield* Effect.log(
    `wrote ${result.added.join(", ")} to ${ENV_FILE} (stage ${stage})`
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
