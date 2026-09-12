import type {
  F1EvaluationInput,
  F1EvaluatorService,
  F2EvaluationInput,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import { generateDisposableAppView } from "@operon/generated-ui";
import type { GenerateViewOptions } from "@operon/generated-ui";
import type { RecipePack, RecipeRegistryService } from "@operon/recipes";
import type {
  AccountableIngestionService,
  ActionInbox,
  AtomicCommitService,
  AuditStore,
  AuthenticationError,
  AuthorityService,
  DynamicSecurityEngine,
  GovernedActionService,
  HumanPrincipal,
  ObjectStore,
  OntologyMetadataService,
  OperonService,
  OverrideCategory,
  ProposeMappingOptions,
  ReconciliationService,
} from "@operon/runtime";
import {
  evaluateDecisionReadiness,
  executeWritePipeline,
  principalSubject,
} from "@operon/runtime";
import {
  createWorldView,
  decodeIdentityKey,
  deriveEmailIdentityKeys,
  serializeJson,
} from "@operon/schema";
import type {
  ActionParameters,
  ActionType,
  DefinitionArtifact,
  F2Receipt,
  IdentityKey,
  IdentityResolutionProposal,
  ObjectType,
  ObjectTypeId,
  PublicF1Receipt,
  SensitivityLevel,
  Subject,
} from "@operon/schema";
import type { SkillRegistryService } from "@operon/skills";
import { Clock, Effect, Exit, Option, Predicate, Schema } from "effect";

import type { ApproverNotBoundError } from "./approver.js";
import type { McpKey } from "./keys.js";
import { checkMcpKeyPermission } from "./keys.js";

export interface ToolCallContent {
  text: string;
  type: "text";
}

export interface ToolCallResult {
  content: ToolCallContent[];
  isError?: boolean;
}

export interface ToolExecutionContext {
  readonly name: string;
  readonly args: ActionParameters;
  readonly callerKey: McpKey;
  readonly callerSubject: Subject;
  /** The verified human behind this server, or a refusal. Resolved lazily per call. */
  readonly approver: Effect.Effect<
    HumanPrincipal,
    ApproverNotBoundError | AuthenticationError
  >;
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly oms: OntologyMetadataService;
  readonly securityEngine?: DynamicSecurityEngine;
  readonly inbox: ActionInbox;
  readonly skillService: SkillRegistryService;
  readonly recipeService: RecipeRegistryService;
  readonly ingestionService: AccountableIngestionService;
  readonly reconciliationService: ReconciliationService;
  readonly authorityService: AuthorityService;
  readonly governedActionService: GovernedActionService;
  readonly atomicCommitService: AtomicCommitService;
  readonly operonService: OperonService;
  readonly f1Evaluator: F1EvaluatorService;
  readonly f2Mirror: F2MirrorService;
  readonly publicationBoundary: PublicationBoundaryService;
  readonly actionMap: Map<string, ActionType>;
  readonly objectTypeMap: Map<string, ObjectType>;
}

const handleQueryObjects = Effect.fn("handleQueryObjects")(function* (
  ctx: ToolExecutionContext
) {
  // SAFETY: typeId string maps to ObjectTypeId
  const typeId = String(ctx.args.typeId) as ObjectTypeId;
  let objects = yield* ctx.objectStore.findObjects(typeId);

  if (ctx.securityEngine) {
    objects = ctx.securityEngine.filterInstances(objects, ctx.callerSubject);
    objects = objects.map(
      (inst) =>
        ctx.securityEngine?.projectInstance(inst, ctx.callerSubject) ?? inst
    );
  }

  return {
    content: [
      {
        text: serializeJson({ count: objects.length, objects }),
        type: "text" as const,
      },
    ],
  };
});

const handleGetObject = Effect.fn("handleGetObject")(function* (
  ctx: ToolExecutionContext
) {
  // SAFETY: typeId string maps to ObjectTypeId
  const typeId = String(ctx.args.typeId) as ObjectTypeId;
  const objectId = String(ctx.args.objectId);
  let obj = yield* ctx.objectStore.getObject(typeId, objectId);

  if (!obj) {
    return {
      content: [
        {
          text: `Object not found: ${typeId}/${objectId}`,
          type: "text" as const,
        },
      ],
      isError: true,
    };
  }

  if (ctx.securityEngine) {
    const filtered = ctx.securityEngine.filterInstances(
      [obj],
      ctx.callerSubject
    );
    if (filtered.length === 0) {
      return {
        content: [
          {
            text: `Object '${objectId}' is restricted under active security view policies`,
            type: "text" as const,
          },
        ],
        isError: true,
      };
    }
    obj = ctx.securityEngine.projectInstance(obj, ctx.callerSubject);
  }

  return {
    content: [{ text: serializeJson(obj), type: "text" as const }],
  };
});

function handleListInbox(ctx: ToolExecutionContext) {
  return Effect.sync(() => {
    const pending = ctx.inbox.getPendingProposals();
    return {
      content: [
        {
          text: serializeJson({
            count: pending.length,
            proposals: pending.map((p) => ({
              actionTypeId: p.submission.actionType.id,
              createdAt: p.createdAt,
              evidenceHash: p.evidenceHash,
              expiresAt: p.expiresAt,
              id: p.id,
              parameters: p.decisionRecord.parameters,
              proposerId: p.proposerId,
              status: p.status,
            })),
          }),
          type: "text" as const,
        },
      ],
    };
  });
}

const handleApproveProposal = Effect.fn("handleApproveProposal")(function* (
  ctx: ToolExecutionContext
) {
  if (ctx.callerSubject.type !== "user") {
    return {
      content: [
        {
          text: serializeJson({
            error: "Unauthorized",
            message:
              "Only authenticated human users can approve proposals. Autonomous agents cannot self-approve or fabricate approver credentials.",
          }),
          type: "text" as const,
        },
      ],
      isError: true,
    };
  }

  const proposalId = String(ctx.args.proposalId);
  const decisionRecord = yield* ctx.inbox.approveProposal(
    proposalId,
    ctx.callerSubject
  );

  return {
    content: [
      {
        text: serializeJson({
          decisionRecordId: decisionRecord.id,
          recordHash: decisionRecord.recordHash,
          status: "APPROVED_AND_EXECUTED",
        }),
        type: "text" as const,
      },
    ],
  };
});

const handleRejectProposal = Effect.fn("handleRejectProposal")(function* (
  ctx: ToolExecutionContext
) {
  if (ctx.callerSubject.type !== "user") {
    return {
      content: [
        {
          text: serializeJson({
            error: "Unauthorized",
            message:
              "Only authenticated human users can reject proposals with operational overrides.",
          }),
          type: "text" as const,
        },
      ],
      isError: true,
    };
  }

  const proposalId = String(ctx.args.proposalId);
  // SAFETY: category string matches OverrideCategory union
  const category = String(
    ctx.args.category ?? "operational_override"
  ) as OverrideCategory;
  const override = yield* ctx.inbox.rejectProposal(
    proposalId,
    ctx.callerSubject,
    category,
    String(ctx.args.reason)
  );

  return {
    content: [
      {
        text: serializeJson({
          overrideRecordId: override.id,
          status: "VETOED",
        }),
        type: "text" as const,
      },
    ],
  };
});

const handleCheckReadiness = Effect.fn("handleCheckReadiness")(function* (
  ctx: ToolExecutionContext
) {
  // SAFETY: typeId string maps to ObjectTypeId
  const typeId = String(ctx.args.typeId) as ObjectTypeId;
  const objectId = String(ctx.args.objectId);
  const obj = yield* ctx.objectStore.getObject(typeId, objectId);
  const objType = ctx.objectTypeMap.get(typeId);

  if (!obj || !objType) {
    return {
      content: [
        {
          text: `Object or type not found: ${typeId}/${objectId}`,
          type: "text" as const,
        },
      ],
      isError: true,
    };
  }

  const readiness = evaluateDecisionReadiness(obj, objType);
  return {
    content: [
      {
        text: serializeJson({
          decisionReadiness: readiness,
          objectId,
          typeId,
        }),
        type: "text" as const,
      },
    ],
  };
});

const handleApplyDefinitionArtifact = Effect.fn(
  "handleApplyDefinitionArtifact"
)(function* (ctx: ToolExecutionContext) {
  const branch = String(ctx.args.branch);
  // SAFETY: artifact is validated by oms.applyArtifact schema
  const artifact = ctx.args.artifact as DefinitionArtifact;
  const expectedRevision = Predicate.isNumber(ctx.args.expectedRevision)
    ? ctx.args.expectedRevision
    : undefined;
  const idempotencyKey = ctx.args.idempotencyKey
    ? String(ctx.args.idempotencyKey)
    : undefined;

  const receipt = yield* ctx.oms.applyArtifact({
    artifact,
    branch,
    expectedRevision,
    idempotencyKey,
  });

  return {
    content: [{ text: serializeJson(receipt), type: "text" as const }],
  };
});

const handleInspectCandidate = Effect.fn("handleInspectCandidate")(function* (
  ctx: ToolExecutionContext
) {
  const candidateDigest = String(ctx.args.candidateDigest);
  const candidate = yield* ctx.oms.inspectCandidate(candidateDigest);
  return {
    content: [{ text: serializeJson(candidate), type: "text" as const }],
  };
});

const handleDiffCandidate = Effect.fn("handleDiffCandidate")(function* (
  ctx: ToolExecutionContext
) {
  const candidateDigest = String(ctx.args.candidateDigest);
  const diff = yield* ctx.oms.diffCandidate(candidateDigest);
  return {
    content: [{ text: serializeJson(diff), type: "text" as const }],
  };
});

const handlePublishRelease = Effect.fn("handlePublishRelease")(function* (
  ctx: ToolExecutionContext
) {
  const candidateDigest = String(ctx.args.candidateDigest);
  // SAFETY: expectedCurrentRelease matches expected release specification
  const expectedCurrentRelease = ctx.args.expectedCurrentRelease as {
    readonly kind: "none" | "release";
    readonly digest?: string;
  };
  const reviewRefs = Array.isArray(ctx.args.reviewRefs)
    ? ctx.args.reviewRefs.map(String)
    : [];
  const idempotencyKey = ctx.args.idempotencyKey
    ? String(ctx.args.idempotencyKey)
    : undefined;
  const publisherId = ctx.args.publisherId
    ? String(ctx.args.publisherId)
    : ctx.callerSubject.id;

  const publisher: Subject = {
    id: publisherId,
    name: publisherId.toUpperCase(),
    roles: ["lead_architect"],
    type: "user",
  };

  const pubReceipt = yield* ctx.oms.publishRelease({
    candidateDigest,
    expectedCurrentRelease,
    idempotencyKey,
    publisher,
    reviewRefs,
  });

  return {
    content: [{ text: serializeJson(pubReceipt), type: "text" as const }],
  };
});

const handleGetPublication = Effect.fn("handleGetPublication")(function* (
  ctx: ToolExecutionContext
) {
  const publicationId = ctx.args.publicationId
    ? String(ctx.args.publicationId)
    : undefined;
  const idempotencyKey = ctx.args.idempotencyKey
    ? String(ctx.args.idempotencyKey)
    : undefined;
  const publication = yield* ctx.oms.getPublication({
    idempotencyKey,
    publicationId,
  });
  return {
    content: [{ text: serializeJson(publication), type: "text" as const }],
  };
});

const handleGetActiveRelease = Effect.fn("handleGetActiveRelease")(function* (
  ctx: ToolExecutionContext
) {
  const activeRelease = yield* ctx.oms.getActiveRelease();
  return {
    content: [{ text: serializeJson(activeRelease), type: "text" as const }],
  };
});

const handleListSkills = Effect.fn("handleListSkills")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const skills = yield* ctx.skillService.listSkills();
  return {
    content: [{ text: serializeJson(skills), type: "text" as const }],
  };
});

