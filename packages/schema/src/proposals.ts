import type { ActionType } from "./action-type.js";
import type { LinkType } from "./link-type.js";
import type { ObjectType } from "./object-type.js";
import type { Subject } from "./security.js";

/**
 * An isolated working branch for ontology modeling
 */
export interface OntologyBranch {
  readonly id: string;
  readonly name: string;
  readonly parentBranchId?: string;
  readonly createdAt: number;
  readonly createdBy: Subject;
  readonly isMain: boolean;
}

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

export type ProposalStatus =
  | "draft"
  | "open"
  | "under_review"
  | "approved"
  | "rejected"
  | "merged";

export interface ProposalReview {
  readonly reviewer: Subject;
  readonly verdict: "approve" | "reject" | "request_changes";
  readonly comments: string;
  readonly reviewedAt: number;
}

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
export interface ApprovalsPolicy {
  readonly requiredMinApprovals: number;
  readonly requireComplianceReview: boolean;
  readonly requireDomainSpecialistReview: boolean;
}
