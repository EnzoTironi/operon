import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  signEvidenceEnvelope,
  verifyEvidenceEnvelope,
} from "./evidence-gate.js";
import type { EvidenceEnvelope } from "./evidence-gate.js";

describe("S17 Evidence Gate (validation/evidence-gate.ts)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const baseValidEnvelope: Omit<
    EvidenceEnvelope,
    "signature" | "runnerPublicKey"
  > = {
    candidateDigest: "cand_digest_sha256_abcdef",
    profileDigest: "prof_digest_sha256_123456",
    catalogueDigest: "cat_digest_sha256_789012",
    fixtureDigest: "fix_digest_sha256_345678",
    policyDigest: "pol_digest_sha256_901234",
    artifactDigests: {
      "doctor.json": "art_doctor_hash",
      "action-executed.json": "art_action_hash",
    },
    runnerIdentity: "operon-independent-ci-runner-1",
    runTimestamp: 1789072000000,
    cases: [
      { id: "VAL-011.T01", status: "PASS", assertions: 4 },
      { id: "VAL-011.T02", status: "PASS", assertions: 6 },
      { id: "VAL-015.T01", status: "PASS", assertions: 3 },
      { id: "VAL-019.T01", status: "PASS", assertions: 5 },
    ],
  };

  it("accepts a valid, Ed25519-signed envelope with all required cases (READY_FOR_INDEPENDENT_RELEASE_REVIEW)", () => {
    const signed = signEvidenceEnvelope(
      baseValidEnvelope,
      privateKey,
      publicKey
    );

    const result = verifyEvidenceEnvelope(signed, publicKey);
    expect(result.verdict).toBe("READY_FOR_INDEPENDENT_RELEASE_REVIEW");
    expect(result.checkedCasesCount).toBe(4);
    expect(result.totalAssertions).toBe(18);
  });

  it("rejects unsigned or missing runner key envelopes (REJECTED_UNTRUSTED_BINDING)", () => {
    const unsigned: EvidenceEnvelope = {
      ...baseValidEnvelope,
    };

    const result = verifyEvidenceEnvelope(unsigned);
    expect(result.verdict).toBe("REJECTED_UNTRUSTED_BINDING");
  });

  it("rejects envelopes when signature is altered or forged (REJECTED_CORRUPT_EVIDENCE)", () => {
    const signed = signEvidenceEnvelope(
      baseValidEnvelope,
      privateKey,
      publicKey
    );

    const tamperedPayload: EvidenceEnvelope = {
      ...signed,
      candidateDigest: "tampered_candidate_digest_different",
    };

    const result = verifyEvidenceEnvelope(tamperedPayload, publicKey);
    expect(result.verdict).toBe("REJECTED_CORRUPT_EVIDENCE");
  });

  it("rejects envelopes reporting success with zero assertions (REJECTED_ZERO_ASSERTIONS)", () => {
    const withZeroAssertions = {
      ...baseValidEnvelope,
      cases: [{ id: "VAL-ZERO", status: "PASS" as const, assertions: 0 }],
    };

    const signed = signEvidenceEnvelope(
      withZeroAssertions,
      privateKey,
      publicKey
    );

    const result = verifyEvidenceEnvelope(signed, publicKey);
    expect(result.verdict).toBe("REJECTED_ZERO_ASSERTIONS");
  });

  it("rejects envelopes with duplicate test cases (REJECTED_INCOMPLETE_EVIDENCE)", () => {
    const withDuplicates = {
      ...baseValidEnvelope,
      cases: [
        { id: "VAL-DUP", status: "PASS" as const, assertions: 2 },
        { id: "VAL-DUP", status: "PASS" as const, assertions: 3 },
      ],
    };

    const signed = signEvidenceEnvelope(withDuplicates, privateKey, publicKey);

    const result = verifyEvidenceEnvelope(signed, publicKey);
    expect(result.verdict).toBe("REJECTED_INCOMPLETE_EVIDENCE");
    expect(result.reason).toContain("Duplicate test case ID");
  });

  it("rejects envelopes with path traversal attempts in artifact digests (REJECTED_CORRUPT_EVIDENCE)", () => {
    const withTraversal = {
      ...baseValidEnvelope,
      artifactDigests: {
        "../../etc/passwd": "malicious_file_hash",
      },
    };

    const signed = signEvidenceEnvelope(withTraversal, privateKey, publicKey);

    const result = verifyEvidenceEnvelope(signed, publicKey);
    expect(result.verdict).toBe("REJECTED_CORRUPT_EVIDENCE");
    expect(result.reason).toContain("path traversal");
  });
});
