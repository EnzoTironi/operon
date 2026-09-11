import { Schema } from "effect";

import { computeCanonicalDigest } from "./definition.js";
import { SubjectSchema } from "./security.js";

/**
 * ReviewFinding (S09):
 * Structured finding from semantic review
 */
export const ReviewFindingSchema = Schema.Struct({
  category: Schema.String,
  description: Schema.String,
  findingId: Schema.String,
  recommendation: Schema.String,
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
});
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFindingSchema>;

/**
 * ReviewRequest (S09 / V1-06):
 * Input to semantic review service
 */
export const ReviewRequestSchema = Schema.Struct({
  actionId: Schema.String,
  bundleDigest: Schema.String,
  evidenceReferences: Schema.Array(Schema.String),
  isMandatory: Schema.Boolean,
  modelRelease: Schema.optional(Schema.String),
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  promptRelease: Schema.optional(Schema.String),
  proposer: SubjectSchema,
  requestId: Schema.String,
  reviewer: SubjectSchema,
  scope: Schema.String,
});
export type ReviewRequest = Schema.Schema.Type<typeof ReviewRequestSchema>;

/**
 * ReviewResult (S09 / V1-06):
 * Immutable result produced by semantic reviewer
 */
export const ReviewResultSchema = Schema.Struct({
  bundleDigest: Schema.String,
  expiresAt: Schema.Number,
  findings: Schema.Array(ReviewFindingSchema),
  limitations: Schema.Array(Schema.String),
  modelRelease: Schema.String,
  recommendedControls: Schema.Array(Schema.String),
  requestId: Schema.String,
  reviewedAt: Schema.Number,
  reviewer: SubjectSchema,
  reviewId: Schema.String,
  reviewReceiptHash: Schema.String,
  status: Schema.Literals(["favorable", "unfavorable", "held"]),
});
export type ReviewResult = Schema.Schema.Type<typeof ReviewResultSchema>;

export function computeReviewReceiptHash(
  resultWithoutHash: Omit<ReviewResult, "reviewReceiptHash">
): string {
  return computeCanonicalDigest(resultWithoutHash);
}
