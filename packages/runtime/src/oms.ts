import type {
  ActionDef,
  ActionParameters,
  ActionType,
  ActionTypeId,
  ApprovalsPolicy,
  CandidateChangeSet,
  CandidateReceipt,
  DefinitionArtifact,
  DefinitionRelease,
  FreshnessDef,
  InterfaceType,
  LinkCardinality,
  LinkDef,
  LinkType,
  LinkTypeId,
  ObjectType,
  ObjectTypeId,
  OntologyBranch,
  OntologyProposal,
  PropertyDefinition,
  ProposalChangeSet,
  ProposalReview,
  PublicationReceipt,
  QueryDef,
  RiskTier,
  Subject,
  TypeDef,
} from "@operon/schema";
import {
  canonicalJson,
  computeCanonicalDigest,
  generatePrefixedId,
} from "@operon/schema";
import { Clock, Data, Effect, Schema } from "effect";

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
  readonly actionTypes: Map<string, ActionType<ActionParameters>>;
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

const defaultApprovalsPolicy: ApprovalsPolicy = {
  requireComplianceReview: false,
  requireDomainSpecialistReview: false,
  requiredMinApprovals: 1,
};

const cardinalityMap: Record<"1:1" | "1:N" | "N:N", LinkCardinality> = {
  "1:1": "one-to-one",
  "1:N": "one-to-many",
  "N:N": "many-to-many",
};

const riskTierMap: Record<"low" | "moderate" | "high" | "critical", RiskTier> =
  {
    critical: "critical",
    high: "high",
    low: "low",
    moderate: "medium",
  };

function validateCandidateTypes(
  types: readonly TypeDef[],
  errors: string[]
): void {
  for (const t of types) {
    if (!t.properties[t.primaryKey]) {
      errors.push(
        `TypeDef '${t.id}' specifies primaryKey '${t.primaryKey}' which is missing in declared properties.`
      );
    }
  }
}

