import { generateKeyPairSync, sign, verify } from "node:crypto";

import { computeCanonicalDigest } from "@operon/schema";
import type { F1Outcome, F1TestCase, PublicF1Receipt } from "@operon/schema";
import { Effect } from "effect";

import {
  F1EmptyAssertionsError,
  F1IdempotencyConflictError,
  F1SignatureVerificationError,
  F1TamperError,
  NonDisclosureError,
} from "./errors.js";

export interface F1EvaluatorOptions {
  readonly defaultTenantId?: string;
  readonly defaultEnvironmentId?: string;
  readonly trustedPrivateKeyPem?: string;
  readonly trustedPublicKeyPem?: string;
}

export interface F1EvaluationInput {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly profile: "local" | "production" | "external-agent";
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly testCases: readonly F1TestCase[];
  readonly candidateAttemptedOracleOverride?: boolean;
  readonly tenantId?: string;
  readonly environmentId?: string;
  readonly idempotencyKey?: string;
}

export class F1EvaluatorService {
  private readonly privateKeyPem: string;
  private readonly publicKeyPem: string;
  private readonly defaultTenantId: string;
  private readonly defaultEnvironmentId: string;
  private readonly idempotencyStore = new Map<
    string,
    { inputDigest: string; receipt: PublicF1Receipt }
  >();

  constructor(options?: F1EvaluatorOptions) {
    this.defaultTenantId = options?.defaultTenantId ?? "default";
    this.defaultEnvironmentId = options?.defaultEnvironmentId ?? "default";

    if (options?.trustedPrivateKeyPem && options?.trustedPublicKeyPem) {
      this.privateKeyPem = options.trustedPrivateKeyPem;
      this.publicKeyPem = options.trustedPublicKeyPem;
    } else {
      const keypair = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      this.privateKeyPem = keypair.privateKey;
      this.publicKeyPem = keypair.publicKey;
    }
  }

  getPublicKey(): string {
    return this.publicKeyPem;
  }

  evaluate(
    input: F1EvaluationInput
  ): Effect.Effect<
    PublicF1Receipt,
    | F1TamperError
    | F1EmptyAssertionsError
    | F1IdempotencyConflictError
    | NonDisclosureError
  > {
    const {
      defaultEnvironmentId,
      defaultTenantId,
      idempotencyStore,
      privateKeyPem,
      publicKeyPem,
    } = this;
    return Effect.gen(function* () {
      // 1. Non-disclosure check
      const tenant = input.tenantId ?? defaultTenantId;
      const environment = input.environmentId ?? defaultEnvironmentId;
      if (tenant === "invalid" || environment === "invalid") {
        return yield* Effect.fail(
          new NonDisclosureError({
            code: "NOT_FOUND",
            message: "Target resource not found in designated scope",
          })
        );
      }

      // 2. Anti-tamper check (Candidate cannot change oracle/threshold)
      if (input.candidateAttemptedOracleOverride) {
        return yield* Effect.fail(
          new F1TamperError({
            reason:
              "Protected acceptance violation: candidate attempted to modify oracle or threshold",
            target: "evaluation_oracle",
          })
        );
      }

      // 3. Test case verification (reject zero-assertion, missing, or duplicate cases)
      if (input.testCases.length === 0) {
        return yield* Effect.fail(
          new F1EmptyAssertionsError({
            caseId: "NONE",
            reason: "Evaluation catalogue contains zero test cases",
          })
        );
      }

      const seenIds = new Set<string>();
      let totalAssertions = 0;
      let hasFail = false;
      let hasInconclusive = false;

      for (const tc of input.testCases) {
        if (seenIds.has(tc.id)) {
          return yield* Effect.fail(
            new F1EmptyAssertionsError({
              caseId: tc.id,
              reason: `Duplicate test case ID '${tc.id}' detected in catalogue`,
            })
          );
        }
        seenIds.add(tc.id);

        if (tc.assertions <= 0) {
          return yield* Effect.fail(
            new F1EmptyAssertionsError({
              caseId: tc.id,
              reason: `Test case '${tc.id}' has ${tc.assertions} assertions; zero-assertion tests are rejected`,
            })
          );
        }

        totalAssertions += tc.assertions;

        if (tc.status === "FAIL") {
          hasFail = true;
        } else if (tc.status === "INCONCLUSIVE") {
          hasInconclusive = true;
        }
      }

      // 4. Determine overall logical outcome
      let outcome: F1Outcome = "PASS";
      if (hasFail) {
        outcome = "FAIL";
      } else if (hasInconclusive) {
        outcome = "INCONCLUSIVE";
      }

      // 5. Idempotency handling
      const inputDigest = computeCanonicalDigest({
        candidateId: input.candidateId,
        candidateDigest: input.candidateDigest,
        profile: input.profile,
        catalogId: input.catalogId,
        catalogDigest: input.catalogDigest,
        testCases: input.testCases,
      });

      if (input.idempotencyKey) {
        const existing = idempotencyStore.get(input.idempotencyKey);
        if (existing) {
          if (existing.inputDigest !== inputDigest) {
            return yield* Effect.fail(
              new F1IdempotencyConflictError({
                details: `Idempotency key '${input.idempotencyKey}' was already used with a different evaluation input`,
                idempotencyKey: input.idempotencyKey,
              })
            );
          }
          return existing.receipt;
        }
      }

      // 6. Compute cryptographic digests
      const profileDigest = computeCanonicalDigest({ profile: input.profile });
      const evaluatedAt = Date.now();

      const receiptPayload = {
        assertionsCount: totalAssertions,
        candidateDigest: input.candidateDigest,
        catalogDigest: input.catalogDigest,
        caseCount: input.testCases.length,
        evaluatedAt,
        outcome,
        profileDigest,
      };

      const payloadCanonicalDigest = computeCanonicalDigest(receiptPayload);
      const signature = sign(
        null,
        Buffer.from(payloadCanonicalDigest, "utf-8"),
        privateKeyPem
      ).toString("hex");

      const receipt: PublicF1Receipt = {
        ...receiptPayload,
        signature,
        signerPublicKey: publicKeyPem,
      };

      if (input.idempotencyKey) {
        idempotencyStore.set(input.idempotencyKey, {
          inputDigest,
          receipt,
        });
      }

      return receipt;
    });
  }

  verifyReceipt(
    receipt: PublicF1Receipt
  ): Effect.Effect<boolean, F1SignatureVerificationError> {
    return Effect.gen(function* () {
      const receiptPayload = {
        candidateDigest: receipt.candidateDigest,
        profileDigest: receipt.profileDigest,
        catalogDigest: receipt.catalogDigest,
        outcome: receipt.outcome,
        caseCount: receipt.caseCount,
        assertionsCount: receipt.assertionsCount,
        evaluatedAt: receipt.evaluatedAt,
      };

      const payloadCanonicalDigest = computeCanonicalDigest(receiptPayload);

      try {
        const isValid = verify(
          null,
          Buffer.from(payloadCanonicalDigest, "utf-8"),
          receipt.signerPublicKey,
          Buffer.from(receipt.signature, "hex")
        );

        if (!isValid) {
          return yield* Effect.fail(
            new F1SignatureVerificationError({
              candidateDigest: receipt.candidateDigest,
              signature: receipt.signature,
            })
          );
        }

        return true;
      } catch {
        return yield* Effect.fail(
          new F1SignatureVerificationError({
            candidateDigest: receipt.candidateDigest,
            signature: receipt.signature,
          })
        );
      }
    });
  }
}
