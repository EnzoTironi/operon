import { Schema } from "effect";

import type { ActionType } from "./action-type.js";
import type { LinkType } from "./link-type.js";
import type { ObjectType } from "./object-type.js";
import { Subject } from "./security.js";

/**
 * An isolated working branch for ontology modeling
 */
export const OntologyBranch = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentBranchId: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  createdBy: Subject,
  isMain: Schema.Boolean,
  revision: Schema.optionalKey(Schema.Number),
});
export type OntologyBranch = typeof OntologyBranch.Type;
export const OntologyBranchSchema = OntologyBranch;

/**
 * The structured delta of ontology modifications
 */
export interface ProposalChangeSet {
  readonly addedObjectTypes: readonly ObjectType[];
  readonly modifiedObjectTypes: readonly ObjectType[];
  readonly deletedObjectTypeIds: readonly string[];

  readonly addedLinkTypes: readonly LinkType[];
  readonly modifiedLinkTypes: readonly LinkType[];
  readonly deletedLinkTypeIds: readonly string[];

  readonly addedActionTypes: readonly ActionType<any>[];
  readonly modifiedActionTypes: readonly ActionType<any>[];
  readonly deletedActionTypeIds: readonly string[];
}

export const ProposalStatus = Schema.Literals([
  "draft",
  "open",
  "under_review",
  "approved",
  "rejected",
  "merged",
]);
export type ProposalStatus = typeof ProposalStatus.Type;
export const ProposalStatusSchema = ProposalStatus;

export const ProposalReview = Schema.Struct({
  reviewer: Subject,
  verdict: Schema.Literals(["approve", "reject", "request_changes"]),
  comments: Schema.String,
  reviewedAt: Schema.Number,
});
export type ProposalReview = typeof ProposalReview.Type;
export const ProposalReviewSchema = ProposalReview;

/**
 * An Ontology Proposal (PR for the enterprise data model)
 */
export interface OntologyProposal {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly author: Subject;
  readonly status: ProposalStatus;
  readonly changeSet: ProposalChangeSet;
  readonly reviews: readonly ProposalReview[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mergedAt?: number;
}

/**
 * Governance policy determining required approvals
 */
export const ApprovalsPolicy = Schema.Struct({
  requiredMinApprovals: Schema.Number,
  requireComplianceReview: Schema.Boolean,
  requireDomainSpecialistReview: Schema.Boolean,
});
export type ApprovalsPolicy = typeof ApprovalsPolicy.Type;
export const ApprovalsPolicySchema = ApprovalsPolicy;