function validateCandidateLinks(
  links: readonly LinkDef[],
  declaredTypeIds: ReadonlySet<string>,
  branchSchema: BranchSchemaDelta,
  errors: string[]
): void {
  for (const l of links) {
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
}

function validateCandidateQueries(
  queries: readonly QueryDef[],
  declaredTypeIds: ReadonlySet<string>,
  branchSchema: BranchSchemaDelta,
  errors: string[]
): void {
  for (const q of queries) {
    const returnTypeExists =
      declaredTypeIds.has(q.returnTypeId) ||
      branchSchema.objectTypes.has(q.returnTypeId);
    if (!returnTypeExists) {
      errors.push(
        `QueryDef '${q.id}' references undefined returnTypeId '${q.returnTypeId}'.`
      );
    }
  }
}

function validateCandidateActions(
  actions: readonly ActionDef[],
  errors: string[]
): void {
  for (const a of actions) {
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
}

function validateCandidateFreshness(
  freshness: readonly FreshnessDef[],
  types: readonly TypeDef[],
  branchSchema: BranchSchemaDelta,
  errors: string[]
): void {
  for (const f of freshness) {
    const typeDef =
      types.find((t) => t.id === f.typeId) ??
      branchSchema.objectTypes.get(f.typeId);
    if (!typeDef) {
      errors.push(`FreshnessDef references undefined typeId '${f.typeId}'.`);
      continue;
    }
    const hasProp =
      "properties" in typeDef &&
      Boolean((typeDef.properties as Record<string, unknown>)[f.propertyName]);
    if (!hasProp) {
      errors.push(
        `FreshnessDef references undefined property '${f.propertyName}' on type '${f.typeId}'.`
      );
    }
  }
}

function validateCandidateArtifact(
  artifact: DefinitionArtifact,
  branchSchema: BranchSchemaDelta
): readonly string[] {
  const errors: string[] = [];
  const declaredTypeIds = new Set(artifact.types.map((t) => t.id));

  validateCandidateTypes(artifact.types, errors);
  validateCandidateLinks(artifact.links, declaredTypeIds, branchSchema, errors);
  validateCandidateQueries(
    artifact.queries,
    declaredTypeIds,
    branchSchema,
    errors
  );
  validateCandidateActions(artifact.actions, errors);
  validateCandidateFreshness(
    artifact.freshness,
    artifact.types,
    branchSchema,
    errors
  );

  return errors;
}

function applyArtifactToBranchSchema(
  artifact: DefinitionArtifact,
  branchSchema: BranchSchemaDelta
): void {
  for (const t of artifact.types) {
    const properties: Record<string, PropertyDefinition<unknown>> = {};
    for (const [key, p] of Object.entries(t.properties)) {
      properties[key] = {
        description: p.description ?? p.name,
        required: p.required ?? false,
        schema: Schema.Unknown,
      };
    }
    branchSchema.objectTypes.set(t.id, {
      description: t.description ?? t.name,
      id: t.id as ObjectTypeId,
      name: t.name,
      primaryKey: t.primaryKey,
      properties,
      typology: (t.typology ?? "master") as ObjectType["typology"],
    });
  }

  for (const l of artifact.links) {
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

  for (const a of artifact.actions) {
    branchSchema.actionTypes.set(a.id, {
      defaultExecutionMode: "automated",
      description: a.description ?? a.name,
      id: a.id as ActionTypeId,
      minimumAgentTier: 4,
      name: a.name,
      parametersSchema: Schema.Record(Schema.String, Schema.Json),
      riskTier: riskTierMap[a.riskTier],
      submissionCriteria: [],
    });
  }
}

function validateArtifactPreconditions(options: {
  readonly artifact: DefinitionArtifact;
  readonly branch: OntologyBranch;
  readonly expectedRevision?: number;
  readonly crashInject?: boolean;
}): Effect.Effect<void, ArtifactSizeExceededError | CompilationError> {
  const canonicalStr = canonicalJson(options.artifact);
  const actualBytes = Buffer.byteLength(canonicalStr, "utf-8");
  if (actualBytes > MAX_ARTIFACT_BYTES) {
    return new ArtifactSizeExceededError({
      actualBytes,
      maxAllowedBytes: MAX_ARTIFACT_BYTES,
    });
  }
  if (
    options.expectedRevision !== undefined &&
    options.branch.revision !== undefined &&
    options.branch.revision !== options.expectedRevision
  ) {
    return new CompilationError({
      errors: [
        `Expected branch revision ${options.expectedRevision}, but found ${options.branch.revision}`,
      ],
      message: "Branch revision mismatch (concurrent modification)",
    });
  }
  if (options.crashInject) {
    return new CompilationError({
      errors: ["CRASH_INJECTION_TRIGGERED"],
      message: "Simulated crash fault injected before state mutation",
    });
  }
  return Effect.void;
}

function checkCandidateIdempotency(
  existing:
    | {
        readonly branch: string;
        readonly digest: string;
        readonly receipt: CandidateReceipt;
      }
    | undefined,
  branch: string,
  candidateDigest: string,
  idempotencyKey: string
): Effect.Effect<CandidateReceipt | undefined, IdempotencyConflictError> {
  if (!existing) {
    return Effect.void as Effect.Effect<undefined>;
  }
  if (existing.branch !== branch || existing.digest !== candidateDigest) {
    return new IdempotencyConflictError({
      idempotencyKey,
      message: `Idempotency key '${idempotencyKey}' was previously submitted with different branch or artifact`,
    });
  }
  return Effect.succeed(existing.receipt);
}

function validateCandidateArtifactOrError(
  artifact: DefinitionArtifact,
  branchSchema: BranchSchemaDelta
): Effect.Effect<void, CompilationError> {
  const errors = validateCandidateArtifact(artifact, branchSchema);
  if (errors.length > 0) {
    return new CompilationError({
      errors: [...errors],
      message: `Artifact validation failed with ${errors.length} error(s)`,
    });
  }
  return Effect.void;
}

function validateProposalApprovals(
  proposal: OntologyProposal,
  policy: ApprovalsPolicy
): Effect.Effect<void, ApprovalsPolicyViolationError> {
  if (
    proposal.status === "rejected" ||
    proposal.reviews.some((r) => r.verdict === "reject")
  ) {
    return new ApprovalsPolicyViolationError({
      proposalId: proposal.id,
      reason: "Proposal has been rejected and cannot be merged",
    });
  }

  const approvals = proposal.reviews.filter((r) => r.verdict === "approve");
  if (approvals.length < policy.requiredMinApprovals) {
    return new ApprovalsPolicyViolationError({
      proposalId: proposal.id,
      reason: `Requires at least ${policy.requiredMinApprovals} approvals; found ${approvals.length}`,
    });
  }

  if (policy.requireComplianceReview) {
    const complianceApproved = approvals.some((a) =>
      a.reviewer.roles.includes("compliance_officer")
    );
    if (!complianceApproved) {
      return new ApprovalsPolicyViolationError({
        proposalId: proposal.id,
        reason: "Requires sign-off from a compliance officer",
      });
    }
  }

  if (policy.requireDomainSpecialistReview) {
    const specialistApproved = approvals.some(
      (a) =>
        a.reviewer.roles.includes("specialist") ||
        a.reviewer.roles.includes("domain_specialist")
    );
    if (!specialistApproved) {
      return new ApprovalsPolicyViolationError({
        proposalId: proposal.id,
        reason: "Requires sign-off from a domain specialist",
      });
    }
  }

  return Effect.void;
}

function applyProposalChangesToSchema(
  targetSchema: BranchSchemaDelta,
  changeSet: ProposalChangeSet
): void {
  for (const ot of changeSet.addedObjectTypes) {
    targetSchema.objectTypes.set(ot.id, ot);
  }
  for (const ot of changeSet.modifiedObjectTypes) {
    targetSchema.objectTypes.set(ot.id, ot);
  }
  for (const id of changeSet.deletedObjectTypeIds) {
    targetSchema.objectTypes.delete(id);
  }

  for (const lt of changeSet.addedLinkTypes) {
    targetSchema.linkTypes.set(lt.id, lt);
  }
  for (const lt of changeSet.modifiedLinkTypes) {
    targetSchema.linkTypes.set(lt.id, lt);
  }
  for (const id of changeSet.deletedLinkTypeIds) {
    targetSchema.linkTypes.delete(id);
  }

  for (const at of changeSet.addedActionTypes) {
    targetSchema.actionTypes.set(at.id, at);
  }
  for (const at of changeSet.modifiedActionTypes) {
    targetSchema.actionTypes.set(at.id, at);
  }
  for (const id of changeSet.deletedActionTypeIds) {
    targetSchema.actionTypes.delete(id);
  }
}

function validateExpectedReleaseCas(
  activeRelease: DefinitionRelease | null,
  expected: {
    readonly digest?: string;
    readonly kind: "none" | "digest" | "release";
  }
): Effect.Effect<void, ReleaseConflictError> {
  if (expected.kind === "none") {
    if (activeRelease !== null) {
      return new ReleaseConflictError({
        actualDigest: activeRelease.canonicalDigest,
        expectedDigest: undefined,
        message:
          "Expected no active release (initial publication), but an active release already exists",
      });
    }
    return Effect.void;
  }
  if (activeRelease === null) {
    return new ReleaseConflictError({
      actualDigest: undefined,
      expectedDigest: expected.digest,
      message: "Expected existing release, but no release is currently active",
    });
  }
  if (expected.digest && activeRelease.canonicalDigest !== expected.digest) {
    return new ReleaseConflictError({
      actualDigest: activeRelease.canonicalDigest,
      expectedDigest: expected.digest,
      message: `Active release digest '${activeRelease.canonicalDigest}' does not match expected digest '${expected.digest}'`,
    });
  }
  return Effect.void;
}

function populateMap<K, V>(map: Map<K, V>, source: unknown): void {
  if (Array.isArray(source)) {
    map.clear();
    for (const [k, v] of source as readonly [K, V][]) {
      map.set(k, v);
    }
  }
}

function populateBranchSchemas(
  map: Map<string, BranchSchemaDelta>,
  source: unknown
): void {
  if (!Array.isArray(source)) {
    return;
  }
  map.clear();
  for (const [k, v] of source as readonly [
    string,
    {
      readonly actionTypes: readonly [string, ActionType<ActionParameters>][];
      readonly interfaceTypes: readonly [string, InterfaceType][];
      readonly linkTypes: readonly [string, LinkType][];
      readonly objectTypes: readonly [string, ObjectType][];
    },
  ][]) {
    map.set(k, {
      actionTypes: new Map(v.actionTypes),
      interfaceTypes: new Map(v.interfaceTypes),
      linkTypes: new Map(v.linkTypes),
      objectTypes: new Map(v.objectTypes),
    });
  }
}

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
    if (!context) {
      return Effect.void;
    }
    const ctx: AgentContext | undefined =
      "actorId" in context ? context : context.agentContext;
    const expectedTenantId =
      "expectedTenantId" in context ? context.expectedTenantId : undefined;
    const expectedEnvironmentId =
      "expectedEnvironmentId" in context
        ? context.expectedEnvironmentId
        : undefined;

    if (!ctx) {
      return Effect.void;
    }
    if (
      (expectedTenantId && ctx.tenantId !== expectedTenantId) ||
      (expectedEnvironmentId && ctx.environmentId !== expectedEnvironmentId)
    ) {
      return new AuthorizationError({ reason: "Access denied" });
    }
    return Effect.void;
  }

  readonly createBranch = Effect.fn("OntologyMetadataService.createBranch")(
    function* (
      this: OntologyMetadataService,
      name: string,
      author: Subject,
      parentBranchId = "main",
      context?: ContextOptions | AgentContext
    ) {
      yield* this.checkContext(context);

      const parentSchema = this.branchSchemas.get(parentBranchId);
      const parentBranch = this.branches.get(parentBranchId);
      if (!parentSchema || !parentBranch) {
        return yield* new BranchNotFoundError({ branchName: parentBranchId });
      }

      const branch: OntologyBranch = {
        createdAt: yield* Clock.currentTimeMillis,
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
    }
  );

  readonly getBranch = Effect.fn("OntologyMetadataService.getBranch")(
    function* (
      this: OntologyMetadataService,
      name: string,
      context?: ContextOptions | AgentContext
    ) {
      yield* this.checkContext(context);
      const branch = this.branches.get(name);
      if (!branch) {
        return yield* new BranchNotFoundError({ branchName: name });
      }
      return branch;
    }
  );

  readonly listBranches = Effect.fn("OntologyMetadataService.listBranches")(
    function* (
      this: OntologyMetadataService,
      context?: ContextOptions | AgentContext
    ) {
      yield* this.checkContext(context);
      return [...this.branches.values()];
    }
  );

  // Schema Registration on Branch
  registerObjectType(
    branchName: string,
    objectType: ObjectType
  ): Effect.Effect<void, BranchNotFoundError> {
    const schema = this.branchSchemas.get(branchName);
    if (!schema) {
      return new BranchNotFoundError({ branchName });
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
      return new BranchNotFoundError({ branchName });
    }
    schema.linkTypes.set(linkType.id, linkType);
    return Effect.void;
  }

  registerActionType(
    branchName: string,
    actionType: ActionType<ActionParameters>
  ): Effect.Effect<void, BranchNotFoundError> {
    const schema = this.branchSchemas.get(branchName);
    if (!schema) {
      return new BranchNotFoundError({ branchName });
    }
    schema.actionTypes.set(actionType.id, actionType);
    return Effect.void;
  }

  readonly getSchema = Effect.fn("OntologyMetadataService.getSchema")(
    function* (
      this: OntologyMetadataService,
      branchName = "main",
      context?: ContextOptions | AgentContext
    ) {
      yield* this.checkContext(context);
      const schema = this.branchSchemas.get(branchName);
      if (!schema) {
        return yield* new BranchNotFoundError({ branchName });
      }
      return schema;
    }
  );

  // V0-CH-02: Apply Definition Artifact atomically to a branch
  readonly applyArtifact = Effect.fn("OntologyMetadataService.applyArtifact")(
    function* (
      this: OntologyMetadataService,
      options: {
        readonly branch: string;
        readonly artifact: DefinitionArtifact;
        readonly expectedRevision?: number;
        readonly idempotencyKey?: string;
        readonly agentContext?: AgentContext;
        readonly expectedTenantId?: string;
        readonly expectedEnvironmentId?: string;
        readonly crashInject?: boolean;
      }
    ) {
      yield* this.checkContext({
        agentContext: options.agentContext,
        expectedEnvironmentId: options.expectedEnvironmentId,
        expectedTenantId: options.expectedTenantId,
      });

      const branch = this.branches.get(options.branch);
      if (!branch) {
        return yield* new BranchNotFoundError({ branchName: options.branch });
      }

      const branchSchema = this.branchSchemas.get(options.branch);
      if (!branchSchema) {
        return yield* new BranchNotFoundError({ branchName: options.branch });
      }

      yield* validateArtifactPreconditions({
        artifact: options.artifact,
        branch,
        crashInject: options.crashInject,
        expectedRevision: options.expectedRevision,
      });

      const candidateDigest = computeCanonicalDigest(options.artifact);

      if (options.idempotencyKey) {
        const cached = yield* checkCandidateIdempotency(
          this.candidateIdempotency.get(options.idempotencyKey),
          options.branch,
          candidateDigest,
          options.idempotencyKey
        );
        if (cached) {
          return cached;
        }
      }

      yield* validateCandidateArtifactOrError(options.artifact, branchSchema);

      // Atomically commit schema changes to branch
      const nextRevision = (branch.revision ?? 1) + 1;
      this.branches.set(options.branch, {
        ...branch,
        revision: nextRevision,
      });

      applyArtifactToBranchSchema(options.artifact, branchSchema);

      const now = yield* Clock.currentTimeMillis;
      const changeSet: CandidateChangeSet = {
        artifact: options.artifact,
        canonicalDigest: candidateDigest,
        compiledAt: now,
        revision: nextRevision,
      };

      const receipt: CandidateReceipt = {
        appliedAt: now,
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
    }
  );

  // Inspect and Diff Candidate
  readonly inspectCandidate = Effect.fn(
    "OntologyMetadataService.inspectCandidate"
  )(function* (
    this: OntologyMetadataService,
    candidateDigest: string,
    context?: ContextOptions | AgentContext
  ) {
    yield* this.checkContext(context);
    const candidate = this.candidates.get(candidateDigest);
    if (!candidate) {
      return yield* new CandidateNotFoundError({
        candidateDigest,
        message: `Candidate with digest '${candidateDigest}' was not found`,
      });
    }
    return candidate;
  });

  readonly diffCandidate = Effect.fn("OntologyMetadataService.diffCandidate")(
    function* (
      this: OntologyMetadataService,
      candidateDigest: string,
      context?: ContextOptions | AgentContext
    ) {
      const candidate = (yield* this.inspectCandidate(
        candidateDigest,
        context
      )) as CandidateChangeSet;
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
    }
  );

  // V0-CH-03: Proposal and Review lifecycle
  readonly createProposal = Effect.fn("OntologyMetadataService.createProposal")(
    function* (
      this: OntologyMetadataService,
      args: {
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
      }
    ) {
      yield* this.checkContext({
        agentContext: args.agentContext,
        expectedEnvironmentId: args.expectedEnvironmentId,
        expectedTenantId: args.expectedTenantId,
      });

      const targetBranch = args.targetBranch ?? "main";
      if (!this.branches.has(args.sourceBranch)) {
        return yield* new BranchNotFoundError({
          branchName: args.sourceBranch,
        });
      }
      if (!this.branches.has(targetBranch)) {
        return yield* new BranchNotFoundError({ branchName: targetBranch });
      }

      if (args.candidateDigest && !this.candidates.has(args.candidateDigest)) {
        return yield* new CandidateNotFoundError({
          candidateDigest: args.candidateDigest,
          message: `Candidate '${args.candidateDigest}' does not exist`,
        });
      }

      const now = yield* Clock.currentTimeMillis;
      const proposal: OntologyProposal & { candidateDigest?: string } = {
        author: args.author,
        candidateDigest: args.candidateDigest,
        changeSet: args.changeSet,
        createdAt: now,
        description: args.description,
        id: generatePrefixedId("prop", now),
        reviews: [],
        sourceBranch: args.sourceBranch,
        status: "open",
        targetBranch,
        title: args.title,
        updatedAt: now,
      };

      this.proposals.set(proposal.id, proposal);
      return proposal;
    }
  );

  readonly reviewProposal = Effect.fn("OntologyMetadataService.reviewProposal")(
    function* (
      this: OntologyMetadataService,
      proposalId: string,
      review: ProposalReview,
      options?: {
        readonly expectedCandidateDigest?: string;
        readonly agentContext?: AgentContext;
        readonly expectedTenantId?: string;
        readonly expectedEnvironmentId?: string;
      }
    ) {
      yield* this.checkContext({
        agentContext: options?.agentContext,
        expectedEnvironmentId: options?.expectedEnvironmentId,
        expectedTenantId: options?.expectedTenantId,
      });

      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        return yield* new ProposalNotFoundError({
          message: `Proposal '${proposalId}' not found`,
          proposalId,
        });
      }

      // Deny self-approval: author cannot review their own proposal
      if (review.reviewer.id === proposal.author.id) {
        return yield* new SelfReviewDeniedError({
          authorId: proposal.author.id,
          message: `Author '${proposal.author.id}' cannot self-review or self-approve proposal '${proposalId}'`,
          reviewerId: review.reviewer.id,
        });
      }

      // Stale review check
      const propCandidateDigest =
        "candidateDigest" in proposal
          ? (proposal as { candidateDigest?: string }).candidateDigest
          : undefined;
      if (
        options?.expectedCandidateDigest &&
        propCandidateDigest &&
        propCandidateDigest !== options.expectedCandidateDigest
      ) {
        return yield* new StaleReviewError({
          candidateDigest: propCandidateDigest,
          message: `Review references stale candidate digest '${options.expectedCandidateDigest}', current proposal candidate is '${propCandidateDigest}'`,
          proposalId,
          reviewDigest: options.expectedCandidateDigest,
        });
      }

      const updatedReviews = [...proposal.reviews, review];
      const hasRejections = updatedReviews.some((r) => r.verdict === "reject");
      const status = hasRejections ? "rejected" : "under_review";

      const updated: OntologyProposal = {
        ...proposal,
        reviews: updatedReviews,
        status,
        updatedAt: yield* Clock.currentTimeMillis,
      };

      this.proposals.set(proposalId, updated);
      return updated;
    }
  );

  readonly mergeProposal = Effect.fn("OntologyMetadataService.mergeProposal")(
    function* (
      this: OntologyMetadataService,
      proposalId: string,
      _merger: Subject,
      policy: ApprovalsPolicy = defaultApprovalsPolicy
    ) {
      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        return yield* new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found`,
          proposalId,
        });
      }

      yield* validateProposalApprovals(proposal, policy);

      const targetSchema = this.branchSchemas.get(proposal.targetBranch);
      if (!targetSchema) {
        return yield* new BranchNotFoundError({
          branchName: proposal.targetBranch,
        });
      }

      applyProposalChangesToSchema(targetSchema, proposal.changeSet);

      const now = yield* Clock.currentTimeMillis;
      const merged: OntologyProposal = {
        ...proposal,
        mergedAt: now,
        status: "merged",
        updatedAt: now,
      };
      this.proposals.set(proposalId, merged);

      return merged;
    }
  );

  // V0-CH-03: Publication of immutable DefinitionRelease
  readonly publishRelease = Effect.fn("OntologyMetadataService.publishRelease")(
    function* (
      this: OntologyMetadataService,
      options: {
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
      }
    ) {
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
            return yield* new IdempotencyConflictError({
              idempotencyKey: options.idempotencyKey,
              message: `Idempotency key '${options.idempotencyKey}' was previously submitted for candidate '${existing.candidateDigest}', not '${options.candidateDigest}'`,
            });
          }
          return existing.receipt;
        }
      }

      // Candidate must exist
      const candidate = this.candidates.get(options.candidateDigest);
      if (!candidate) {
        return yield* new CandidateNotFoundError({
          candidateDigest: options.candidateDigest,
          message: `Candidate digest '${options.candidateDigest}' not found`,
        });
      }

      // Check expected current release (CAS / concurrency check)
      yield* validateExpectedReleaseCas(
        this.activeRelease,
        options.expectedCurrentRelease
      );

      // Verify review obligations
      if (options.reviewRefs.length === 0) {
        return yield* new ApprovalsPolicyViolationError({
          proposalId: "unknown",
          reason:
            "Publication requires at least one reviewed reference approval",
        });
      }

      const nextRev = (this.activeRelease?.revision ?? 0) + 1;
      const now = yield* Clock.currentTimeMillis;
      const release: DefinitionRelease = {
        candidateDigest: options.candidateDigest,
        canonicalDigest: candidate.canonicalDigest,
        declaredEffects: candidate.artifact.actions.map(
          (a: ActionDef) => a.effectClass
        ),
        dependencies: [],
        publishedAt: now,
        publishedBy: options.publisher,
        releaseId: `rel_${now}_${options.candidateDigest.slice(0, 8)}`,
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
        publicationId: generatePrefixedId("pub"),
        publishedAt: now,
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
    }
  );

  // Lost response recovery by publicationId or idempotencyKey
  readonly getPublication = Effect.fn("OntologyMetadataService.getPublication")(
    function* (
      this: OntologyMetadataService,
      options: {
        readonly publicationId?: string;
        readonly idempotencyKey?: string;
        readonly agentContext?: AgentContext;
        readonly expectedTenantId?: string;
        readonly expectedEnvironmentId?: string;
      }
    ) {
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

      return yield* new PublicationNotFoundError({
        identifier:
          options.publicationId ?? options.idempotencyKey ?? "unknown",
        message:
          "Publication not found for given identifier or idempotency key",
      });
    }
  );

  readonly getActiveRelease = Effect.fn(
    "OntologyMetadataService.getActiveRelease"
  )(function* (
    this: OntologyMetadataService,
    context?: ContextOptions | AgentContext
  ) {
    yield* this.checkContext(context);
    return this.activeRelease;
  });

  readonly getProposal = Effect.fn("OntologyMetadataService.getProposal")(
    function* (
      this: OntologyMetadataService,
      proposalId: string,
      context?: ContextOptions | AgentContext
    ) {
      yield* this.checkContext(context);
      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        return yield* new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found`,
          proposalId,
        });
      }
      return proposal;
    }
  );

  readonly listProposals = Effect.fn("OntologyMetadataService.listProposals")(
    function* (
      this: OntologyMetadataService,
      context?: ContextOptions | AgentContext
    ) {
      yield* this.checkContext(context);
      return [...this.proposals.values()];
    }
  );

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

  importSnapshot(data: unknown): void {
    if (!data || typeof data !== "object") {
      return;
    }
    const d = data as Record<string, unknown>;
    populateMap(this.branches, d.branches);
    populateBranchSchemas(this.branchSchemas, d.branchSchemas);
    populateMap(this.proposals, d.proposals);
    populateMap(this.candidates, d.candidates);
    populateMap(this.candidateReceipts, d.candidateReceipts);
    populateMap(this.candidateIdempotency, d.candidateIdempotency);
    populateMap(this.publicationIdempotency, d.publicationIdempotency);
    populateMap(this.publications, d.publications);
    if (d.activeRelease !== undefined) {
      this.activeRelease = (d.activeRelease ??
        null) as DefinitionRelease | null;
    }
    if (Array.isArray(d.releasesHistory)) {
      this.releasesHistory.length = 0;
      this.releasesHistory.push(...(d.releasesHistory as DefinitionRelease[]));
    }
  }
}
