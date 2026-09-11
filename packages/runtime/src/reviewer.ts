import type {
  ReviewFinding,
  ReviewRequest,
  ReviewResult,
} from "@operon/schema";
import { computeReviewReceiptHash, generatePrefixedId } from "@operon/schema";
import { Clock, Effect, Schema } from "effect";

import {
  IndependentReviewRequiredError,
  ReviewUnavailableError,
} from "./actions-errors.js";

const jsonCodec = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(jsonCodec);

const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/iu,
  /system:\s*bypass/iu,
  /override\s+safety\s+filter/iu,
  /grant\s+root\s+authority/iu,
  /disregard\s+prior\s+checks/iu,
  /admin:\s*allow_all/iu,
];

function scanInjectionPatterns(
  contentToScan: readonly string[],
  timestamp: number
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const item of contentToScan) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(item)) {
        findings.push({
          category: "injection_hazard",
          description: `Malicious prompt injection or override pattern detected: ${pattern.source}`,
          findingId: `f_${timestamp}_${findings.length}`,
          recommendation: "Quarantine bundle and reject favorable review",
          severity: "critical",
        });
      }
    }
  }
  return findings;
}

function scanEvidenceReferences(
  evidenceReferences: readonly string[],
  timestamp: number,
  startIndex: number
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const ref of evidenceReferences) {
    if (ref.includes("fake://") || ref.includes("unverified://")) {
      findings.push({
        category: "invalid_evidence",
        description: `Reference '${ref}' is invalid or outside permitted evidence bundle`,
        findingId: `f_${timestamp}_${startIndex + findings.length}`,
        recommendation: "Strip or verify external evidence reference",
        severity: "high",
      });
    }
  }
  return findings;
}

function determineReviewStatus(
  findings: readonly ReviewFinding[]
): "favorable" | "unfavorable" | "held" {
  if (findings.some((f) => f.severity === "critical")) {
    return "unfavorable";
  }
  if (findings.some((f) => f.severity === "high")) {
    return "held";
  }
  return "favorable";
}

function createHeldAdvisoryResult(
  req: ReviewRequest,
  now: number
): ReviewResult {
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

export class SemanticReviewer {
  private isAvailable = true;

  setAvailable(available: boolean): void {
    this.isAvailable = available;
  }

  /**
   * review (S09 / V1-06 Contract Sketch):
   * review(req): Promise<ReviewResult> (or Effect)
   */
  review = Effect.fn("SemanticReviewer.review")(function* (
    this: SemanticReviewer,
    req: ReviewRequest
  ) {
    // 1. Proposer independence check (S09 Invariant: required reviewer cannot be acting principal)
    if (req.reviewer.id === req.proposer.id) {
      return yield* new IndependentReviewRequiredError({
        message: `Required reviewer cannot be the acting principal '${req.proposer.id}'`,
        proposerId: req.proposer.id,
        reviewerId: req.reviewer.id,
      });
    }

    // 2. Availability check: If mandatory and unavailable, fail closed
    if (!this.isAvailable) {
      if (req.isMandatory) {
        return yield* new ReviewUnavailableError({
          message:
            "Mandatory semantic reviewer is unavailable; operation held safely",
          reason: "model_service_offline",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      return createHeldAdvisoryResult(req, now);
    }

    // 3. Prompt injection and untrusted input scanning (S09 Injection Invariant)
    const scanTimestamp = yield* Clock.currentTimeMillis;
    const contentToScan: string[] = [
      ...req.evidenceReferences,
      encodeJson(req.parameters),
      req.scope,
    ];

    const injectionFindings = scanInjectionPatterns(
      contentToScan,
      scanTimestamp
    );
    const evidenceFindings = scanEvidenceReferences(
      req.evidenceReferences,
      scanTimestamp,
      injectionFindings.length
    );
    const findings: ReviewFinding[] = [
      ...injectionFindings,
      ...evidenceFindings,
    ];

    const now = yield* Clock.currentTimeMillis;
    const status = determineReviewStatus(findings);

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
      reviewId: generatePrefixedId("rev", now),
      status,
    };

    return {
      ...resultWithoutHash,
      reviewReceiptHash: computeReviewReceiptHash(resultWithoutHash),
    };
  });
}
