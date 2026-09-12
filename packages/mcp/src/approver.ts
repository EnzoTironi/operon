import type {
  AuthenticationError,
  HumanPrincipal,
  SessionToken,
  SessionVerifier,
} from "@operon/runtime";
import type { Effect } from "effect";
import { Data } from "effect";

/**
 * How the human who may approve through this MCP server is identified.
 *
 * `Unbound` is the plain agent session (Claude Desktop over stdio): every
 * tool that needs a human refuses. `Session` binds the process to one
 * authenticated cell session; the host that spawned the server (Companion,
 * or the operator) holds the token and the kernel never sees a relayed name.
 * The token is verified on every call, so expiry and revocation apply at
 * once.
 */
export type ApproverBinding =
  | { readonly _tag: "Unbound" }
  | {
      readonly _tag: "Session";
      readonly token: SessionToken;
      readonly verifier: SessionVerifier["Service"];
    };

export const unboundApprover: ApproverBinding = { _tag: "Unbound" };

export class ApproverNotBoundError extends Data.TaggedError(
  "ApproverNotBoundError"
)<{
  readonly message: string;
}> {}

/**
 * Resolves the bound approver into a trusted `HumanPrincipal`. Handlers that
 * record a human decision (`operon_approve_prepared_action` today, proposal
 * review next) call this instead of reading identity from tool arguments.
 */
export function resolveApprover(
  binding: ApproverBinding
): Effect.Effect<HumanPrincipal, ApproverNotBoundError | AuthenticationError> {
  switch (binding._tag) {
    case "Unbound": {
      return new ApproverNotBoundError({
        message:
          "No authenticated approver session is bound to this MCP server. Start it with an approver session token; agents cannot supply reviewer identities.",
      });
    }
    case "Session": {
      return binding.verifier.verifySession(binding.token);
    }
    default: {
      const exhaustive: never = binding;
      return exhaustive;
    }
  }
}
