import type {
  ActionType,
  ApprovalsPolicy,
  CandidateChangeSet,
  CandidateReceipt,
  DefinitionArtifact,
  DefinitionRelease,
  InterfaceType,
  LinkCardinality,
  LinkType,
  LinkTypeId,
  ObjectType,
  ObjectTypeId,
  OntologyBranch,
  OntologyProposal,
  ProposalChangeSet,
  ProposalReview,
  PublicationReceipt,
  RiskTier,
  Subject,
} from "@operon/schema";
import { canonicalJson, computeCanonicalDigest } from "@operon/schema";
import { Data, Effect } from "effect";

import type { AgentContext } from "./auth.js";
import {
  ArtifactSizeExceededError,
  AuthorizationError,
  CandidateNotFoundError,
  CompilationError,
  IdempotencyConflictError,
  ProposalNotFoundError,
  PublicationNotFoundError,
  ReleaseConflictError,
  SelfReviewDeniedError,
  StaleReviewError,
} from "./errors.js";

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

export interface CandidateDiff {
  readonly addedTypes: readonly string[];
  readonly modifiedTypes: readonly string[];
  readonly addedLinks: readonly string[];
  readonly addedActions: readonly string[];
  readonly addedQueries: readonly string[];
}

export interface ContextOptions {
  readonly agentContext?: AgentContext;
  readonly expectedTenantId?: string;
  readonly expectedEnvironmentId?: string;
}

/**
 * Maximum artifact size boundary (10MB) per V0-CH-02 open fork decision
 */
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/**
 * OMS (Ontology Metadata Service)
 * Authoritative registry of ontology definitions, branching, proposal lifecycles,
 * and immutable DefinitionReleases.
 */
export class OntologyMetadataService {
  private readonly branches = new Map<string, OntologyBranch>();
  private readonly branchSchemas = new Map<string, BranchSchemaDelta>();
  private readonly proposals = new Map<string, OntologyProposal>();

  // Candidates, Receipts, and Idempotency Registries (V0-CH-02 / V0-CH-03)
  private readonly candidates = new Map<string, CandidateChangeSet>();
  private readonly candidateReceipts = new Map<string, CandidateReceipt>();
  private readonly candidateIdempotency = new Map<
    string,
    { branch: string; digest: string; receipt: CandidateReceipt }
  >();

