import type {
  ActionType,
  ApprovalsPolicy,
  InterfaceType,
  LinkType,
  ObjectType,
  OntologyBranch,
  OntologyProposal,
  ProposalChangeSet,
  ProposalReview,
  Subject,
} from "@operon/schema";
import { Data, Effect } from "effect";

import { ProposalNotFoundError } from "./errors.js";

export class BranchNotFoundError extends Data.TaggedError(
  "BranchNotFoundError"
)<{
  readonly branchName: string;
}> {}

export class ProposalMergeConflictError extends Data.TaggedError(
  "ProposalMergeConflictError"
)<{
  readonly proposalId: string;
  readonly reason: string;
}> {}

export class ApprovalsPolicyViolationError extends Data.TaggedError(
  "ApprovalsPolicyViolationError"
)<{
  readonly proposalId: string;
  readonly reason: string;
}> {}

export interface BranchSchemaDelta {
  readonly objectTypes: Map<string, ObjectType>;
  readonly linkTypes: Map<string, LinkType>;
  readonly actionTypes: Map<string, ActionType<any>>;
  readonly interfaceTypes: Map<string, InterfaceType>;
}

/**
 * OMS (Ontology Metadata Service)
 * Authoritative registry of ontology definitions, branching, and proposal lifecycles.
 */
export class OntologyMetadataService {
  private readonly branches = new Map<string, OntologyBranch>();
  private readonly branchSchemas = new Map<string, BranchSchemaDelta>();
  private readonly proposals = new Map<string, OntologyProposal>();

  constructor() {
    // Initialize standard main branch
    const mainBranch: OntologyBranch = {
      createdAt: Date.now(),
      createdBy: {
        id: "system",
        name: "System Administrator",
        roles: ["admin"],
        type: "system",
      },
      id: "main",
      isMain: true,
      name: "main",
    };
    this.branches.set("main", mainBranch);
    this.branchSchemas.set("main", {
      actionTypes: new Map(),
      interfaceTypes: new Map(),
      linkTypes: new Map(),
      objectTypes: new Map(),
    });
  }

  // Branch Management
  createBranch(
    name: string,
    author: Subject,
    parentBranchId = "main"
  ): Effect.Effect<OntologyBranch, BranchNotFoundError> {
    const parentSchema = this.branchSchemas.get(parentBranchId);
    if (!parentSchema) {
      return Effect.fail(
        new BranchNotFoundError({ branchName: parentBranchId })
      );
    }

    const branch: OntologyBranch = {
      createdAt: Date.now(),
      createdBy: author,
      id: name,
      isMain: false,
      name,
      parentBranchId,
    };

    this.branches.set(name, branch);
    // Fork parent branch schema
    this.branchSchemas.set(name, {
      actionTypes: new Map(parentSchema.actionTypes),
      interfaceTypes: new Map(parentSchema.interfaceTypes),
      linkTypes: new Map(parentSchema.linkTypes),
      objectTypes: new Map(parentSchema.objectTypes),
    });

    return Effect.succeed(branch);
  }

  getBranch(name: string): Effect.Effect<OntologyBranch, BranchNotFoundError> {
    const branch = this.branches.get(name);
    if (!branch) {
      return Effect.fail(new BranchNotFoundError({ branchName: name }));
    }
    return Effect.succeed(branch);
  }

  listBranches(): Effect.Effect<readonly OntologyBranch[]> {
    return Effect.succeed([...this.branches.values()]);
  }

  // Schema Registration on Branch
  registerObjectType(
    branchName: string,
    objectType: ObjectType
  ): Effect.Effect<void, BranchNotFoundError> {
    const schema = this.branchSchemas.get(branchName);
    if (!schema) {
      return Effect.fail(new BranchNotFoundError({ branchName }));
    }
    schema.objectTypes.set(objectType.id, objectType);
    return Effect.void;
  }

  registerLinkType(
    branchName: string,
    linkType: LinkType
  ): Effect.Effect<void, BranchNotFoundError> {
    const schema = this.branchSchemas.get(branchName);
    if (!schema) {
      return Effect.fail(new BranchNotFoundError({ branchName }));
    }
    schema.linkTypes.set(linkType.id, linkType);
    return Effect.void;
  }

  registerActionType(
    branchName: string,
    actionType: ActionType<any>
  ): Effect.Effect<void, BranchNotFoundError> {
    const schema = this.branchSchemas.get(branchName);
    if (!schema) {
      return Effect.fail(new BranchNotFoundError({ branchName }));
    }
    schema.actionTypes.set(actionType.id, actionType);
    return Effect.void;
  }

  getSchema(
    branchName = "main"
  ): Effect.Effect<BranchSchemaDelta, BranchNotFoundError> {
    const schema = this.branchSchemas.get(branchName);
    if (!schema) {
      return Effect.fail(new BranchNotFoundError({ branchName }));
    }
    return Effect.succeed(schema);
  }