const handleGetSkill = Effect.fn("handleGetSkill")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const skill = yield* ctx.skillService.getSkill(String(ctx.args.skillId));
  return {
    content: [{ text: serializeJson(skill), type: "text" as const }],
  };
});

const handleListRecipes = Effect.fn("handleListRecipes")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const recipes = yield* ctx.recipeService.listRecipes();
  return {
    content: [{ text: serializeJson(recipes), type: "text" as const }],
  };
});

const handleGetRecipe = Effect.fn("handleGetRecipe")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const recipe = yield* ctx.recipeService.getRecipe(String(ctx.args.recipeId));
  return {
    content: [{ text: serializeJson(recipe), type: "text" as const }],
  };
});

const handleImportRecipe = Effect.fn("handleImportRecipe")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "modify_schema");
  // SAFETY: pack matches RecipePack schema
  const pack = ctx.args.pack as RecipePack;
  const receipt = yield* ctx.recipeService.importRecipe(pack, ctx.skillService);
  return {
    content: [{ text: serializeJson(receipt), type: "text" as const }],
  };
});

const handleIngestSource = Effect.fn("handleIngestSource")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "modify_pipeline");
  // SAFETY: permittedUses parsed as string array
  const permittedUses = Array.isArray(ctx.args.permittedUses)
    ? (ctx.args.permittedUses as string[])
    : undefined;
  // SAFETY: sensitivity string matches SensitivityLevel
  const sensitivity = ctx.args.sensitivity as SensitivityLevel | undefined;

  const receipt = yield* ctx.ingestionService.ingestRawSource({
    environmentId: ctx.args.environmentId
      ? String(ctx.args.environmentId)
      : undefined,
    idempotencyKey: ctx.args.idempotencyKey
      ? String(ctx.args.idempotencyKey)
      : undefined,
    locator: String(ctx.args.locator),
    mediaType: String(ctx.args.mediaType),
    permittedUses,
    rawPayload: ctx.args.payload,
    sensitivity,
    tenantId: ctx.args.tenantId ? String(ctx.args.tenantId) : undefined,
  });
  return {
    content: [{ text: serializeJson(receipt), type: "text" as const }],
  };
});

