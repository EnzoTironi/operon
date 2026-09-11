import { generateKeyPairSync, sign, verify } from "node:crypto";

import { computeCanonicalDigest } from "@operon/schema";
import type {
  ConsentScope,
  F2Claim,
  F2Receipt,
  TraceableCorrection,
} from "@operon/schema";
import { Effect, Option } from "effect";

import {
  F1IdempotencyConflictError,
  F1SignatureVerificationError,
  F2ConsentViolationError,
  F2InternalBypassError,
  F2MissingCorrectionError,
  NonDisclosureError,
} from "./errors.js";

export interface F2EvaluatorOptions {
  readonly defaultTenantId?: string;
  readonly defaultEnvironmentId?: string;
  readonly trustedPrivateKeyPem?: string;
  readonly trustedPublicKeyPem?: string;
}

export interface F2EvaluationInput {
  readonly candidateDigest: string;
  readonly profileDigest: string;
  readonly rubricDigest: string;
  readonly companyEvidenceRef: string;
  readonly participantId: string;
  readonly consentScope: ConsentScope;
  readonly corrections: readonly TraceableCorrection[];
  readonly claim: F2Claim;
  readonly attemptedKernelBypass?: boolean;
  readonly attemptedBypassPath?: string;
  readonly actorId?: string;
  readonly tenantId?: string;
  readonly environmentId?: string;
  readonly idempotencyKey?: string;
}

interface KeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

function resolveKeys(options?: F2EvaluatorOptions): KeyPair {
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

function validateF2Scope(
  input: F2EvaluationInput,
  defaultTenantId: string,
  defaultEnvironmentId: string
): Effect.Effect<void, NonDisclosureError> {
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
  return Effect.void;
}

function validateConsentScope(
  input: F2EvaluationInput
): Effect.Effect<void, F2ConsentViolationError> {
  const { consentScope } = input;
  const now = Date.now();
  if (
    !consentScope ||
    consentScope.participantId !== input.participantId ||
    consentScope.dataScope.length === 0
  ) {
    return Effect.fail(
      new F2ConsentViolationError({
        participantId: input.participantId,
        reason:
          "Consent scope missing, mismatched participant, or empty data scope",
      })
    );
  }
  if (consentScope.expiresAt <= now) {
    return Effect.fail(
      new F2ConsentViolationError({
        participantId: input.participantId,
        reason: `Consent scope '${consentScope.consentGrantId}' has expired`,
      })
    );
  }
  return Effect.void;
}

function validateBypassAndCorrections(
  input: F2EvaluationInput
): Effect.Effect<void, F2InternalBypassError | F2MissingCorrectionError> {
  if (input.attemptedKernelBypass) {
    return Effect.fail(
      new F2InternalBypassError({
        actorId: input.actorId ?? "external-agent",
        attemptedPath:
          input.attemptedBypassPath ?? "kernel://internal/raw_store",
        reason:
          "External agent attempted kernel bypass; interactions must flow through public CLI/MCP/OSDK contracts only",
      })
    );
  }
  if (input.corrections.length === 0) {
    return Effect.fail(
      new F2MissingCorrectionError({
        participantId: input.participantId,
        reason:
          "Real-company mirror proof requires at least one traceable correction demonstrating useful recognition and human-in-the-loop auditability",
      })
    );
  }
  return Effect.void;
}

function checkF2Idempotency(
  idempotencyStore: Map<string, { inputDigest: string; receipt: F2Receipt }>,
  idempotencyKey: string | undefined,
  inputDigest: string
): Effect.Effect<Option.Option<F2Receipt>, F1IdempotencyConflictError> {
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

function signF2Receipt(params: {
  readonly input: F2EvaluationInput;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}): F2Receipt {
  const evaluatedAt = Date.now();
  const correctionRefs = params.input.corrections.map((c) => c.correctionId);
  const receiptPayload = {
    candidateDigest: params.input.candidateDigest,
    claim: params.input.claim,
    companyEvidenceRef: params.input.companyEvidenceRef,
    consentScope: params.input.consentScope,
    correctionRefs,
    evaluatedAt,
    participantId: params.input.participantId,
    profileDigest: params.input.profileDigest,
    rubricDigest: params.input.rubricDigest,
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

export class F2MirrorService {
  private readonly privateKeyPem: string;
  private readonly publicKeyPem: string;
  private readonly defaultTenantId: string;
  private readonly defaultEnvironmentId: string;
  private readonly idempotencyStore = new Map<
    string,
    { inputDigest: string; receipt: F2Receipt }
  >();

  constructor(options?: F2EvaluatorOptions) {
    this.defaultTenantId = options?.defaultTenantId ?? "default";
    this.defaultEnvironmentId = options?.defaultEnvironmentId ?? "default";
    const keys = resolveKeys(options);
    this.privateKeyPem = keys.privateKey;
    this.publicKeyPem = keys.publicKey;
  }

  getPublicKey(): string {
    return this.publicKeyPem;
  }

  evaluateMirror(
    input: F2EvaluationInput
  ): Effect.Effect<
    F2Receipt,
    | F2ConsentViolationError
    | F2InternalBypassError
    | F2MissingCorrectionError
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
      yield* validateF2Scope(input, defaultTenantId, defaultEnvironmentId);
      yield* validateConsentScope(input);
      yield* validateBypassAndCorrections(input);

      const inputDigest = computeCanonicalDigest({
        candidateDigest: input.candidateDigest,
        claim: input.claim,
        companyEvidenceRef: input.companyEvidenceRef,
        consentScope: input.consentScope,
        corrections: input.corrections,
        participantId: input.participantId,
        profileDigest: input.profileDigest,
        rubricDigest: input.rubricDigest,
      });

      const cachedReceipt = yield* checkF2Idempotency(
        idempotencyStore,
        input.idempotencyKey,
        inputDigest
      );
      if (Option.isSome(cachedReceipt)) {
        return cachedReceipt.value;
      }

      const receipt = signF2Receipt({
        input,
        privateKeyPem,
        publicKeyPem,
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

  readonly verifyReceipt = Effect.fn("F2MirrorService.verifyReceipt")(
    function* (
      this: F2MirrorService,
      receipt: F2Receipt
    ): Effect.fn.Return<boolean, F1SignatureVerificationError> {
      const receiptPayload = {
        candidateDigest: receipt.candidateDigest,
        profileDigest: receipt.profileDigest,
        rubricDigest: receipt.rubricDigest,
        companyEvidenceRef: receipt.companyEvidenceRef,
        correctionRefs: receipt.correctionRefs,
        claim: receipt.claim,
        participantId: receipt.participantId,
        consentScope: receipt.consentScope,
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
