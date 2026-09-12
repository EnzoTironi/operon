import { SessionVerifier } from "@operon/runtime";
import { Effect, Layer } from "effect";

import { CellAuth } from "./cell-auth.js";

/** The kernel's `SessionVerifier` backed by the cell's Better Auth sessions. */
export const CellSessionVerifier: Layer.Layer<
  SessionVerifier,
  never,
  CellAuth
> = Layer.effect(
  SessionVerifier,
  Effect.gen(function* () {
    const auth = yield* CellAuth;
    return SessionVerifier.of({ verifySession: auth.verifySession });
  })
);
