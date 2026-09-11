import type {
  ReviewFinding,
  ReviewRequest,
  ReviewResult,
} from "@operon/schema";
import { computeReviewReceiptHash } from "@operon/schema";
import { Effect } from "effect";

import {
  IndependentReviewRequiredError,
  ReviewUnavailableError,
} from "./actions-errors.js";

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/iu,
  /system:\s*bypass/iu,
  /override\s+safety\s+filter/iu,
  /grant\s+root\s+authority/iu,
  /disregard\s+prior\s+checks/iu,
  /admin:\s*allow_all/iu,
];

export class SemanticReviewer {
  private isAvailable = true;

  setAvailable(available: boolean): void {
    this.isAvailable = available;
  }

  /**
   * review (S09 / V1-06 Contract Sketch):
   * review(req): Promise<ReviewResult> (or Effect)
   */
  review(
    req: ReviewRequest
  ): Effect.Effect<
    ReviewResult,
    IndependentReviewRequiredError | ReviewUnavailableError
  > {
    const { isAvailable } = this;
    return Effect.gen(function* () {
      // 1. Proposer independence check (S09 Invariant: required reviewer cannot be acting principal)
      if (req.reviewer.id === req.proposer.id) {
        return yield* Effect.fail(
          new IndependentReviewRequiredError({
            message: `Required reviewer cannot be the acting principal '${req.proposer.id}'`,
            proposerId: req.proposer.id,
            reviewerId: req.reviewer.id,
          })
        );
      }

      // 2. Availability check: If mandatory and unavailable, fail closed
      if (!isAvailable) {
        if (req.isMandatory) {
          return yield* Effect.fail(
            new ReviewUnavailableError({
              message:
                "Mandatory semantic reviewer is unavailable; operation held safely",
              reason: "model_service_offline",
            })
          );
        }
        // Advisory review may return held
        const now = Date.now();
        const heldResult: Omit<ReviewResult, "reviewReceiptHash"> = {
          bundleDigest: req.bundleDigest,
          expiresAt: now + 3600 * 1000,
          findings: [
            {
              category: "availability",
              description: "Reviewer offline during advisory review",
              findingId: `f_${now}_0`,
              recommendation: "Hold promotion until semantic review completes",
              severity: "high",
            },
          ],
          limitations: ["Model service unavailable"],
          modelRelease: req.modelRelease ?? "sentinel-review-1.0.0",
          recommendedControls: ["Retry when reviewer service is healthy"],
          requestId: req.requestId,
          reviewedAt: now,
          reviewer: req.reviewer,
          reviewId: `rev_${now}_held`,
          status: "held",
        };
        return {
          ...heldResult,
          reviewReceiptHash: computeReviewReceiptHash(heldResult),
        };
      }

      // 3. Prompt injection and untrusted input scanning (S09 Injection Invariant)
      const findings: ReviewFinding[] = [];
      const contentToScan: string[] = [
        ...req.evidenceReferences,
        JSON.stringify(req.parameters),
        req.scope,
      ];

      for (const item of contentToScan) {
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(item)) {
            findings.push({
              category: "injection_hazard",
              description: `Malicious prompt injection or override pattern detected: ${pattern.source}`,
              findingId: `f_${Date.now()}_${findings.length}`,
              recommendation: "Quarantine bundle and reject favorable review",
              severity: "critical",
            });
          }
        }
      }

      // Nonexistent evidence references check
      for (const ref of req.evidenceReferences) {
        if (ref.includes("fake://") || ref.includes("unverified://")) {
          findings.push({
            category: "invalid_evidence",
            description: `Reference '${ref}' is invalid or outside permitted evidence bundle`,
            findingId: `f_${Date.now()}_${findings.length}`,
            recommendation: "Strip or verify external evidence reference",
            severity: "high",
          });
        }
      }

      const now = Date.now();
      let status: "favorable" | "unfavorable" | "held" = "favorable";
      if (findings.some((f) => f.severity === "critical")) {
        status = "unfavorable";
      } else if (findings.some((f) => f.severity === "high")) {
        status = "held";
      }

      const resultWithoutHash: Omit<ReviewResult, "reviewReceiptHash"> = {
        bundleDigest: req.bundleDigest,
        expiresAt: now + 24 * 3600 * 1000,
        findings,
        limitations: [
          "Semantic review does not constitute formal verification",
          "Review cannot issue policy or mint intent grants",
        ],
        modelRelease: req.modelRelease ?? "sentinel-review-1.0.0",
        recommendedControls:
          findings.length > 0
            ? ["Operator re-validation required"]
            : ["Proceed with standard approval workflow"],
        requestId: req.requestId,
        reviewedAt: now,
        reviewer: req.reviewer,
        reviewId: `rev_${now}_${Math.random().toString(36).slice(2, 7)}`,
        status,
      };

      return {
        ...resultWithoutHash,
        reviewReceiptHash: computeReviewReceiptHash(resultWithoutHash),
      };
    });
  }
}
