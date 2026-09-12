import { Data } from "effect";

/**
 * Host-held secret pointer. The cell resolves this. Agents never see the value.
 * OAuth for the email demo is stubbed: the ref exists, no live token exchange.
 */
export class SecretRef extends Data.TaggedClass("SecretRef")<{
  readonly provider: "file";
  readonly id: string;
}> {}

export const secretRef = (id: string): SecretRef =>
  new SecretRef({ provider: "file", id });
