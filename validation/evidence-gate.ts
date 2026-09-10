import { createHash, sign, verify } from "node:crypto";

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

function computeDigest(data: unknown): string {
  const json = JSON.stringify(data, Object.keys(data as any).sort());
  return createHash("sha256").update(json, "utf-8").digest("hex");
}

export function verifyEvidenceEnvelope(
  envelope: EvidenceEnvelope,
  trustedPublicKeyPem?: string
): EvidenceGateResult {
  const now = Date.now();

  // 1. Signature check
  if (
    !envelope.signature ||
    (!envelope.runnerPublicKey && !trustedPublicKeyPem)
  ) {
    return {
      verdict: "REJECTED_UNTRUSTED_BINDING",
      reason: "Missing cryptographic signature or runner public key",
      checkedCasesCount: envelope.cases?.length ?? 0,
      totalAssertions: 0,
      verifiedAt: now,
    };
  }

  const publicKeyToUse = trustedPublicKeyPem ?? envelope.runnerPublicKey!;

  // 2. Compute canonical payload for verification
  const payloadToVerify = {
    candidateDigest: envelope.candidateDigest,
    profileDigest: envelope.profileDigest,
    catalogueDigest: envelope.catalogueDigest,
    fixtureDigest: envelope.fixtureDigest,
    policyDigest: envelope.policyDigest,
    artifactDigests: envelope.artifactDigests,
    runnerIdentity: envelope.runnerIdentity,
    runTimestamp: envelope.runTimestamp,
    cases: envelope.cases,
  };

  const payloadDigest = computeDigest(payloadToVerify);

  try {
    const isValid = verify(
      null,
      Buffer.from(payloadDigest, "utf-8"),
      publicKeyToUse,
      Buffer.from(envelope.signature, "hex")
    );

    if (!isValid) {
      return {
        verdict: "REJECTED_CORRUPT_EVIDENCE",
        reason:
          "Cryptographic signature does not match envelope payload digest",
        checkedCasesCount: envelope.cases?.length ?? 0,
        totalAssertions: 0,
        verifiedAt: now,
      };
    }
  } catch (error: unknown) {
    return {
      checkedCasesCount: envelope.cases?.length ?? 0,
      reason: `Signature verification failed: ${String(error)}`,
      totalAssertions: 0,
      verdict: "REJECTED_CORRUPT_EVIDENCE",
      verifiedAt: now,
    };
  }

  // 3. Completeness and assertions check
  if (!envelope.cases || envelope.cases.length === 0) {
    return {
      verdict: "REJECTED_INCOMPLETE_EVIDENCE",
      reason: "Evidence envelope contains zero test cases",
      checkedCasesCount: 0,
      totalAssertions: 0,
      verifiedAt: now,
    };
  }

  const seenIds = new Set<string>();
  let totalAssertions = 0;

  for (const c of envelope.cases) {
    if (seenIds.has(c.id)) {
      return {
        verdict: "REJECTED_INCOMPLETE_EVIDENCE",
        reason: `Duplicate test case ID '${c.id}' detected in evidence envelope`,
        checkedCasesCount: envelope.cases.length,
        totalAssertions,
        verifiedAt: now,
      };
    }
    seenIds.add(c.id);

    if (c.assertions <= 0) {
      return {
        verdict: "REJECTED_ZERO_ASSERTIONS",
        reason: `Test case '${c.id}' reported success with zero assertions`,
        checkedCasesCount: envelope.cases.length,
        totalAssertions,
        verifiedAt: now,
      };
    }

    totalAssertions += c.assertions;
  }

  // 4. Check for path traversal or malicious artifact paths
  for (const artPath of Object.keys(envelope.artifactDigests || {})) {
    if (
      artPath.includes("..") ||
      artPath.startsWith("/") ||
      artPath.startsWith("\\")
    ) {
      return {
        verdict: "REJECTED_CORRUPT_EVIDENCE",
        reason: `Illegal path traversal detected in artifact digest key: '${artPath}'`,
        checkedCasesCount: envelope.cases.length,
        totalAssertions,
        verifiedAt: now,
      };
    }
  }

  return {
    verdict: "READY_FOR_INDEPENDENT_RELEASE_REVIEW",
    checkedCasesCount: envelope.cases.length,
    totalAssertions,
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
