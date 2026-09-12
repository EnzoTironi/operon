import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  Notification,
  Request,
  Result,
} from "@modelcontextprotocol/sdk/types.js";
import { AuthenticationError, HumanPrincipal } from "@operon/runtime";
import type { ActionParameters } from "@operon/schema";
import { Clock, Effect, Schema } from "effect";
import { z } from "zod";

import { ApproverNotBoundError } from "./approver.js";

export type OperonServer = Server<Request, Notification, Result>;

/** A private stdio callback to the authenticated host, never a model-facing tool. */
export const verifyHostApproval = Effect.fn("verifyHostApproval")(function* (
  server: OperonServer,
  tool: string,
  args: ActionParameters
) {
  if (!server.getClientCapabilities()?.experimental?.["operon/approval"]) {
    return yield* new ApproverNotBoundError({
      message: "The MCP host cannot verify human approval.",
    });
  }
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      server.request(
        { method: "operon/verify-approval", params: { tool, arguments: args } },
        z.object({ principal: z.unknown() }),
        { signal }
      ),
    catch: () =>
      new AuthenticationError({
        reason: "The host did not authorize this operation.",
      }),
  });
  const principal = yield* Schema.decodeUnknownEffect(HumanPrincipal)(
    response.principal
  ).pipe(
    Effect.mapError(
      () =>
        new AuthenticationError({
          reason: "The host returned an invalid principal.",
        })
    )
  );
  const now = yield* Clock.currentTimeMillis;
  if (principal.sessionExpiresAt <= now) {
    return yield* new AuthenticationError({
      reason: "The host approval has expired.",
    });
  }
  return principal;
});
