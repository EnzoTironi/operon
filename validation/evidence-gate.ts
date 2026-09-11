import { createHash, sign, verify } from "node:crypto";

import { Effect, Exit } from "effect";

export interface EvidenceEnvelope {
  readonly candidateDigest: string;
  readonly profileDigest: string;
  readonly catalogueDigest: string;
  readonly fixtureDigest: string;
  readonly policyDigest: string;
  readonly artifactDigests: Record<string, string>;
  readonly runnerIdentity: string;
  readonly runTimestamp: number;
  readonly cases: readonly {
    readonly id: string;
    readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
    readonly assertions: number;
  }[];
  readonly signature?: string;
  readonly runnerPublicKey?: string;
}

export type EvidenceGateVerdict =
  | "READY_FOR_INDEPENDENT_RELEASE_REVIEW"
  | "REJECTED_UNTRUSTED_BINDING"
  | "REJECTED_INCOMPLETE_EVIDENCE"
  | "REJECTED_CORRUPT_EVIDENCE"
  | "REJECTED_ZERO_ASSERTIONS";

export interface EvidenceGateResult {
  readonly verdict: EvidenceGateVerdict;
  readonly reason?: string;
  readonly checkedCasesCount: number;
  readonly totalAssertions: number;
  readonly verifiedAt: number;
}

export type EnvelopePayload = Omit<
  EvidenceEnvelope,
  "signature" | "runnerPublicKey"
>;

function computeDigest(data: EnvelopePayload): string {
  const json = JSON.stringify(data, Object.keys(data).toSorted());
  return createHash("sha256").update(json, "utf-8").digest("hex");
}

type CryptoVerifyOutcome =
  | { readonly success: true }
  | { readonly success: false; readonly reason: string };

function getCasesCount(cases: EvidenceEnvelope["cases"] | undefined): number {
  if (!cases) {
    return 0;
  }
  return cases.length;
}

function buildEnvelopePayload(envelope: EvidenceEnvelope): EnvelopePayload {
  return {
    artifactDigests: envelope.artifactDigests,
    candidateDigest: envelope.candidateDigest,
    cases: envelope.cases,
    catalogueDigest: envelope.catalogueDigest,
    fixtureDigest: envelope.fixtureDigest,
    policyDigest: envelope.policyDigest,
    profileDigest: envelope.profileDigest,
    runTimestamp: envelope.runTimestamp,
    runnerIdentity: envelope.runnerIdentity,
  };
}

function verifySignatureOutcome(
  payloadDigest: string,
  signature: string,
  publicKeyPem: string
): CryptoVerifyOutcome {
  const verificationResult = Effect.try({
    catch: String,
    try: () =>
      verify(
        null,
        Buffer.from(payloadDigest, "utf-8"),
        publicKeyPem,
        Buffer.from(signature, "hex")
      ),
  }).pipe(Effect.exit, Effect.runSync);

  if (Exit.isFailure(verificationResult)) {
    return {
      reason: `Signature verification failed: ${String(verificationResult.cause)}`,
      success: false,
    };
  }

  if (!verificationResult.value) {
    return {
      reason: "Cryptographic signature does not match envelope payload digest",
      success: false,
    };
  }

  return { success: true };
}

function validateSignature(
  envelope: EvidenceEnvelope,
  publicKeyToUse: string | undefined,
  now: number
): EvidenceGateResult | null {
  const casesCount = getCasesCount(envelope.cases);
  if (!envelope.signature || !publicKeyToUse) {
    return {
      checkedCasesCount: casesCount,
      reason: "Missing cryptographic signature or runner public key",
      totalAssertions: 0,
      verdict: "REJECTED_UNTRUSTED_BINDING",
      verifiedAt: now,
    };
  }

  const payloadToVerify = buildEnvelopePayload(envelope);
  const payloadDigest = computeDigest(payloadToVerify);
  const outcome = verifySignatureOutcome(
    payloadDigest,
    envelope.signature,
    publicKeyToUse
  );

  if (!outcome.success) {
    return {
      checkedCasesCount: casesCount,
      reason: outcome.reason,
      totalAssertions: 0,
      verdict: "REJECTED_CORRUPT_EVIDENCE",
      verifiedAt: now,
    };
  }

  return null;
}