const handleGetSource = Effect.fn("handleGetSource")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const source = yield* ctx.ingestionService.getSource(
    String(ctx.args.sourceId),
    ctx.args.tenantId ? String(ctx.args.tenantId) : undefined
  );
  return {
    content: [{ text: serializeJson(source), type: "text" as const }],
  };
});

const handleListSources = Effect.fn("handleListSources")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const sources = yield* ctx.ingestionService.listSources(
    ctx.args.tenantId ? String(ctx.args.tenantId) : undefined
  );
  return {
    content: [{ text: serializeJson(sources), type: "text" as const }],
  };
});

const handleProposeMapping = Effect.fn("handleProposeMapping")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "modify_schema");
  // SAFETY: propertyMappings matches ProposeMappingOptions schema
  const propertyMappings = ctx.args
    .propertyMappings as ProposeMappingOptions["propertyMappings"];
  // SAFETY: sourceIds parsed as string array
  const sourceIds = Array.isArray(ctx.args.sourceIds)
    ? (ctx.args.sourceIds as readonly string[])
    : [];
  // SAFETY: targetObjectTypeId is branded ObjectTypeId
  const targetObjectTypeId = String(
    ctx.args.targetObjectTypeId
  ) as ObjectTypeId;

  const proposal = yield* ctx.ingestionService.proposeMapping({
    author: ctx.callerSubject,
    definitionDigest: String(ctx.args.definitionDigest),
    primaryKeyField: String(ctx.args.primaryKeyField),
    propertyMappings,
    sourceIds,
    targetObjectTypeId,
    tenantId: ctx.args.tenantId ? String(ctx.args.tenantId) : undefined,
  });
  return {
    content: [{ text: serializeJson(proposal), type: "text" as const }],
  };
});