  // Proposal (PR) Lifecycle
  createProposal(args: {
    readonly title: string;
    readonly description: string;
    readonly sourceBranch: string;
    readonly targetBranch?: string;
    readonly author: Subject;
    readonly changeSet: ProposalChangeSet;
  }): Effect.Effect<OntologyProposal, BranchNotFoundError> {
    const targetBranch = args.targetBranch ?? "main";
    if (!this.branches.has(args.sourceBranch)) {
      return Effect.fail(
        new BranchNotFoundError({ branchName: args.sourceBranch })
      );
    }
    if (!this.branches.has(targetBranch)) {
      return Effect.fail(new BranchNotFoundError({ branchName: targetBranch }));
    }

    const now = Date.now();
    const proposal: OntologyProposal = {
      author: args.author,
      changeSet: args.changeSet,
      createdAt: now,
      description: args.description,
      id: `prop_${now}_${Math.random().toString(36).slice(2, 7)}`,
      reviews: [],
      sourceBranch: args.sourceBranch,
      status: "open",
      targetBranch,
      title: args.title,
      updatedAt: now,
    };

    this.proposals.set(proposal.id, proposal);
    return Effect.succeed(proposal);
  }

  reviewProposal(
    proposalId: string,
    review: ProposalReview
  ): Effect.Effect<OntologyProposal, ProposalNotFoundError> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return Effect.fail(
        new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found`,
          proposalId,
        })
      );
    }

    const updatedReviews = [...proposal.reviews, review];
    const hasRejections = updatedReviews.some((r) => r.verdict === "reject");
    const status = hasRejections ? "rejected" : "under_review";

    const updated: OntologyProposal = {
      ...proposal,
      reviews: updatedReviews,
      status,
      updatedAt: Date.now(),
    };

    this.proposals.set(proposalId, updated);
    return Effect.succeed(updated);
  }

  mergeProposal(
    proposalId: string,
    merger: Subject,
    policy: ApprovalsPolicy = {
      requireComplianceReview: false,
      requireDomainSpecialistReview: false,
      requiredMinApprovals: 1,
    }
  ): Effect.Effect<
    OntologyProposal,
    ProposalNotFoundError | ApprovalsPolicyViolationError | BranchNotFoundError
  > {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return Effect.fail(
        new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found`,
          proposalId,
        })
      );
    }

    // Check rejection
    if (
      proposal.status === "rejected" ||
      proposal.reviews.some((r) => r.verdict === "reject")
    ) {
      return Effect.fail(
        new ApprovalsPolicyViolationError({
          proposalId,
          reason: "Proposal has been rejected and cannot be merged",
        })
      );
    }

    // Check policy
    const approvals = proposal.reviews.filter((r) => r.verdict === "approve");
    if (approvals.length < policy.requiredMinApprovals) {
      return Effect.fail(
        new ApprovalsPolicyViolationError({
          proposalId,
          reason: `Requires at least ${policy.requiredMinApprovals} approvals; found ${approvals.length}`,
        })
      );
    }

    if (policy.requireComplianceReview) {
      const complianceApproved = approvals.some((a) =>
        a.reviewer.roles.includes("compliance_officer")
      );
      if (!complianceApproved) {
        return Effect.fail(
          new ApprovalsPolicyViolationError({
            proposalId,
            reason: "Requires sign-off from a compliance officer",
          })
        );
      }
    }

    if (policy.requireDomainSpecialistReview) {
      const specialistApproved = approvals.some(
        (a) =>
          a.reviewer.roles.includes("specialist") ||
          a.reviewer.roles.includes("domain_specialist")
      );
      if (!specialistApproved) {
        return Effect.fail(
          new ApprovalsPolicyViolationError({
            proposalId,
            reason: "Requires sign-off from a domain specialist",
          })
        );
      }
    }

    const targetSchema = this.branchSchemas.get(proposal.targetBranch);
    if (!targetSchema) {
      return Effect.fail(
        new BranchNotFoundError({ branchName: proposal.targetBranch })
      );
    }

    // Apply changeSet to target branch
    for (const ot of proposal.changeSet.addedObjectTypes) {
      targetSchema.objectTypes.set(ot.id, ot);
    }
    for (const ot of proposal.changeSet.modifiedObjectTypes) {
      targetSchema.objectTypes.set(ot.id, ot);
    }
    for (const id of proposal.changeSet.deletedObjectTypeIds) {
      targetSchema.objectTypes.delete(id);
    }

    for (const lt of proposal.changeSet.addedLinkTypes) {
      targetSchema.linkTypes.set(lt.id, lt);
    }
    for (const lt of proposal.changeSet.modifiedLinkTypes) {
      targetSchema.linkTypes.set(lt.id, lt);
    }
    for (const id of proposal.changeSet.deletedLinkTypeIds) {
      targetSchema.linkTypes.delete(id);
    }

    for (const at of proposal.changeSet.addedActionTypes) {
      targetSchema.actionTypes.set(at.id, at);
    }
    for (const at of proposal.changeSet.modifiedActionTypes) {
      targetSchema.actionTypes.set(at.id, at);
    }
    for (const id of proposal.changeSet.deletedActionTypeIds) {
      targetSchema.actionTypes.delete(id);
    }

    const now = Date.now();
    const merged: OntologyProposal = {
      ...proposal,
      mergedAt: now,
      status: "merged",
      updatedAt: now,
    };
    this.proposals.set(proposalId, merged);

    return Effect.succeed(merged);
  }

  getProposal(
    proposalId: string
  ): Effect.Effect<OntologyProposal, ProposalNotFoundError> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return Effect.fail(
        new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found`,
          proposalId,
        })
      );
    }
    return Effect.succeed(proposal);
  }

  listProposals(): Effect.Effect<readonly OntologyProposal[]> {
    return Effect.succeed([...this.proposals.values()]);
  }
}
