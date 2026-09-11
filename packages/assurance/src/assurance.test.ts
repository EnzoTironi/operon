import {
  joinPath,
  makeDirSync,
  makeTempDirSync,
  rmDirRecursiveSync,
  writeTextFileSync,
} from "./fs-io.js";

import type {
  ConsentScope,
  F1TestCase,
  TraceableCorrection,
} from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PublicationLeakError } from "./errors.js";
import { F1EvaluatorService } from "./f1-evaluator.js";
import { F2MirrorService } from "./f2-evaluator.js";
import { PublicationBoundaryService } from "./publication-boundary.js";

describe("@operon/assurance test suite", () => {
  describe("Gate F1: Protected Company-in-a-Box Evaluator (V0-CH-10)", () => {
    const validTestCases: readonly F1TestCase[] = [
      {
        id: "TC-001",
        name: "Entity Resolution Precision",
        status: "PASS",
        assertions: 5,
        executionTimeMs: 120,
      },
      {
        id: "TC-002",
        name: "Action Safety Invariants",
        status: "PASS",
        assertions: 8,
        executionTimeMs: 250,
      },
    ];

    it("evaluates a clean candidate, computes digests, and signs PublicF1Receipt with Ed25519", async () => {
      const evaluator = new F1EvaluatorService();

      const effect = evaluator.evaluate({
        candidateId: "cand_v0_test",
        candidateDigest: "abc123candidateDigest",
        profile: "local",
        catalogId: "cat_v0_protected",
        catalogDigest: "def456catalogDigest",
        testCases: validTestCases,
      });

      const receipt = await Effect.runPromise(effect);

      expect(receipt.outcome).toBe("PASS");
      expect(receipt.caseCount).toBe(2);
      expect(receipt.assertionsCount).toBe(13);
      expect(receipt.candidateDigest).toBe("abc123candidateDigest");
      expect(receipt.signature).toBeDefined();
      expect(receipt.signerPublicKey).toBeDefined();

      // Verify the cryptographic Ed25519 signature
      const verifyResult = await Effect.runPromise(
        evaluator.verifyReceipt(receipt)
      );
      expect(verifyResult).toBe(true);
    });

    it("rejects candidate attempting to modify oracle or threshold (F1TamperError)", async () => {
      const evaluator = new F1EvaluatorService();

      const effect = evaluator.evaluate({
        candidateId: "cand_v0_test",
        candidateDigest: "abc123candidateDigest",
        profile: "local",
        catalogId: "cat_v0_protected",
        catalogDigest: "def456catalogDigest",
        testCases: validTestCases,
        candidateAttemptedOracleOverride: true,
      });

      const exit = await Effect.runPromiseExit(effect);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = exit.cause;
        expect(err.toString()).toContain("F1TamperError");
      }
    });

    it("rejects test suites containing zero-assertion, missing, or duplicate cases (F1EmptyAssertionsError)", async () => {
      const evaluator = new F1EvaluatorService();

      // 1. Zero assertions
      const zeroAssertionsCases: readonly F1TestCase[] = [
        {
          id: "TC-ZERO",
          name: "Zero Assertion Test",
          status: "PASS",
          assertions: 0,
          executionTimeMs: 10,
        },
      ];
      const exit1 = await Effect.runPromiseExit(
        evaluator.evaluate({
          candidateId: "cand_v0_test",
          candidateDigest: "abc123candidateDigest",
          profile: "local",
          catalogId: "cat_v0_protected",
          catalogDigest: "def456catalogDigest",
          testCases: zeroAssertionsCases,
        })
      );
      expect(exit1._tag).toBe("Failure");
      if (exit1._tag === "Failure") {
        expect(exit1.cause.toString()).toContain("F1EmptyAssertionsError");
      }

      // 2. Duplicate test case IDs
      const duplicateCases: readonly F1TestCase[] = [
        validTestCases[0]!,
        validTestCases[0]!,
      ];
      const exit2 = await Effect.runPromiseExit(
        evaluator.evaluate({
          candidateId: "cand_v0_test",
          candidateDigest: "abc123candidateDigest",
          profile: "local",
          catalogId: "cat_v0_protected",
          catalogDigest: "def456catalogDigest",
          testCases: duplicateCases,
        })
      );
      expect(exit2._tag).toBe("Failure");
      if (exit2._tag === "Failure") {
        expect(exit2.cause.toString()).toContain("F1EmptyAssertionsError");
      }

      // 3. Empty test cases array
      const exit3 = await Effect.runPromiseExit(
        evaluator.evaluate({
          candidateId: "cand_v0_test",
          candidateDigest: "abc123candidateDigest",
          profile: "local",
          catalogId: "cat_v0_protected",
          catalogDigest: "def456catalogDigest",
          testCases: [],
        })
      );
      expect(exit3._tag).toBe("Failure");
      if (exit3._tag === "Failure") {
        expect(exit3.cause.toString()).toContain("F1EmptyAssertionsError");
      }
    });

    it("enforces non-disclosure: wrong tenant/environment returns NOT_FOUND without disclosing existence", async () => {
      const evaluator = new F1EvaluatorService();

      const effect = evaluator.evaluate({
        candidateId: "cand_v0_test",
        candidateDigest: "abc123candidateDigest",
        profile: "local",
        catalogId: "cat_v0_protected",
        catalogDigest: "def456catalogDigest",
        testCases: validTestCases,
        tenantId: "invalid",
      });

      const exit = await Effect.runPromiseExit(effect);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("NonDisclosureError");
      }
    });

    it("enforces idempotency: same key with identical input returns cached receipt; different input conflicts", async () => {
      const evaluator = new F1EvaluatorService();

      const inputA = {
        candidateId: "cand_v0_test",
        candidateDigest: "abc123candidateDigest",
        profile: "local" as const,
        catalogId: "cat_v0_protected",
        catalogDigest: "def456catalogDigest",
        testCases: validTestCases,
        idempotencyKey: "idem_f1_001",
      };

      const receipt1 = await Effect.runPromise(evaluator.evaluate(inputA));
      const receipt2 = await Effect.runPromise(evaluator.evaluate(inputA));

      // Same key + same input yields identical receipt
      expect(receipt1.signature).toBe(receipt2.signature);

      // Same key + different input conflicts
      const inputB = {
        ...inputA,
        candidateDigest: "different_candidate_digest",
      };
      const exit = await Effect.runPromiseExit(evaluator.evaluate(inputB));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("F1IdempotencyConflictError");
      }
    });

    it("rejects tampered receipts during verification (F1SignatureVerificationError)", async () => {
      const evaluator = new F1EvaluatorService();

      const receipt = await Effect.runPromise(
        evaluator.evaluate({
          candidateId: "cand_v0_test",
          candidateDigest: "abc123candidateDigest",
          profile: "local",
          catalogId: "cat_v0_protected",
          catalogDigest: "def456catalogDigest",
          testCases: validTestCases,
        })
      );

      // Tamper with the outcome
      const tamperedReceipt = {
        ...receipt,
        outcome: "FAIL" as const,
      };

      const exit = await Effect.runPromiseExit(
        evaluator.verifyReceipt(tamperedReceipt)
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("F1SignatureVerificationError");
      }
    });
  });

  describe("Gate F2: Consented Real-Company Mirror Evaluation (V0-CH-11)", () => {
    const validConsent: ConsentScope = {
      consentGrantId: "consent_hospital_2026",
      participantId: "org_metro_health",
      dataScope: ["patient_records", "vitals", "medications"],
      purpose: "safe_dose_recommendation_mirror_validation",
      expiresAt: Date.now() + 86400000,
      createdAt: Date.now() - 1000,
    };

    const validCorrections: readonly TraceableCorrection[] = [
      {
        correctionId: "corr_001",
        observedTarget: "Patient/P001/currentDose",
        priorValue: 14,
        correctedValue: 10,
        correctedBy: "dr_li",
        correctedAt: Date.now() - 500,
        reason:
          "Reduced oral intake and low eGFR warrant lower dose to avoid nocturnal hypoglycemia",
      },
    ];

    it("evaluates a consented mirror with valid scope, traceable corrections, and generates F2Receipt", async () => {
      const mirror = new F2MirrorService();

      const effect = mirror.evaluateMirror({
        candidateDigest: "cand_f2_digest",
        profileDigest: "prof_postgres_mirror",
        rubricDigest: "rubric_clinical_usefulness_v1",
        companyEvidenceRef: "evidence://metro_health/mirror_run_01",
        participantId: "org_metro_health",
        consentScope: validConsent,
        corrections: validCorrections,
        claim: "observed-action",
      });

      const receipt = await Effect.runPromise(effect);

      expect(receipt.claim).toBe("observed-action");
      expect(receipt.participantId).toBe("org_metro_health");
      expect(receipt.correctionRefs).toEqual(["corr_001"]);
      expect(receipt.signature).toBeDefined();

      const verified = await Effect.runPromise(mirror.verifyReceipt(receipt));
      expect(verified).toBe(true);
    });

    it("rejects evaluation when consent is missing, expired, or participant mismatches (F2ConsentViolationError)", async () => {
      const mirror = new F2MirrorService();

      // Expired consent
      const expiredConsent: ConsentScope = {
        ...validConsent,
        expiresAt: Date.now() - 5000,
      };

      const exit = await Effect.runPromiseExit(
        mirror.evaluateMirror({
          candidateDigest: "cand_f2_digest",
          profileDigest: "prof_postgres_mirror",
          rubricDigest: "rubric_clinical_usefulness_v1",
          companyEvidenceRef: "evidence://metro_health/mirror_run_01",
          participantId: "org_metro_health",
          consentScope: expiredConsent,
          corrections: validCorrections,
          claim: "observed-action",
        })
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("F2ConsentViolationError");
      }
    });

    it("rejects external agent attempting kernel bypass instead of public contracts (F2InternalBypassError)", async () => {
      const mirror = new F2MirrorService();

      const exit = await Effect.runPromiseExit(
        mirror.evaluateMirror({
          candidateDigest: "cand_f2_digest",
          profileDigest: "prof_postgres_mirror",
          rubricDigest: "rubric_clinical_usefulness_v1",
          companyEvidenceRef: "evidence://metro_health/mirror_run_01",
          participantId: "org_metro_health",
          consentScope: validConsent,
          corrections: validCorrections,
          claim: "observed-action",
          attemptedKernelBypass: true,
          attemptedBypassPath: "kernel://internal/raw_store/bypass_guard",
        })
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("F2InternalBypassError");
      }
    });

    it("rejects mirror evaluation with zero traceable corrections (F2MissingCorrectionError)", async () => {
      const mirror = new F2MirrorService();

      const exit = await Effect.runPromiseExit(
        mirror.evaluateMirror({
          candidateDigest: "cand_f2_digest",
          profileDigest: "prof_postgres_mirror",
          rubricDigest: "rubric_clinical_usefulness_v1",
          companyEvidenceRef: "evidence://metro_health/mirror_run_01",
          participantId: "org_metro_health",
          consentScope: validConsent,
          corrections: [],
          claim: "model-and-query-only",
        })
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause.toString()).toContain("F2MissingCorrectionError");
      }
    });
  });

  describe("Publication Boundary and Evidence Leak Prevention (V0-CH-12)", () => {
    const boundary = new PublicationBoundaryService();

    it("classifies public vs protected paths accurately", () => {
      expect(boundary.classify("packages/runtime/src/index.ts")).toBe("PUBLIC");
      expect(boundary.classify("docs/specs/S17.md")).toBe("PUBLIC");
      expect(boundary.classify(".evidence/gold/evaluation_cases.json")).toBe(
        "PROTECTED"
      );
      expect(
        boundary.classify("benchmarks/private-oracles/thresholds.json")
      ).toBe("PROTECTED");
      expect(boundary.classify("packages/core/evaluator-weights.bin")).toBe(
        "PROTECTED"
      );
    });

    it("assertNoProtectedMaterial detects and rejects protected markers and digests", () => {
      // Clean content passes
      expect(() => {
        boundary.assertNoProtectedMaterial(
          "This is clean public code and documentation"
        );
      }).not.toThrow();

      // Protected marker throws PublicationLeakError
      expect(() => {
        boundary.assertNoProtectedMaterial(
          "const oracle = '__OPERON_PRIVATE_ORACLE__';"
        );
      }).toThrowError(PublicationLeakError);

      expect(() => {
        boundary.assertNoProtectedMaterial(
          "const weights = '__OPERON_EVALUATOR_WEIGHTS__';"
        );
      }).toThrowError(PublicationLeakError);
    });

    it("scans directories and detects leakage of protected material or paths", () =>
      Effect.gen(function* () {
        const tempDir = makeTempDirSync(
          joinPath(process.cwd(), ".tmp-assurance-test-")
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmDirRecursiveSync(tempDir);
          })
        );

        // Create clean files
        writeTextFileSync(
          joinPath(tempDir, "README.md"),
          "# Operon Public"
        );
        makeDirSync(joinPath(tempDir, "src"));
        writeTextFileSync(
          joinPath(tempDir, "src/main.ts"),
          "export const v = 1;"
        );

        // Scan clean dir
        const cleanScan = yield* boundary.scanDirectory(tempDir, {
          allowedPublicOnly: true,
        });
        expect(cleanScan.isClean).toBe(true);
        expect(cleanScan.violations.length).toBe(0);

        // Inject protected content into a file
        writeTextFileSync(
          joinPath(tempDir, "src/leaked.ts"),
          "const secret = '__OPERON_PROTECTED_GOLD__';"
        );

        const dirtyScan = yield* boundary.scanDirectory(tempDir, {
          allowedPublicOnly: true,
        });
        expect(dirtyScan.isClean).toBe(false);
        expect(dirtyScan.violations.length).toBe(1);
        expect(dirtyScan.violations[0]?.rule).toBe(
          "S17-PROTECTED-CONTENT-LEAK"
        );
      }).pipe(Effect.scoped, Effect.runPromise));

    it("sanitizes receipts by redacting sensitive fields while preserving verifiable digests", () => {
      const rawReceipt = {
        candidateDigest: "cand123",
        outcome: "PASS",
        privateKey: "SUPER_SECRET_KEY",
        internalId: "internal_db_row_999",
        evaluatedAt: 123456789,
      };

      const sanitized = boundary.sanitizeReceipt(rawReceipt);
      expect(sanitized.candidateDigest).toBe("cand123");
      expect(sanitized.outcome).toBe("PASS");
      expect(sanitized.privateKey).toBe("[REDACTED]");
      expect(sanitized.internalId).toBe("[REDACTED]");
      expect(sanitized.evaluatedAt).toBe(123456789);
    });
  });
});
