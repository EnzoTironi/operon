import { Effect } from "effect";

import { SecretUnresolvedError } from "./errors.js";
import type { SecretRef } from "./secret-ref.js";

/**
 * Host-held secret store. The cell resolves SecretRef here. Agents and MCP
 * never receive the value. Callers can only require that a ref exists.
 */
export interface HostSecretStore {
  readonly require: (
    ref: SecretRef
  ) => Effect.Effect<void, SecretUnresolvedError>;
}

export const memoryHostSecretStore = (
  secrets: Readonly<Record<string, string>>
): HostSecretStore => ({
  require: (ref) => {
    const value = secrets[ref.id];
    if (value === undefined || value === "") {
      return Effect.fail(new SecretUnresolvedError({ id: ref.id }));
    }
    return Effect.void;
  },
});
