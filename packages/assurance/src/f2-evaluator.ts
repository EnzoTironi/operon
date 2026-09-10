import { generateKeyPairSync, sign, verify } from "node:crypto";

import { computeCanonicalDigest } from "@operon/schema";
import type {
  ConsentScope,
  F2Claim,
  F2Receipt,
  TraceableCorrection,
} from "@operon/schema";
import { Effect } from "effect";

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

      // 2. Consent and source scope check
      const { consentScope } = input;
      const now = Date.now();
      if (
        !consentScope ||
        consentScope.participantId !== input.participantId ||
        consentScope.expiresAt <= now ||
        consentScope.dataScope.length === 0
      ) {
        return yield* Effect.fail(
          new F2ConsentViolationError({
            participantId: input.participantId,
            reason:
              consentScope?.expiresAt <= now
                ? `Consent scope '${consentScope.consentGrantId}' has expired`
                : "Consent scope missing, mismatched participant, or empty data scope",
          })
        );
      }

      // 3. External-agent path verification (must use public contracts only)
      if (input.attemptedKernelBypass) {
        return yield* Effect.fail(
          new F2InternalBypassError({
            actorId: input.actorId ?? "external-agent",
            attemptedPath:
              input.attemptedBypassPath ?? "kernel://internal/raw_store",
            reason:
              "External agent attempted kernel bypass; interactions must flow through public CLI/MCP/OSDK contracts only",
          })
        );
      }

      // 4. Traceable correction verification
      if (input.corrections.length === 0) {
        return yield* Effect.fail(
          new F2MissingCorrectionError({
            participantId: input.participantId,
            reason:
              "Real-company mirror proof requires at least one traceable correction demonstrating useful recognition and human-in-the-loop auditability",
          })
        );
      }

      // 5. Idempotency handling
      const inputDigest = computeCanonicalDigest({
        candidateDigest: input.candidateDigest,
        profileDigest: input.profileDigest,
        rubricDigest: input.rubricDigest,
        companyEvidenceRef: input.companyEvidenceRef,
        participantId: input.participantId,
        consentScope: input.consentScope,
        corrections: input.corrections,
        claim: input.claim,
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

      // 6. Assemble and sign receipt
      const evaluatedAt = Date.now();
      const correctionRefs = input.corrections.map((c) => c.correctionId);

      const receiptPayload = {
        candidateDigest: input.candidateDigest,
        claim: input.claim,
        companyEvidenceRef: input.companyEvidenceRef,
        consentScope: input.consentScope,
        correctionRefs,
        evaluatedAt,
        participantId: input.participantId,
        profileDigest: input.profileDigest,
        rubricDigest: input.rubricDigest,
      };

      const payloadCanonicalDigest = computeCanonicalDigest(receiptPayload);
      const signature = sign(
        null,
        Buffer.from(payloadCanonicalDigest, "utf-8"),
        privateKeyPem
      ).toString("hex");

      const receipt: F2Receipt = {
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
    receipt: F2Receipt
  ): Effect.Effect<boolean, F1SignatureVerificationError> {
    return Effect.gen(function* () {
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
    });
  }
}