function errorResult(error: string, message: string): ToolCallResult {
  return {
    content: [
      { text: serializeJson({ error, message }), type: "text" as const },
    ],
    isError: true,
  };
}

const decodeReviewVerdict = Schema.decodeUnknownOption(
  Schema.Literals(["approve", "reject", "request_changes"])
);

/**
 * The MCP session is an agent. A review is relayed on behalf of a named human;
 * the runtime refuses agents, authors and stale digests.
 */
const handleReviewMappingProposal = Effect.fn("handleReviewMappingProposal")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "modify_pipeline");
    const verdict = decodeReviewVerdict(ctx.args.verdict);
    if (Option.isNone(verdict)) {
      return errorResult(
        "InvalidReviewVerdict",
        "verdict must be one of approve, reject, request_changes"
      );
    }
    // The reviewer is the human bound to this server, never a relayed name.
    const approver = yield* ctx.approver;
    const now = yield* Clock.currentTimeMillis;
    const reviewed = yield* ctx.ingestionService.reviewProposal({
      proposalId: String(ctx.args.proposalId),
      review: {
        comments: ctx.args.comments ? String(ctx.args.comments) : "",
        reviewedAt: now,
        reviewer: principalSubject(approver),
        verdict: verdict.value,
      },
      viewedDigest: String(ctx.args.viewedDigest),
    });
    return {
      content: [{ text: serializeJson(reviewed), type: "text" as const }],
    };
  }
);

const handleAdmitMappingProposal = Effect.fn("handleAdmitMappingProposal")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "modify_schema");
    yield* ctx.approver;
    const admitted = yield* ctx.ingestionService.admitProposal(
      String(ctx.args.proposalId),
      ctx.callerSubject
    );
    return {
      content: [{ text: serializeJson(admitted), type: "text" as const }],
    };
  }
);

const decodeSearchGrade = Schema.decodeUnknownOption(
  Schema.Literals(["quarantine", "candidate"])
);

const handleSearchQuarantine = Effect.fn("handleSearchQuarantine")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const grade =
    ctx.args.grade === undefined
      ? Option.some(undefined)
      : decodeSearchGrade(ctx.args.grade);
  if (Option.isNone(grade)) {
    return errorResult(
      "InvalidAdmissionGrade",
      "grade must be 'quarantine' or 'candidate'; objects in main are queried with operon_query_objects"
    );
  }
  const hits = yield* ctx.ingestionService.searchQuarantine({
    grade: grade.value,
    targetObjectTypeId: ctx.args.targetObjectTypeId
      ? // SAFETY: targetObjectTypeId string maps to ObjectTypeId
        (String(ctx.args.targetObjectTypeId) as ObjectTypeId)
      : undefined,
    tenantId: ctx.args.tenantId ? String(ctx.args.tenantId) : undefined,
    text: ctx.args.text ? String(ctx.args.text) : undefined,
  });
  return {
    content: [
      {
        text: serializeJson({ count: hits.length, hits }),
        type: "text" as const,
      },
    ],
  };
});

const handleGetAdmission = Effect.fn("handleGetAdmission")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  // SAFETY: typeId string maps to ObjectTypeId
  const typeId = String(ctx.args.typeId) as ObjectTypeId;
  const objectId = String(ctx.args.objectId);
  const admission = yield* ctx.ingestionService.admissionOf(typeId, objectId);
  return {
    content: [
      {
        text: serializeJson({
          admission: Option.getOrNull(admission),
          objectId,
          typeId,
        }),
        type: "text" as const,
      },
    ],
  };
});