  private readonly publicationIdempotency = new Map<
    string,
    { candidateDigest: string; receipt: PublicationReceipt }
  >();
  private readonly publications = new Map<string, PublicationReceipt>();
  private activeRelease: DefinitionRelease | null = null;
  private readonly releasesHistory: DefinitionRelease[] = [];

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
      revision: 1,
    };
    this.branches.set("main", mainBranch);
    this.branchSchemas.set("main", {
      actionTypes: new Map(),
      interfaceTypes: new Map(),
      linkTypes: new Map(),
      objectTypes: new Map(),
    });
  }

  /**
   * Enforce tenant and environment non-disclosure.
   * If mismatched, fails with generic Access Denied without revealing resource existence.
   */
  private checkContext(
    context?: ContextOptions | AgentContext
  ): Effect.Effect<void, AuthorizationError> {
    if (!context) return Effect.void;
    const ctx: AgentContext | undefined =
      "actorId" in context ? context : context.agentContext;
    const expectedTenantId =
      "expectedTenantId" in context ? context.expectedTenantId : undefined;
    const expectedEnvironmentId =
      "expectedEnvironmentId" in context
        ? context.expectedEnvironmentId
        : undefined;

    if (!ctx) return Effect.void;
    if (
      (expectedTenantId && ctx.tenantId !== expectedTenantId) ||
      (expectedEnvironmentId && ctx.environmentId !== expectedEnvironmentId)
    ) {
      return Effect.fail(new AuthorizationError({ reason: "Access denied" }));
    }
    return Effect.void;
  }

  // Branch Management
  createBranch(
    name: string,
    author: Subject,
    parentBranchId = "main",
    context?: ContextOptions | AgentContext
  ): Effect.Effect<OntologyBranch, BranchNotFoundError | AuthorizationError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);

      const parentSchema = this.branchSchemas.get(parentBranchId);
      const parentBranch = this.branches.get(parentBranchId);
      if (!parentSchema || !parentBranch) {
        return yield* Effect.fail(
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
        revision: parentBranch.revision ?? 1,
      };

      this.branches.set(name, branch);
      this.branchSchemas.set(name, {
        actionTypes: new Map(parentSchema.actionTypes),
        interfaceTypes: new Map(parentSchema.interfaceTypes),
        linkTypes: new Map(parentSchema.linkTypes),
        objectTypes: new Map(parentSchema.objectTypes),
      });

      return branch;
    });
  }

  getBranch(
    name: string,
    context?: ContextOptions | AgentContext
  ): Effect.Effect<OntologyBranch, BranchNotFoundError | AuthorizationError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      const branch = this.branches.get(name);
      if (!branch) {
        return yield* Effect.fail(
          new BranchNotFoundError({ branchName: name })
        );
      }
      return branch;
    });
  }

  listBranches(
    context?: ContextOptions | AgentContext
  ): Effect.Effect<readonly OntologyBranch[], AuthorizationError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      return [...this.branches.values()];
    });
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
    branchName = "main",
    context?: ContextOptions | AgentContext
  ): Effect.Effect<
    BranchSchemaDelta,
    BranchNotFoundError | AuthorizationError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      const schema = this.branchSchemas.get(branchName);
      if (!schema) {
        return yield* Effect.fail(new BranchNotFoundError({ branchName }));
      }
      return schema;
    });
  }

  // V0-CH-02: Apply Definition Artifact atomically to a branch
  applyArtifact(options: {
    readonly branch: string;
    readonly artifact: DefinitionArtifact;
    readonly expectedRevision?: number;
    readonly idempotencyKey?: string;
    readonly agentContext?: AgentContext;
    readonly expectedTenantId?: string;
    readonly expectedEnvironmentId?: string;
    readonly crashInject?: boolean;
  }): Effect.Effect<
    CandidateReceipt,
    | BranchNotFoundError
    | AuthorizationError
    | ArtifactSizeExceededError
    | IdempotencyConflictError
    | CompilationError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext({
        agentContext: options.agentContext,
        expectedEnvironmentId: options.expectedEnvironmentId,
        expectedTenantId: options.expectedTenantId,
      });

      // Check max artifact size
      const canonicalStr = canonicalJson(options.artifact);
      const actualBytes = Buffer.byteLength(canonicalStr, "utf-8");
      if (actualBytes > MAX_ARTIFACT_BYTES) {
        return yield* Effect.fail(
          new ArtifactSizeExceededError({
            actualBytes,
            maxAllowedBytes: MAX_ARTIFACT_BYTES,
          })
        );
      }

      // Check branch existence
      const branch = this.branches.get(options.branch);
      if (!branch) {
        return yield* Effect.fail(
          new BranchNotFoundError({ branchName: options.branch })
        );
      }

      const candidateDigest = computeCanonicalDigest(options.artifact);

      // Idempotency check
      if (options.idempotencyKey) {
        const existing = this.candidateIdempotency.get(options.idempotencyKey);
        if (existing) {
          if (
            existing.branch !== options.branch ||
            existing.digest !== candidateDigest
          ) {
            return yield* Effect.fail(
              new IdempotencyConflictError({
                idempotencyKey: options.idempotencyKey,
                message: `Idempotency key '${options.idempotencyKey}' was previously submitted with different branch or artifact`,
              })
            );
          }
          return existing.receipt;
        }
      }

      // Check revision consistency
      if (
        options.expectedRevision !== undefined &&
        branch.revision !== undefined &&
        branch.revision !== options.expectedRevision
      ) {
        return yield* Effect.fail(
          new CompilationError({
            errors: [
              `Expected branch revision ${options.expectedRevision}, but found ${branch.revision}`,
            ],
            message: "Branch revision mismatch (concurrent modification)",
          })
        );
      }

      // Compilation & semantic validation
      const errors: string[] = [];
      const declaredTypeIds = new Set(options.artifact.types.map((t) => t.id));
      const branchSchema = this.branchSchemas.get(options.branch)!;

      // Validate types: primaryKey must exist in properties
      for (const t of options.artifact.types) {
        if (!t.properties[t.primaryKey]) {
          errors.push(
            `TypeDef '${t.id}' specifies primaryKey '${t.primaryKey}' which is missing in declared properties.`
          );
        }
      }

      // Validate links: sourceTypeId and targetTypeId must exist in artifact or branch
      for (const l of options.artifact.links) {
        const sourceExists =
          declaredTypeIds.has(l.sourceTypeId) ||
          branchSchema.objectTypes.has(l.sourceTypeId);
        const targetExists =
          declaredTypeIds.has(l.targetTypeId) ||
          branchSchema.objectTypes.has(l.targetTypeId);

        if (!sourceExists) {
          errors.push(
            `LinkDef '${l.id}' references undefined sourceTypeId '${l.sourceTypeId}'.`
          );
        }
        if (!targetExists) {
          errors.push(
            `LinkDef '${l.id}' references undefined targetTypeId '${l.targetTypeId}'.`
          );
        }
      }

      // Validate queries: returnTypeId must exist
      for (const q of options.artifact.queries) {
        const returnTypeExists =
          declaredTypeIds.has(q.returnTypeId) ||
          branchSchema.objectTypes.has(q.returnTypeId);
        if (!returnTypeExists) {
          errors.push(
            `QueryDef '${q.id}' references undefined returnTypeId '${q.returnTypeId}'.`
          );
        }
      }

      // Validate actions: declared effect class
      for (const a of options.artifact.actions) {
        if (
          a.effectClass !== "read_only" &&
          a.effectClass !== "state_mutation" &&
          a.effectClass !== "external_side_effect"
        ) {
          errors.push(
            `ActionDef '${a.id}' has invalid or unsafe effectClass '${a.effectClass}'.`
          );
        }
      }

      // Validate freshness: typeId and propertyName must exist
      for (const f of options.artifact.freshness) {
        const typeDef =
          options.artifact.types.find((t) => t.id === f.typeId) ??
          branchSchema.objectTypes.get(f.typeId);
        if (typeDef) {
          const hasProp =
            "properties" in typeDef &&
            Boolean(
              (typeDef.properties as Record<string, unknown>)[f.propertyName]
            );
          if (!hasProp) {
            errors.push(
              `FreshnessDef references undefined property '${f.propertyName}' on type '${f.typeId}'.`
            );
          }
        } else {
          errors.push(
            `FreshnessDef references undefined typeId '${f.typeId}'.`
          );
        }
      }

      if (errors.length > 0) {
        return yield* Effect.fail(
          new CompilationError({
            errors,
            message: `Artifact validation failed with ${errors.length} error(s)`,
          })
        );
      }

      // Crash injection test: fail before any state mutation occurs
      if (options.crashInject) {
        return yield* Effect.fail(
          new CompilationError({
            errors: ["CRASH_INJECTION_TRIGGERED"],
            message: "Simulated crash fault injected before state mutation",
          })
        );
      }

      // Atomically commit schema changes to branch
      const nextRevision = (branch.revision ?? 1) + 1;
      this.branches.set(options.branch, {
        ...branch,
        revision: nextRevision,
      });

      const cardinalityMap: Record<"1:1" | "1:N" | "N:N", LinkCardinality> = {
        "1:1": "one-to-one",
        "1:N": "one-to-many",
        "N:N": "many-to-many",
      };

      const riskTierMap: Record<
        "low" | "moderate" | "high" | "critical",
        RiskTier
      > = {
        critical: "critical",
        high: "high",
        low: "low",
        moderate: "medium",
      };

      for (const t of options.artifact.types) {
        branchSchema.objectTypes.set(t.id, {
          description: t.description ?? t.name,
          id: t.id as ObjectTypeId,
          name: t.name,
          primaryKey: t.primaryKey,
          properties: t.properties as any,
          typology: (t.typology ?? "master") as any,
        });
      }

      for (const l of options.artifact.links) {
        branchSchema.linkTypes.set(l.id, {
          cardinality: cardinalityMap[l.cardinality],
          description: l.name,
          id: l.id as LinkTypeId,
          sourceToTargetName: l.name,
          sourceTypeId: l.sourceTypeId as ObjectTypeId,
          targetToSourceName: `${l.name}Inverse`,
          targetTypeId: l.targetTypeId as ObjectTypeId,
        });
      }

      for (const a of options.artifact.actions) {
        branchSchema.actionTypes.set(a.id, {
          defaultExecutionMode: "automated",
          description: a.description ?? a.name,
          id: a.id as any,
          minimumAgentTier: 4,
          name: a.name,
          parametersSchema: a.parametersSchema as any,
          riskTier: riskTierMap[a.riskTier],
          submissionCriteria: [],
        });
      }

      const changeSet: CandidateChangeSet = {
        artifact: options.artifact,
        canonicalDigest: candidateDigest,
        compiledAt: Date.now(),
        revision: nextRevision,
      };

      const receipt: CandidateReceipt = {
        appliedAt: Date.now(),
        branch: options.branch,
        candidateDigest,
        changeSet,
        idempotencyKey: options.idempotencyKey,
        revision: nextRevision,
        status: "applied",
      };

      this.candidates.set(candidateDigest, changeSet);
      this.candidateReceipts.set(candidateDigest, receipt);

      if (options.idempotencyKey) {
        this.candidateIdempotency.set(options.idempotencyKey, {
          branch: options.branch,
          digest: candidateDigest,
          receipt,
        });
      }

      return receipt;
    });
  }

  // Inspect and Diff Candidate
  inspectCandidate(
    candidateDigest: string,
    context?: ContextOptions | AgentContext
  ): Effect.Effect<
    CandidateChangeSet,
    CandidateNotFoundError | AuthorizationError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      const candidate = this.candidates.get(candidateDigest);
      if (!candidate) {
        return yield* Effect.fail(
          new CandidateNotFoundError({
            candidateDigest,
            message: `Candidate with digest '${candidateDigest}' was not found`,
          })
        );
      }
      return candidate;
    });
  }

  diffCandidate(
    candidateDigest: string,
    context?: ContextOptions | AgentContext
  ): Effect.Effect<CandidateDiff, CandidateNotFoundError | AuthorizationError> {
    return Effect.gen({ self: this }, function* () {
      const candidate = yield* this.inspectCandidate(candidateDigest, context);
      const activeArtifact = this.activeRelease
        ? this.candidates.get(this.activeRelease.candidateDigest)?.artifact
        : undefined;

      const baseTypeIds = new Set(
        activeArtifact ? activeArtifact.types.map((t) => t.id) : []
      );
      const baseLinkIds = new Set(
        activeArtifact ? activeArtifact.links.map((l) => l.id) : []
      );
      const baseActionIds = new Set(
        activeArtifact ? activeArtifact.actions.map((a) => a.id) : []
      );

      const addedTypes = candidate.artifact.types
        .filter((t) => !baseTypeIds.has(t.id))
        .map((t) => t.id);

      const modifiedTypes = candidate.artifact.types
        .filter((t) => baseTypeIds.has(t.id))
        .map((t) => t.id);

      const addedLinks = candidate.artifact.links
        .filter((l) => !baseLinkIds.has(l.id))
        .map((l) => l.id);

      const addedActions = candidate.artifact.actions
        .filter((a) => !baseActionIds.has(a.id))
        .map((a) => a.id);

      const addedQueries = candidate.artifact.queries.map((q) => q.id);

      return {
        addedActions,
        addedLinks,
        addedQueries,
        addedTypes,
        modifiedTypes,
      };
    });
  }

  // V0-CH-03: Proposal and Review lifecycle
  createProposal(args: {
    readonly title: string;
    readonly description: string;
    readonly sourceBranch: string;
    readonly targetBranch?: string;
    readonly author: Subject;
    readonly changeSet: ProposalChangeSet;
    readonly candidateDigest?: string;
    readonly agentContext?: AgentContext;
    readonly expectedTenantId?: string;
    readonly expectedEnvironmentId?: string;
  }): Effect.Effect<
    OntologyProposal,
    BranchNotFoundError | AuthorizationError | CandidateNotFoundError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext({
        agentContext: args.agentContext,
        expectedEnvironmentId: args.expectedEnvironmentId,
        expectedTenantId: args.expectedTenantId,
      });

      const targetBranch = args.targetBranch ?? "main";
      if (!this.branches.has(args.sourceBranch)) {
        return yield* Effect.fail(
          new BranchNotFoundError({ branchName: args.sourceBranch })
        );
      }
      if (!this.branches.has(targetBranch)) {
        return yield* Effect.fail(
          new BranchNotFoundError({ branchName: targetBranch })
        );
      }

      if (args.candidateDigest && !this.candidates.has(args.candidateDigest)) {
        return yield* Effect.fail(
          new CandidateNotFoundError({
            candidateDigest: args.candidateDigest,
            message: `Candidate '${args.candidateDigest}' does not exist`,
          })
        );
      }

      const now = Date.now();
      const proposal: OntologyProposal & { candidateDigest?: string } = {
        author: args.author,
        candidateDigest: args.candidateDigest,
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
      return proposal;
    });
  }

  reviewProposal(
    proposalId: string,
    review: ProposalReview,
    options?: {
      readonly expectedCandidateDigest?: string;
      readonly agentContext?: AgentContext;
      readonly expectedTenantId?: string;
      readonly expectedEnvironmentId?: string;
    }
  ): Effect.Effect<
    OntologyProposal,
    | ProposalNotFoundError
    | AuthorizationError
    | SelfReviewDeniedError
    | StaleReviewError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext({
        agentContext: options?.agentContext,
        expectedEnvironmentId: options?.expectedEnvironmentId,
        expectedTenantId: options?.expectedTenantId,
      });

      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        return yield* Effect.fail(
          new ProposalNotFoundError({
            message: `Proposal '${proposalId}' not found`,
            proposalId,
          })
        );
      }

      // Deny self-approval: author cannot review their own proposal
      if (review.reviewer.id === proposal.author.id) {
        return yield* Effect.fail(
          new SelfReviewDeniedError({
            authorId: proposal.author.id,
            message: `Author '${proposal.author.id}' cannot self-review or self-approve proposal '${proposalId}'`,
            reviewerId: review.reviewer.id,
          })
        );
      }

      // Stale review check
      const propCandidateDigest = (proposal as any).candidateDigest;
      if (
        options?.expectedCandidateDigest &&
        propCandidateDigest &&
        propCandidateDigest !== options.expectedCandidateDigest
      ) {
        return yield* Effect.fail(
          new StaleReviewError({
            candidateDigest: propCandidateDigest,
            message: `Review references stale candidate digest '${options.expectedCandidateDigest}', current proposal candidate is '${propCandidateDigest}'`,
            proposalId,
            reviewDigest: options.expectedCandidateDigest,
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
      return updated;
    });
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

  // V0-CH-03: Publication of immutable DefinitionRelease
  publishRelease(options: {
    readonly candidateDigest: string;
    readonly expectedCurrentRelease: {
      readonly kind: "none" | "release";
      readonly digest?: string;
    };
    readonly reviewRefs: readonly string[];
    readonly publisher: Subject;
    readonly idempotencyKey?: string;
    readonly agentContext?: AgentContext;
    readonly expectedTenantId?: string;
    readonly expectedEnvironmentId?: string;
  }): Effect.Effect<
    PublicationReceipt,
    | AuthorizationError
    | IdempotencyConflictError
    | CandidateNotFoundError
    | ReleaseConflictError
    | ApprovalsPolicyViolationError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext({
        agentContext: options.agentContext,
        expectedEnvironmentId: options.expectedEnvironmentId,
        expectedTenantId: options.expectedTenantId,
      });

      // Idempotency check
      if (options.idempotencyKey) {
        const existing = this.publicationIdempotency.get(
          options.idempotencyKey
        );
        if (existing) {
          if (existing.candidateDigest !== options.candidateDigest) {
            return yield* Effect.fail(
              new IdempotencyConflictError({
                idempotencyKey: options.idempotencyKey,
                message: `Idempotency key '${options.idempotencyKey}' was previously submitted for candidate '${existing.candidateDigest}', not '${options.candidateDigest}'`,
              })
            );
          }
          return existing.receipt;
        }
      }

      // Candidate must exist
      const candidate = this.candidates.get(options.candidateDigest);
      if (!candidate) {
        return yield* Effect.fail(
          new CandidateNotFoundError({
            candidateDigest: options.candidateDigest,
            message: `Candidate digest '${options.candidateDigest}' not found`,
          })
        );
      }

      // Check expected current release (CAS / concurrency check)
      if (options.expectedCurrentRelease.kind === "none") {
        if (this.activeRelease !== null) {
          return yield* Effect.fail(
            new ReleaseConflictError({
              actualDigest: this.activeRelease.canonicalDigest,
              expectedDigest: undefined,
              message:
                "Expected no active release (initial publication), but an active release already exists",
            })
          );
        }
      } else {
        if (this.activeRelease === null) {
          return yield* Effect.fail(
            new ReleaseConflictError({
              actualDigest: undefined,
              expectedDigest: options.expectedCurrentRelease.digest,
              message:
                "Expected existing release, but no release is currently active",
            })
          );
        }
        if (
          options.expectedCurrentRelease.digest &&
          this.activeRelease.canonicalDigest !==
            options.expectedCurrentRelease.digest
        ) {
          return yield* Effect.fail(
            new ReleaseConflictError({
              actualDigest: this.activeRelease.canonicalDigest,
              expectedDigest: options.expectedCurrentRelease.digest,
              message: `Active release digest '${this.activeRelease.canonicalDigest}' does not match expected digest '${options.expectedCurrentRelease.digest}'`,
            })
          );
        }
      }

      // Verify review obligations
      if (options.reviewRefs.length === 0) {
        return yield* Effect.fail(
          new ApprovalsPolicyViolationError({
            proposalId: "unknown",
            reason:
              "Publication requires at least one reviewed reference approval",
          })
        );
      }

      const nextRev = (this.activeRelease?.revision ?? 0) + 1;
      const release: DefinitionRelease = {
        candidateDigest: options.candidateDigest,
        canonicalDigest: candidate.canonicalDigest,
        declaredEffects: candidate.artifact.actions.map((a) => a.effectClass),
        dependencies: [],
        publishedAt: Date.now(),
        publishedBy: options.publisher,
        releaseId: `rel_${Date.now()}_${options.candidateDigest.slice(0, 8)}`,
        reviewRefs: options.reviewRefs,
        revision: nextRev,
        schemaVersion: "1.0.0",
        status: "published",
        version: `${nextRev}.0.0`,
      };

      this.activeRelease = release;
      this.releasesHistory.push(release);

      const pubReceipt: PublicationReceipt = {
        idempotencyKey: options.idempotencyKey,
        publicationId: `pub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        publishedAt: Date.now(),
        release,
        status: "published",
      };

      this.publications.set(pubReceipt.publicationId, pubReceipt);

      if (options.idempotencyKey) {
        this.publicationIdempotency.set(options.idempotencyKey, {
          candidateDigest: options.candidateDigest,
          receipt: pubReceipt,
        });
      }

      return pubReceipt;
    });
  }

  // Lost response recovery by publicationId or idempotencyKey
  getPublication(options: {
    readonly publicationId?: string;
    readonly idempotencyKey?: string;
    readonly agentContext?: AgentContext;
    readonly expectedTenantId?: string;
    readonly expectedEnvironmentId?: string;
  }): Effect.Effect<
    PublicationReceipt,
    PublicationNotFoundError | AuthorizationError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext({
        agentContext: options.agentContext,
        expectedEnvironmentId: options.expectedEnvironmentId,
        expectedTenantId: options.expectedTenantId,
      });

      if (options.idempotencyKey) {
        const cached = this.publicationIdempotency.get(options.idempotencyKey);
        if (cached) {
          return cached.receipt;
        }
      }

      if (options.publicationId) {
        const pub = this.publications.get(options.publicationId);
        if (pub) {
          return pub;
        }
      }

      return yield* Effect.fail(
        new PublicationNotFoundError({
          identifier:
            options.publicationId ?? options.idempotencyKey ?? "unknown",
          message:
            "Publication not found for given identifier or idempotency key",
        })
      );
    });
  }

  getActiveRelease(
    context?: ContextOptions | AgentContext
  ): Effect.Effect<DefinitionRelease | null, AuthorizationError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      return this.activeRelease;
    });
  }

  getProposal(
    proposalId: string,
    context?: ContextOptions | AgentContext
  ): Effect.Effect<
    OntologyProposal,
    ProposalNotFoundError | AuthorizationError
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        return yield* Effect.fail(
          new ProposalNotFoundError({
            message: `Proposal ${proposalId} not found`,
            proposalId,
          })
        );
      }
      return proposal;
    });
  }

  listProposals(
    context?: ContextOptions | AgentContext
  ): Effect.Effect<readonly OntologyProposal[], AuthorizationError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.checkContext(context);
      return [...this.proposals.values()];
    });
  }

  exportSnapshot(): Record<string, unknown> {
    return {
      activeRelease: this.activeRelease,
      branches: [...this.branches.entries()],
      branchSchemas: [...this.branchSchemas.entries()].map(([k, v]) => [
        k,
        {
          actionTypes: [...v.actionTypes.entries()],
          interfaceTypes: [...v.interfaceTypes.entries()],
          linkTypes: [...v.linkTypes.entries()],
          objectTypes: [...v.objectTypes.entries()],
        },
      ]),
      candidateIdempotency: [...this.candidateIdempotency.entries()],
      candidateReceipts: [...this.candidateReceipts.entries()],
      candidates: [...this.candidates.entries()],
      proposals: [...this.proposals.entries()],
      publicationIdempotency: [...this.publicationIdempotency.entries()],
      publications: [...this.publications.entries()],
      releasesHistory: this.releasesHistory,
    };
  }

  importSnapshot(data: any): void {
    if (!data || typeof data !== "object") return;
    if (Array.isArray(data.branches)) {
      this.branches.clear();
      for (const [k, v] of data.branches) this.branches.set(k, v);
    }
    if (Array.isArray(data.branchSchemas)) {
      this.branchSchemas.clear();
      for (const [k, v] of data.branchSchemas) {
        this.branchSchemas.set(k, {
          actionTypes: new Map(v.actionTypes),
          interfaceTypes: new Map(v.interfaceTypes),
          linkTypes: new Map(v.linkTypes),
          objectTypes: new Map(v.objectTypes),
        });
      }
    }
    if (Array.isArray(data.proposals)) {
      this.proposals.clear();
      for (const [k, v] of data.proposals) this.proposals.set(k, v);
    }
    if (Array.isArray(data.candidates)) {
      this.candidates.clear();
      for (const [k, v] of data.candidates) this.candidates.set(k, v);
    }
    if (Array.isArray(data.candidateReceipts)) {
      this.candidateReceipts.clear();
      for (const [k, v] of data.candidateReceipts)
        this.candidateReceipts.set(k, v);
    }
    if (Array.isArray(data.candidateIdempotency)) {
      this.candidateIdempotency.clear();
      for (const [k, v] of data.candidateIdempotency)
        this.candidateIdempotency.set(k, v);
    }
    if (Array.isArray(data.publicationIdempotency)) {
      this.publicationIdempotency.clear();
      for (const [k, v] of data.publicationIdempotency)
        this.publicationIdempotency.set(k, v);
    }
    if (Array.isArray(data.publications)) {
      this.publications.clear();
      for (const [k, v] of data.publications) this.publications.set(k, v);
    }
    if (data.activeRelease !== undefined) {
      this.activeRelease = data.activeRelease;
    }
    if (Array.isArray(data.releasesHistory)) {
      this.releasesHistory.length = 0;
      this.releasesHistory.push(...data.releasesHistory);
    }
  }
}
