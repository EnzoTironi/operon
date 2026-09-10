import type {
  ApprovalsPolicy,
  OntologyProposal,
  ProposalReview,
  Subject,
} from "@operon/schema";
import { Effect } from "effect";

import { ApprovalsPolicyViolationError } from "./oms.js";

export interface MergeEligibility {
  readonly canMerge: boolean;
  readonly reasons: readonly string[];
  readonly approvalsCount: number;
  readonly rejectionsCount: number;
  readonly complianceApproved: boolean;
  readonly domainSpecialistApproved: boolean;
}

/**
 * Multi-Stakeholder Approvals Engine (Foundry Approvals App paradigm)
 * Coordinates peer reviews, compliance sign-offs, and merge gating.
 */
export class ApprovalsEngine {
  constructor(private readonly policy: ApprovalsPolicy) {}

  /**
   * Evaluate whether a proposal satisfies the multi-stakeholder governance policy
   */
  evaluateProposal(proposal: OntologyProposal): MergeEligibility {
    const reviews = proposal.reviews;
    const approvals = reviews.filter((r) => r.verdict === "approve");
    const rejections = reviews.filter((r) => r.verdict === "reject");

    const complianceApproved = reviews.some(
      (r) =>
        r.verdict === "approve" &&
        r.reviewer.type !== "agent" &&
        (r.reviewer.roles.includes("compliance_officer") ||
          r.reviewer.roles.includes("compliance") ||
          r.reviewer.roles.includes("admin"))
    );

    const domainSpecialistApproved = reviews.some(
      (r) =>
        r.verdict === "approve" &&
        r.reviewer.type !== "agent" &&
        (r.reviewer.roles.includes("domain_specialist") ||
          r.reviewer.roles.includes("lead_engineer") ||
          r.reviewer.roles.includes("lead_fde") ||
          r.reviewer.roles.includes("admin"))
    );

    const reasons: string[] = [];

    if (rejections.length > 0) {
      reasons.push(
        `Proposal has ${rejections.length} active rejection(s) that must be resolved.`
      );
    }

    if (approvals.length < this.policy.requiredMinApprovals) {
      reasons.push(
        `Requires at least ${this.policy.requiredMinApprovals} approval(s), but only has ${approvals.length}.`
      );
    }

    if (this.policy.requireComplianceReview && !complianceApproved) {
      reasons.push("Requires sign-off from a Compliance Officer before merge.");
    }

    if (
      this.policy.requireDomainSpecialistReview &&
      !domainSpecialistApproved
    ) {
      reasons.push(
        "Requires sign-off from a Domain Specialist / Lead Engineer before merge."
      );
    }

    const canMerge = reasons.length === 0;

    return {
      canMerge,
      reasons,
      approvalsCount: approvals.length,
      rejectionsCount: rejections.length,
      complianceApproved,
      domainSpecialistApproved,
    };
  }

  /**
   * Submit a review from a stakeholder and verify merge eligibility
   */
  submitReview(
    proposal: OntologyProposal,
    reviewer: Subject,
    verdict: "approve" | "reject" | "request_changes",
    comments: string
  ): Effect.Effect<OntologyProposal> {
    return Effect.sync(() => {
      const newReview: ProposalReview = {
        reviewer,
        verdict,
        comments,
        reviewedAt: Date.now(),
      };

      // Filter out previous reviews from the same subject if updating
      const updatedReviews = [
        ...proposal.reviews.filter((r) => r.reviewer.id !== reviewer.id),
        newReview,
      ];

      const eligibility = this.evaluateProposal({
        ...proposal,
        reviews: updatedReviews,
      });

      let status = proposal.status;
      if (verdict === "reject") {
        status = "rejected";
      } else if (eligibility.canMerge) {
        status = "approved";
      } else {
        status = "under_review";
      }

      return {
        ...proposal,
        status,
        reviews: updatedReviews,
        updatedAt: Date.now(),
      };
    });
  }

  /**
   * Assert proposal is eligible to merge, or fail with ApprovalsPolicyViolationError
   */
  assertMergeable(
    proposal: OntologyProposal
  ): Effect.Effect<void, ApprovalsPolicyViolationError> {
    return Effect.gen({ self: this }, function* () {
      const eligibility = this.evaluateProposal(proposal);
      if (!eligibility.canMerge) {
        return yield* Effect.fail(
          new ApprovalsPolicyViolationError({
            proposalId: proposal.id,
            reason: `Proposal ${proposal.id} does not satisfy approvals policy: ${eligibility.reasons.join("; ")}`,
          })
        );
      }
    });
  }
}
