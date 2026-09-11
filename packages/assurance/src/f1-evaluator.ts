import { generateKeyPairSync, sign, verify } from "node:crypto";

import { computeCanonicalDigest } from "@operon/schema";
import type { F1Outcome, F1TestCase, PublicF1Receipt } from "@operon/schema";
import { Effect, Option } from "effect";

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

interface TestCaseAggregation {
  readonly outcome: F1Outcome;
  readonly totalAssertions: number;
}

interface KeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

function resolveKeys(options?: F1EvaluatorOptions): KeyPair {
  if (options?.trustedPrivateKeyPem && options?.trustedPublicKeyPem) {
    return {
      privateKey: options.trustedPrivateKeyPem,
      publicKey: options.trustedPublicKeyPem,
    };
  }
  const keypair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return { privateKey: keypair.privateKey, publicKey: keypair.publicKey };
}

function validateScopeAndTamper(
  input: F1EvaluationInput,
  defaultTenantId: string,
  defaultEnvironmentId: string
): Effect.Effect<void, NonDisclosureError | F1TamperError> {
  const tenant = input.tenantId ?? defaultTenantId;
  const environment = input.environmentId ?? defaultEnvironmentId;
  if (tenant === "invalid" || environment === "invalid") {
    return Effect.fail(
      new NonDisclosureError({
        code: "NOT_FOUND",
        message: "Target resource not found in designated scope",
      })
    );
  }
  if (input.candidateAttemptedOracleOverride) {
    return Effect.fail(
      new F1TamperError({
        reason:
          "Protected acceptance violation: candidate attempted to modify oracle or threshold",
        target: "evaluation_oracle",
      })
    );
  }
  return Effect.void;
}

function checkTestCase(
  tc: F1TestCase,
  seenIds: Set<string>
): Effect.Effect<void, F1EmptyAssertionsError> {
  if (seenIds.has(tc.id)) {
    return Effect.fail(
      new F1EmptyAssertionsError({
        caseId: tc.id,
        reason: `Duplicate test case ID '${tc.id}' detected in catalogue`,
      })
    );
  }
  seenIds.add(tc.id);
  if (tc.assertions <= 0) {
    return Effect.fail(
      new F1EmptyAssertionsError({
        caseId: tc.id,
        reason: `Test case '${tc.id}' has ${tc.assertions} assertions; zero-assertion tests are rejected`,
      })
    );
  }
  return Effect.void;
}

function determineOutcome(
  hasFail: boolean,
  hasInconclusive: boolean
): F1Outcome {
  if (hasFail) {
    return "FAIL";
  }
  if (hasInconclusive) {
    return "INCONCLUSIVE";
  }
  return "PASS";
}

const aggregateTestCases = Effect.fn("aggregateTestCases")(function* (
  testCases: readonly F1TestCase[]
): Effect.fn.Return<TestCaseAggregation, F1EmptyAssertionsError> {
  if (testCases.length === 0) {
    return yield* new F1EmptyAssertionsError({
      caseId: "NONE",
      reason: "Evaluation catalogue contains zero test cases",
    });
  }
  const seenIds = new Set<string>();
  let totalAssertions = 0;
  let hasFail = false;
  let hasInconclusive = false;
  const processTestCase = Effect.fn("processTestCase")(function* (
    tc: F1TestCase
  ) {
    yield* checkTestCase(tc, seenIds);
    totalAssertions += tc.assertions;
    if (tc.status === "FAIL") {
      hasFail = true;
    } else if (tc.status === "INCONCLUSIVE") {
      hasInconclusive = true;
    }
  });
  yield* Effect.forEach(testCases, processTestCase, { concurrency: 1 });
  return {
    outcome: determineOutcome(hasFail, hasInconclusive),
    totalAssertions,
  };
});

function checkF1Idempotency(
  idempotencyStore: Map<
    string,
    { inputDigest: string; receipt: PublicF1Receipt }
  >,
  idempotencyKey: string | undefined,
  inputDigest: string
): Effect.Effect<Option.Option<PublicF1Receipt>, F1IdempotencyConflictError> {
  if (!idempotencyKey) {
    return Effect.succeed(Option.none());
  }
  const existing = idempotencyStore.get(idempotencyKey);
  if (!existing) {
    return Effect.succeed(Option.none());
  }
  if (existing.inputDigest !== inputDigest) {
    return Effect.fail(
      new F1IdempotencyConflictError({
        details: `Idempotency key '${idempotencyKey}' was already used with a different evaluation input`,
        idempotencyKey,
      })
    );
  }
  return Effect.succeed(Option.some(existing.receipt));
}

function signF1Receipt(params: {
  readonly input: F1EvaluationInput;
  readonly totalAssertions: number;
  readonly outcome: F1Outcome;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}): PublicF1Receipt {
  const profileDigest = computeCanonicalDigest({
    profile: params.input.profile,
  });
  const evaluatedAt = Date.now();
  const receiptPayload = {
    assertionsCount: params.totalAssertions,
    candidateDigest: params.input.candidateDigest,
    catalogDigest: params.input.catalogDigest,
    caseCount: params.input.testCases.length,
    evaluatedAt,
    outcome: params.outcome,
    profileDigest,
  };
  const payloadCanonicalDigest = computeCanonicalDigest(receiptPayload);
  const signature = sign(
    null,
    Buffer.from(payloadCanonicalDigest, "utf-8"),
    params.privateKeyPem
  ).toString("hex");
  return {
    ...receiptPayload,
    signature,
    signerPublicKey: params.publicKeyPem,
  };
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
    const keys = resolveKeys(options);
    this.privateKeyPem = keys.privateKey;
    this.publicKeyPem = keys.publicKey;
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
      yield* validateScopeAndTamper(
        input,
        defaultTenantId,
        defaultEnvironmentId
      );
      const { outcome, totalAssertions } = yield* aggregateTestCases(
        input.testCases
      );

      const inputDigest = computeCanonicalDigest({
        candidateDigest: input.candidateDigest,
        candidateId: input.candidateId,
        catalogDigest: input.catalogDigest,
        catalogId: input.catalogId,
        profile: input.profile,
        testCases: input.testCases,
      });

      const cachedReceipt = yield* checkF1Idempotency(
        idempotencyStore,
        input.idempotencyKey,
        inputDigest
      );
      if (Option.isSome(cachedReceipt)) {
        return cachedReceipt.value;
      }

      const receipt = signF1Receipt({
        input,
        outcome,
        privateKeyPem,
        publicKeyPem,
        totalAssertions,
      });

      if (input.idempotencyKey) {
        idempotencyStore.set(input.idempotencyKey, {
          inputDigest,
          receipt,
        });
      }

      return receipt;
    });
  }

  readonly verifyReceipt = Effect.fn("F1EvaluatorService.verifyReceipt")(
    function* (
      this: F1EvaluatorService,
      receipt: PublicF1Receipt
    ): Effect.fn.Return<boolean, F1SignatureVerificationError> {
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

      const isValid = yield* Effect.try({
        catch: () =>
          new F1SignatureVerificationError({
            candidateDigest: receipt.candidateDigest,
            signature: receipt.signature,
          }),
        try: () =>
          verify(
            null,
            Buffer.from(payloadCanonicalDigest, "utf-8"),
            receipt.signerPublicKey,
            Buffer.from(receipt.signature, "hex")
          ),
      });

      if (!isValid) {
        return yield* new F1SignatureVerificationError({
          candidateDigest: receipt.candidateDigest,
          signature: receipt.signature,
        });
      }

      return true;
    }
  );
}