type CasesValidationOutcome =
  | { readonly totalAssertions: number; readonly valid: true }
  | { readonly result: EvidenceGateResult; readonly valid: false };

function validateEnvelopeCases(
  cases: EvidenceEnvelope["cases"] | undefined,
  now: number
): CasesValidationOutcome {
  if (!cases || cases.length === 0) {
    return {
      result: {
        checkedCasesCount: 0,
        reason: "Evidence envelope contains zero test cases",
        totalAssertions: 0,
        verdict: "REJECTED_INCOMPLETE_EVIDENCE",
        verifiedAt: now,
      },
      valid: false,
    };
  }

  const seenIds = new Set<string>();
  let totalAssertions = 0;

  for (const c of cases) {
    if (seenIds.has(c.id)) {
      return {
        result: {
          checkedCasesCount: cases.length,
          reason: `Duplicate test case ID '${c.id}' detected in evidence envelope`,
          totalAssertions,
          verdict: "REJECTED_INCOMPLETE_EVIDENCE",
          verifiedAt: now,
        },
        valid: false,
      };
    }
    seenIds.add(c.id);

    if (c.assertions <= 0) {
      return {
        result: {
          checkedCasesCount: cases.length,
          reason: `Test case '${c.id}' reported success with zero assertions`,
          totalAssertions,
          verdict: "REJECTED_ZERO_ASSERTIONS",
          verifiedAt: now,
        },
        valid: false,
      };
    }

    totalAssertions += c.assertions;
  }

  return { totalAssertions, valid: true };
}

function isIllegalArtifactPath(artPath: string): boolean {
  return (
    artPath.includes("..") ||
    artPath.startsWith("/") ||
    artPath.startsWith("\\")
  );
}

function validateArtifactPaths(
  artifactDigests: Record<string, string> | undefined,
  casesCount: number,
  totalAssertions: number,
  now: number
): EvidenceGateResult | null {
  const paths = Object.keys(artifactDigests ?? {});
  for (const artPath of paths) {
    if (isIllegalArtifactPath(artPath)) {
      return {
        checkedCasesCount: casesCount,
        reason: `Illegal path traversal detected in artifact digest key: '${artPath}'`,
        totalAssertions,
        verdict: "REJECTED_CORRUPT_EVIDENCE",
        verifiedAt: now,
      };
    }
  }
  return null;
}

export function verifyEvidenceEnvelope(
  envelope: EvidenceEnvelope,
  trustedPublicKeyPem?: string
): EvidenceGateResult {
  const now = Date.now();
  const publicKeyToUse = trustedPublicKeyPem ?? envelope.runnerPublicKey;

  const sigResult = validateSignature(envelope, publicKeyToUse, now);
  if (sigResult !== null) {
    return sigResult;
  }

  const casesOutcome = validateEnvelopeCases(envelope.cases, now);
  if (!casesOutcome.valid) {
    return casesOutcome.result;
  }

  const casesCount = envelope.cases.length;
  const pathResult = validateArtifactPaths(
    envelope.artifactDigests,
    casesCount,
    casesOutcome.totalAssertions,
    now
  );
  if (pathResult !== null) {
    return pathResult;
  }

  return {
    checkedCasesCount: casesCount,
    totalAssertions: casesOutcome.totalAssertions,
    verdict: "READY_FOR_INDEPENDENT_RELEASE_REVIEW",
    verifiedAt: now,
  };
}

export function signEvidenceEnvelope(
  envelopeWithoutSig: Omit<EvidenceEnvelope, "signature" | "runnerPublicKey">,
  privateKeyPem: string,
  publicKeyPem: string
): EvidenceEnvelope {
  const payloadDigest = computeDigest(envelopeWithoutSig);
  const signature = sign(
    null,
    Buffer.from(payloadDigest, "utf-8"),
    privateKeyPem
  ).toString("hex");

  return {
    ...envelopeWithoutSig,
    signature,
    runnerPublicKey: publicKeyPem,
  };
}