const handleDeriveIdentityKeys = Effect.fn("handleDeriveIdentityKeys")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
    const extraSuppressedDomains = Array.isArray(ctx.args.suppressedDomains)
      ? new Set(ctx.args.suppressedDomains.map(String))
      : new Set<string>();
    const email = String(ctx.args.email);
    return Option.match(
      deriveEmailIdentityKeys(email, extraSuppressedDomains),
      {
        onNone: () =>
          errorResult(
            "InvalidEmailAddress",
            `'${email}' is not an email address`
          ),
        onSome: (keys) => ({
          content: [{ text: serializeJson(keys), type: "text" as const }],
        }),
      }
    );
  }
);

function buildQueryWorldView(args: ActionParameters) {
  const releaseRef = args.releaseRef
    ? String(args.releaseRef)
    : "active-release";
  const tenantId = args.tenantId ? String(args.tenantId) : "default";
  const environmentId = args.environmentId
    ? String(args.environmentId)
    : "default";
  const knowledgeRevision = args.knowledgeRevision
    ? Number(args.knowledgeRevision)
    : 1;
  const validTime = args.validTime ? Number(args.validTime) : Date.now();

  const worldView = createWorldView({
    definitionReleaseRef: releaseRef,
    environmentId,
    evidenceCoverage: [],
    knowledgeRevision,
    ontologyId: "operon.default",
    pinnedAt: Date.now(),
    policyContext: {},
    tenantId,
    validTime,
  });

  return { environmentId, releaseRef, tenantId, worldView };
}

const handleExactQuery = Effect.fn("handleExactQuery")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const queryId = String(ctx.args.queryId);
  const { releaseRef, worldView } = buildQueryWorldView(ctx.args);

  // SAFETY: params is JSON-compatible object
  const params = Predicate.isObject(ctx.args.params)
    ? (ctx.args.params as ActionParameters)
    : {};

  const result = yield* ctx.reconciliationService.query(
    {
      cursor: null,
      params,
      queryId,
      releaseRef,
      worldView,
    },
    ctx.objectStore,
    {
      maxStalenessMs: ctx.args.maxStalenessMs
        ? Number(ctx.args.maxStalenessMs)
        : undefined,
    }
  );

  return {
    content: [{ text: serializeJson(result), type: "text" as const }],
  };
});

const handleExplainQuery = Effect.fn("handleExplainQuery")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const dialect = ctx.args.dialect === "postgres" ? "postgres" : "sqlite";
  const plan = ctx.reconciliationService.explainQuery({
    dialect,
    id: String(ctx.args.objectId),
    txTime: Number(ctx.args.txTime),
    typeId: String(ctx.args.typeId),
    validTime: Number(ctx.args.validTime),
  });
  return {
    content: [{ text: serializeJson(plan), type: "text" as const }],
  };
});

function resolveProposalId(id?: Schema.Json): string {
  return id
    ? String(id)
    : `res_prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildIdentityProposalInput(args: ActionParameters, key: IdentityKey) {
  const proposalId = resolveProposalId(args.proposalId);
  // SAFETY: action matches IdentityResolutionProposal action union
  const action = args.action as IdentityResolutionProposal["action"];
  // SAFETY: evidence matches resolution evidence schema
  const evidence =
    (args.evidence as IdentityResolutionProposal["evidence"]) ?? [];
  // SAFETY: splitDetails matches split details schema
  const splitDetails =
    (args.splitDetails as IdentityResolutionProposal["splitDetails"]) ?? null;

  return {
    action,
    confidence: Number(args.confidence),
    environmentId: args.environmentId ? String(args.environmentId) : undefined,
    evidence,
    idempotencyKey: args.idempotencyKey
      ? String(args.idempotencyKey)
      : undefined,
    key,
    proposalId,
    splitDetails,
    targetCanonicalId: String(args.targetCanonicalId),
    tenantId: args.tenantId ? String(args.tenantId) : undefined,
  };
}

const handleProposeIdentityResolution = Effect.fn(
  "handleProposeIdentityResolution"
)(function* (ctx: ToolExecutionContext) {
  yield* checkMcpKeyPermission(ctx.callerKey, "modify_schema");
  const key = decodeIdentityKey(ctx.args.key);
  if (Option.isNone(key)) {
    return errorResult(
      "InvalidIdentityKey",
      "key must be { kind: 'email', value } with a normalized address, { kind: 'domain', value } lower-cased, or { kind: 'source_pk', sourceSystem, value }"
    );
  }
  const proposal = yield* ctx.reconciliationService.proposeIdentityResolution(
    buildIdentityProposalInput(ctx.args, key.value)
  );
  return {
    content: [{ text: serializeJson(proposal), type: "text" as const }],
  };
});

const handleResolveIdentity = Effect.fn("handleResolveIdentity")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "modify_schema");
  const receipt = yield* ctx.reconciliationService.resolveIdentity(
    String(ctx.args.proposalId),
    String(ctx.args.decisionRef),
    {
      environmentId: ctx.args.environmentId
        ? String(ctx.args.environmentId)
        : undefined,
      forceOverride: Boolean(ctx.args.forceOverride),
      idempotencyKey: ctx.args.idempotencyKey
        ? String(ctx.args.idempotencyKey)
        : undefined,
      tenantId: ctx.args.tenantId ? String(ctx.args.tenantId) : undefined,
    }
  );
  return {
    content: [{ text: serializeJson(receipt), type: "text" as const }],
  };
});

const handleListIdentityProposals = Effect.fn("handleListIdentityProposals")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
    const proposals = yield* ctx.reconciliationService.listProposals(
      ctx.args.tenantId ? String(ctx.args.tenantId) : undefined
    );
    return {
      content: [{ text: serializeJson(proposals), type: "text" as const }],
    };
  }
);

function buildProposerSubject(
  args: ActionParameters,
  callerKey: McpKey
): Subject {
  // SAFETY: proposerTier is 1-4
  const agentTier = args.proposerTier
    ? (Number(args.proposerTier) as 1 | 2 | 3 | 4)
    : callerKey.agentTier;
  // SAFETY: proposerRoles is string array
  const roles = Array.isArray(args.proposerRoles)
    ? (args.proposerRoles as string[])
    : ["ai_agent"];
  // SAFETY: proposerType is subject type
  const type = (args.proposerType as "user" | "agent" | "system") || "agent";

  return {
    agentTier,
    id: args.proposerId ? String(args.proposerId) : callerKey.agentId,
    name: callerKey.name,
    roles,
    type,
  };
}

const handlePrepareAction = Effect.fn("handlePrepareAction")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "execute_action");
  const proposer = buildProposerSubject(ctx.args, ctx.callerKey);

  const prepared = yield* ctx.governedActionService.prepareAction({
    actionId: String(ctx.args.actionId),
    environmentId: ctx.args.environmentId
      ? String(ctx.args.environmentId)
      : "default",
    grantId: ctx.args.grantId ? String(ctx.args.grantId) : undefined,
    proposer,
    rawParameters: ctx.args.parameters ?? {},
    tenantId: ctx.args.tenantId ? String(ctx.args.tenantId) : "default",
    ttlMs: ctx.args.ttlMs ? Number(ctx.args.ttlMs) : undefined,
  });

  return {
    content: [{ text: serializeJson(prepared), type: "text" as const }],
  };
});

const handleApprovePreparedAction = Effect.fn("handleApprovePreparedAction")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "execute_action");
    // The reviewer is the human bound to this server, never a relayed name.
    const approver = yield* ctx.approver;
    // SAFETY: decision is approved/rejected
    const decision =
      (ctx.args.decision as "approved" | "rejected") || "approved";

    const approval = yield* ctx.governedActionService.approvePreparedAction({
      decision,
      preparedDigest: String(ctx.args.preparedDigest),
      reason: ctx.args.reason ? String(ctx.args.reason) : undefined,
      reviewerContext: {
        assurance: "human_verified",
        environmentId: ctx.args.environmentId
          ? String(ctx.args.environmentId)
          : "default",
        reviewer: principalSubject(approver),
        tenantId: ctx.args.tenantId ? String(ctx.args.tenantId) : "default",
      },
      viewedDigest: String(ctx.args.viewedDigest),
    });

    return {
      content: [{ text: serializeJson(approval), type: "text" as const }],
    };
  }
);

const handleCommitAction = Effect.fn("handleCommitAction")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "execute_action");
  const tenantId = ctx.args.tenantId ? String(ctx.args.tenantId) : "default";
  const environmentId = ctx.args.environmentId
    ? String(ctx.args.environmentId)
    : "default";
  const preparedDigest = String(ctx.args.preparedDigest);
  const idempotencyKey = String(ctx.args.idempotencyKey);

  const prepared = yield* ctx.governedActionService.getPreparedAction(
    preparedDigest,
    tenantId
  );

  let approval;
  if (ctx.args.approvalId) {
    approval = yield* ctx.governedActionService.getApprovalRecord(
      String(ctx.args.approvalId),
      tenantId
    );
  }

  const receipt = yield* ctx.atomicCommitService.commit({
    approval,
    environmentId,
    idempotencyKey,
    prepared,
    tenantId,
  });

  return {
    content: [{ text: serializeJson(receipt), type: "text" as const }],
  };
});

const handleGetActionStatus = Effect.fn("handleGetActionStatus")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const tenantId = ctx.args.tenantId ? String(ctx.args.tenantId) : "default";
  const operationId = String(ctx.args.operationId);

  const operation = yield* ctx.atomicCommitService.getOperation(
    operationId,
    tenantId
  );

  if (!operation) {
    return {
      content: [
        { text: `Operation '${operationId}' not found`, type: "text" as const },
      ],
      isError: true,
    };
  }

  return {
    content: [{ text: serializeJson(operation), type: "text" as const }],
  };
});

function handleGenerateView(ctx: ToolExecutionContext) {
  return Effect.sync(() => {
    // SAFETY: view options validated by generateDisposableAppView
    const data = ctx.args.data as GenerateViewOptions["data"];
    // SAFETY: format matches GenerateViewOptions format
    const format = ctx.args.format as GenerateViewOptions["format"];
    // SAFETY: state matches GenerateViewOptions state
    const state =
      (ctx.args.state as GenerateViewOptions["state"]) ?? "CONFIRMED";

    const view = generateDisposableAppView({
      audience: ctx.args.audience ? String(ctx.args.audience) : undefined,
      data,
      format,
      state,
      title: String(ctx.args.title),
    });

    return {
      content: [{ text: serializeJson(view), type: "text" as const }],
    };
  });
}

const handleAssuranceEvaluateF1 = Effect.fn("handleAssuranceEvaluateF1")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
    // SAFETY: profile matches F1EvaluationInput profile
    const profile =
      (ctx.args.profile as F1EvaluationInput["profile"]) ?? "local";
    // SAFETY: testCases matches F1EvaluationInput testCases
    const testCases =
      (ctx.args.testCases as F1EvaluationInput["testCases"]) ?? [];

    const receipt = yield* ctx.f1Evaluator.evaluate({
      candidateDigest: String(ctx.args.candidateDigest),
      candidateId: String(ctx.args.candidateId),
      catalogDigest: String(ctx.args.catalogDigest),
      catalogId: String(ctx.args.catalogId),
      idempotencyKey: ctx.args.idempotencyKey
        ? String(ctx.args.idempotencyKey)
        : undefined,
      profile,
      testCases,
    });
    return {
      content: [{ text: serializeJson(receipt), type: "text" as const }],
    };
  }
);

const handleAssuranceMirrorF2 = Effect.fn("handleAssuranceMirrorF2")(function* (
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  // SAFETY: claim matches F2EvaluationInput claim
  const claim =
    (ctx.args.claim as F2EvaluationInput["claim"]) ?? "observed-action";
  // SAFETY: consentScope matches F2EvaluationInput consentScope
  const consentScope = ctx.args
    .consentScope as F2EvaluationInput["consentScope"];
  // SAFETY: corrections matches F2EvaluationInput corrections
  const corrections =
    (ctx.args.corrections as F2EvaluationInput["corrections"]) ?? [];

  const receipt = yield* ctx.f2Mirror.evaluateMirror({
    candidateDigest: String(ctx.args.candidateDigest),
    claim,
    companyEvidenceRef: String(ctx.args.companyEvidenceRef),
    consentScope,
    corrections,
    idempotencyKey: ctx.args.idempotencyKey
      ? String(ctx.args.idempotencyKey)
      : undefined,
    participantId: String(ctx.args.participantId),
    profileDigest: String(ctx.args.profileDigest),
    rubricDigest: String(ctx.args.rubricDigest),
  });
  return {
    content: [{ text: serializeJson(receipt), type: "text" as const }],
  };
});

const handleAssuranceScanPublication = Effect.fn(
  "handleAssuranceScanPublication"
)(function* (ctx: ToolExecutionContext) {
  yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
  const targetDir = ctx.args.targetDirectory
    ? String(ctx.args.targetDirectory)
    : process.cwd();
  const scanRes = yield* ctx.publicationBoundary.scanDirectory(targetDir, {
    allowedPublicOnly: ctx.args.allowedPublicOnly === true,
  });
  return {
    content: [{ text: serializeJson(scanRes), type: "text" as const }],
  };
});

const handleAssuranceVerifyReceipt = Effect.fn("handleAssuranceVerifyReceipt")(
  function* (ctx: ToolExecutionContext) {
    yield* checkMcpKeyPermission(ctx.callerKey, "query_runtime");
    const rcpt = ctx.args.receipt;
    let isValid = false;
    if (Predicate.isObject(rcpt) && "outcome" in rcpt) {
      // SAFETY: rcpt with outcome matches PublicF1Receipt
      isValid = yield* ctx.f1Evaluator.verifyReceipt(rcpt as PublicF1Receipt);
    } else if (Predicate.isObject(rcpt) && "claim" in rcpt) {
      // SAFETY: rcpt with claim matches F2Receipt
      isValid = yield* ctx.f2Mirror.verifyReceipt(rcpt as F2Receipt);
    }
    return {
      content: [{ text: serializeJson({ isValid }), type: "text" as const }],
    };
  }
);

const handleDiagnose = Effect.fn("handleDiagnose")(function* (
  ctx: ToolExecutionContext
) {
  const runId = String(ctx.args.runId);
  const diagExit = yield* Effect.exit(ctx.operonService.diagnose(runId));
  if (Exit.isFailure(diagExit)) {
    return {
      content: [
        {
          text: serializeJson({
            error: "DiagnosticNotFoundError",
            message: `Diagnostic bundle for run '${runId}' not found`,
          }),
          type: "text" as const,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        text: serializeJson(diagExit.value),
        type: "text" as const,
      },
    ],
  };
});

export const handleDynamicAction = Effect.fn("handleDynamicAction")(function* (
  action: ActionType,
  ctx: ToolExecutionContext
) {
  yield* checkMcpKeyPermission(ctx.callerKey, "execute_action");
  const agentSubject: Subject = {
    agentTier: ctx.callerKey.agentTier,
    id: ctx.callerKey.agentId,
    name: ctx.callerKey.name,
    roles: ["ai_agent"],
    type: "agent",
  };

  const now = yield* Clock.currentTimeMillis;
  const result = yield* executeWritePipeline(
    {
      actionType: action,
      rawParameters: ctx.args,
      security: {
        correlationId: `mcp-${now}`,
        subject: agentSubject,
        timestamp: now,
      },
    },
    ctx.objectStore,
    ctx.auditStore
  );

  if (result.status === "proposed") {
    ctx.inbox.addProposal(
      {
        actionType: action,
        rawParameters: ctx.args,
        security: {
          correlationId: `mcp-${now}`,
          subject: agentSubject,
          timestamp: now,
        },
      },
      result.decisionRecord
    );

    return {
      content: [
        {
          text: serializeJson({
            decisionRecordId: result.decisionRecord.id,
            message:
              "Action was successfully routed to the Human Action Inbox for review and confirmation.",
            proposalId: result.proposalId,
            status: "PROPOSAL_CREATED",
          }),
          type: "text" as const,
        },
      ],
    };
  }

  return {
    content: [
      {
        text: serializeJson({
          decisionRecordId: result.decisionRecord.id,
          recordHash: result.decisionRecord.recordHash,
          status: "EXECUTED",
          updatedCount: result.updatedObjects.length,
        }),
        type: "text" as const,
      },
    ],
  };
});

export const STANDARD_TOOL_HANDLERS: ReadonlyMap<
  string,
  (ctx: ToolExecutionContext) => Effect.Effect<ToolCallResult, unknown>
> = new Map([
  ["operon_admit_mapping_proposal", handleAdmitMappingProposal],
  ["operon_apply_definition_artifact", handleApplyDefinitionArtifact],
  ["operon_approve_prepared_action", handleApprovePreparedAction],
  ["operon_approve_proposal", handleApproveProposal],
  ["operon_assurance_evaluate_f1", handleAssuranceEvaluateF1],
  ["operon_assurance_mirror_f2", handleAssuranceMirrorF2],
  ["operon_assurance_scan_publication", handleAssuranceScanPublication],
  ["operon_assurance_verify_receipt", handleAssuranceVerifyReceipt],
  ["operon_check_readiness", handleCheckReadiness],
  ["operon_commit_action", handleCommitAction],
  ["operon_derive_identity_keys", handleDeriveIdentityKeys],
  ["operon_diagnose", handleDiagnose],
  ["operon_diff_candidate", handleDiffCandidate],
  ["operon_exact_query", handleExactQuery],
  ["operon_explain_query", handleExplainQuery],
  ["operon_generate_view", handleGenerateView],
  ["operon_get_action_status", handleGetActionStatus],
  ["operon_get_active_release", handleGetActiveRelease],
  ["operon_get_admission", handleGetAdmission],
  ["operon_get_object", handleGetObject],
  ["operon_get_publication", handleGetPublication],
  ["operon_get_recipe", handleGetRecipe],
  ["operon_get_skill", handleGetSkill],
  ["operon_get_source", handleGetSource],
  ["operon_import_recipe", handleImportRecipe],
  ["operon_ingest_source", handleIngestSource],
  ["operon_inspect_candidate", handleInspectCandidate],
  ["operon_list_identity_proposals", handleListIdentityProposals],
  ["operon_list_inbox", handleListInbox],
  ["operon_list_recipes", handleListRecipes],
  ["operon_list_skills", handleListSkills],
  ["operon_list_sources", handleListSources],
  ["operon_prepare_action", handlePrepareAction],
  ["operon_propose_identity_resolution", handleProposeIdentityResolution],
  ["operon_propose_mapping", handleProposeMapping],
  ["operon_publish_release", handlePublishRelease],
  ["operon_query_objects", handleQueryObjects],
  ["operon_reject_proposal", handleRejectProposal],
  ["operon_resolve_identity", handleResolveIdentity],
  ["operon_review_mapping_proposal", handleReviewMappingProposal],
  ["operon_search_quarantine", handleSearchQuarantine],
]);
