import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  F1EvaluatorService,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import { generateDisposableAppView } from "@operon/generated-ui";
import { BUILTIN_RECIPES, RecipeService } from "@operon/recipes";
import type { RecipePack, RecipeRegistryService } from "@operon/recipes";
import type {
  AuditStore,
  DynamicSecurityEngine,
  ObjectStore,
  OntologyMetadataService,
  OperonService,
  OverrideCategory,
} from "@operon/runtime";
import {
  AccountableIngestionService,
  ActionInbox,
  AtomicCommitService,
  AuthorityService,
  evaluateDecisionReadiness,
  executeWritePipeline,
  GovernedActionService,
  OperonServiceImpl,
  ReconciliationService,
} from "@operon/runtime";
import { createWorldView } from "@operon/schema";
import type {
  ActionType,
  ObjectType,
  ObjectTypeId,
  Subject,
} from "@operon/schema";
import { BUILTIN_SKILLS, SkillService } from "@operon/skills";
import type { SkillRegistryService } from "@operon/skills";
import { Cause, Data, Effect, Exit } from "effect";

import type { McpKey } from "./keys.js";
import { checkMcpKeyPermission } from "./keys.js";
import { projectActionToTool } from "./projection.js";

export class McpResourceNotFoundError extends Data.TaggedError(
  "McpResourceNotFoundError"
)<{
  readonly uri: string;
}> {}

export interface OperonMcpServerOptions {
  readonly objectTypes: readonly ObjectType[];
  readonly actionTypes: readonly ActionType[];
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly oms: OntologyMetadataService;
  readonly inbox?: ActionInbox;
  readonly securityEngine?: DynamicSecurityEngine;
  readonly defaultCallerKey?: McpKey;
  readonly skillService?: SkillRegistryService;
  readonly recipeService?: RecipeRegistryService;
  readonly ingestionService?: AccountableIngestionService;
  readonly reconciliationService?: ReconciliationService;
  readonly authorityService?: AuthorityService;
  readonly governedActionService?: GovernedActionService;
  readonly atomicCommitService?: AtomicCommitService;
  readonly operonService?: OperonService;
  readonly f1Evaluator?: F1EvaluatorService;
  readonly f2Mirror?: F2MirrorService;
  readonly publicationBoundary?: PublicationBoundaryService;
}

export function createOperonMcpServer(options: OperonMcpServerOptions) {
  const {
    objectTypes,
    actionTypes,
    objectStore,
    auditStore,
    oms,
    securityEngine,
    defaultCallerKey,
  } = options;

  const inbox = options.inbox ?? new ActionInbox(auditStore, objectStore);

  const skillService =
    options.skillService ??
    (() => {
      const s = SkillService.make();
      for (const skill of BUILTIN_SKILLS) {
        Effect.runSync(s.registerSkill(skill));
      }
      return s;
    })();

  const recipeService =
    options.recipeService ??
    (() => {
      const r = RecipeService.make();
      for (const recipe of BUILTIN_RECIPES) {
        Effect.runSync(r.registerRecipe(recipe));
      }
      return r;
    })();

  const ingestionService =
    options.ingestionService ?? new AccountableIngestionService(objectStore);

  const reconciliationService =
    options.reconciliationService ?? ReconciliationService.make();

  const authorityService = options.authorityService ?? new AuthorityService();

  const actionTypesMap = new Map<string, ActionType<any>>();
  for (const act of actionTypes) {
    actionTypesMap.set(act.id, act);
  }

  const governedActionService =
    options.governedActionService ??
    new GovernedActionService(actionTypes, objectStore, authorityService);

  const atomicCommitService =
    options.atomicCommitService ??
    new AtomicCommitService(
      actionTypesMap,
      objectStore,
      auditStore,
      authorityService
    );

  const f1Evaluator = options.f1Evaluator ?? new F1EvaluatorService();
  const f2Mirror = options.f2Mirror ?? new F2MirrorService();
  const publicationBoundary =
    options.publicationBoundary ?? new PublicationBoundaryService();

  const _operonService =
    options.operonService ??
    new OperonServiceImpl(
      governedActionService,
      atomicCommitService,
      authorityService,
      reconciliationService,
      objectStore,
      f1Evaluator,
      f2Mirror,
      publicationBoundary
    );

  const server = new Server(
    {
      name: "operon-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  const actionMap = new Map<string, ActionType>();
  for (const a of actionTypes) {
    actionMap.set(a.id, a);
  }

  const objectTypeMap = new Map<string, ObjectType>();
  for (const o of objectTypes) {
    objectTypeMap.set(o.id, o);
  }

  // Handler: List Tools
  server.setRequestHandler(ListToolsRequestSchema, (_request) => {
    // Standard read-side ontology tools
    const standardTools = [
      {
        description:
          "Query objects of a given type from the operational ontology with dynamic security enforcement",
        inputSchema: {
          properties: {
            typeId: {
              description: "The ObjectTypeId to query",
              type: "string",
            },
          },
          required: ["typeId"],
          type: "object",
        },
        name: "operon_query_objects",
      },
      {
        description:
          "Get a single object by ID from the operational ontology with dynamic security enforcement",
        inputSchema: {
          properties: {
            objectId: { description: "The object ID", type: "string" },
            typeId: { description: "The ObjectTypeId", type: "string" },
          },
          required: ["typeId", "objectId"],
          type: "object",
        },
        name: "operon_get_object",
      },
      {
        description:
          "Evaluate 4C Decision Readiness (Correct, Complete, Current, Consistent) for an object",
        inputSchema: {
          properties: {
            objectId: {
              description: "The object primary key ID",
              type: "string",
            },
            typeId: { description: "The ObjectTypeId", type: "string" },
          },
          required: ["typeId", "objectId"],
          type: "object",
        },
        name: "operon_check_readiness",
      },
      {
        description:
          "List pending action proposals awaiting human operator review in the Action Inbox",
        inputSchema: {
          properties: {},
          type: "object",
        },
        name: "operon_list_inbox",
      },
      {
        description:
          "Approve and execute a pending proposal from the Human Action Inbox",
        inputSchema: {
          properties: {
            approverId: {
              description: "ID of the human operator approving the action",
              type: "string",
            },
            approverName: {
              description: "Name of the human operator",
              type: "string",
            },
            approverRoles: {
              description:
                "Roles of the approver (e.g. operator, admin, physician)",
              items: { type: "string" },
              type: "array",
            },
            proposalId: {
              description: "The proposal ID to approve",
              type: "string",
            },
          },
          required: ["proposalId"],
          type: "object",
        },
        name: "operon_approve_proposal",
      },
      {
        description:
          "Reject / veto a pending proposal with a first-class override reason",
        inputSchema: {
          properties: {
            approverId: {
              description: "ID of the human operator vetoing the action",
              type: "string",
            },
            category: {
              description:
                "Override category (operational_override, clinical_discretion, safety_veto)",
              type: "string",
            },
            proposalId: {
              description: "The proposal ID to reject",
              type: "string",
            },
            reason: {
              description: "Structured rationale for the veto",
              type: "string",
            },
          },
          required: ["proposalId", "reason"],
          type: "object",
        },
        name: "operon_reject_proposal",
      },
      {
        description:
          "Atomically compile and apply a DefinitionArtifact to an ontology branch (V0-CH-02)",
        inputSchema: {
          properties: {
            artifact: {
              description: "The full DefinitionArtifact JSON payload",
              type: "object",
            },
            branch: { description: "Target branch name", type: "string" },
            expectedRevision: {
              description: "Expected branch revision (CAS)",
              type: "number",
            },
            idempotencyKey: {
              description: "Optional idempotency key",
              type: "string",
            },
          },
          required: ["branch", "artifact"],
          type: "object",
        },
        name: "operon_apply_definition_artifact",
      },
      {
        description: "Inspect a candidate ChangeSet by its canonical digest",
        inputSchema: {
          properties: {
            candidateDigest: {
              description: "SHA-256 digest of candidate",
              type: "string",
            },
          },
          required: ["candidateDigest"],
          type: "object",
        },
        name: "operon_inspect_candidate",
      },
      {
        description:
          "Diff a candidate ChangeSet against the active main release",
        inputSchema: {
          properties: {
            candidateDigest: {
              description: "SHA-256 digest of candidate",
              type: "string",
            },
          },
          required: ["candidateDigest"],
          type: "object",
        },
        name: "operon_diff_candidate",
      },
      {
        description:
          "Publish an approved candidate as an immutable DefinitionRelease (V0-CH-03)",
        inputSchema: {
          properties: {
            candidateDigest: {
              description: "Candidate digest to publish",
              type: "string",
            },
            expectedCurrentRelease: {
              description:
                "Expected current release CAS check: { kind: 'none' | 'release', digest?: string }",
              properties: {
                digest: { type: "string" },
                kind: { enum: ["none", "release"], type: "string" },
              },
              required: ["kind"],
              type: "object",
            },
            idempotencyKey: {
              description: "Optional idempotency key",
              type: "string",
            },
            publisherId: {
              description: "ID of publishing user or architect",
              type: "string",
            },
            reviewRefs: {
              description: "List of approved review reference IDs",
              items: { type: "string" },
              type: "array",
            },
          },
          required: ["candidateDigest", "expectedCurrentRelease", "reviewRefs"],
          type: "object",
        },
        name: "operon_publish_release",
      },
      {
        description:
          "Recover a publication receipt by publicationId or idempotencyKey",
        inputSchema: {
          properties: {
            idempotencyKey: {
              description: "Idempotency key used during publish",
              type: "string",
            },
            publicationId: {
              description: "The publication receipt ID",
              type: "string",
            },
          },
          type: "object",
        },
        name: "operon_get_publication",
      },
      {
        description: "Get the currently active immutable DefinitionRelease",
        inputSchema: {
          properties: {},
          type: "object",
        },
        name: "operon_get_active_release",
      },
      {
        description:
          "List all registered versioned agent skills with contract version and prerequisites",
        inputSchema: {
          properties: {},
          type: "object",
        },
        name: "operon_list_skills",
      },
      {
        description:
          "Get complete definition, schemas, and digest of a versioned agent skill",
        inputSchema: {
          properties: {
            skillId: {
              description: "The unique identifier of the skill",
              type: "string",
            },
          },
          required: ["skillId"],
          type: "object",
        },
        name: "operon_get_skill",
      },
      {
        description: "List all registered versioned recipe packs",
        inputSchema: {
          properties: {},
          type: "object",
        },
        name: "operon_list_recipes",
      },
      {
        description:
          "Get complete definition, ontologies, and skills of a versioned recipe pack",
        inputSchema: {
          properties: {
            recipeId: {
              description: "The unique identifier of the recipe",
              type: "string",
            },
          },
          required: ["recipeId"],
          type: "object",
        },
        name: "operon_get_recipe",
      },
      {
        description:
          "Import a declarative recipe pack (enforces S14: recipe import grants no authority)",
        inputSchema: {
          properties: {
            pack: {
              description: "The complete recipe pack with manifest and skills",
              type: "object",
            },
          },
          required: ["pack"],
          type: "object",
        },
        name: "operon_import_recipe",
      },
      {
        description:
          "Ingest a raw source artifact into inventory before mapping or admission (V0-CH-05)",
        inputSchema: {
          properties: {
            environmentId: { type: "string" },
            idempotencyKey: { type: "string" },
            locator: {
              description: "Source locator (e.g. URI, topic)",
              type: "string",
            },
            mediaType: {
              description: "MIME type (e.g. application/json)",
              type: "string",
            },
            payload: { description: "Raw payload data or JSON string" },
            permittedUses: { items: { type: "string" }, type: "array" },
            sensitivity: {
              enum: ["public", "internal", "confidential", "restricted"],
              type: "string",
            },
            tenantId: { type: "string" },
          },
          required: ["locator", "mediaType", "payload"],
          type: "object",
        },
        name: "operon_ingest_source",
      },
      {
        description: "Get a raw source artifact by ID (V0-CH-05)",
        inputSchema: {
          properties: {
            sourceId: { type: "string" },
            tenantId: { type: "string" },
          },
          required: ["sourceId"],
          type: "object",
        },
        name: "operon_get_source",
      },
      {
        description: "List raw source artifacts in inventory (V0-CH-05)",
        inputSchema: {
          properties: {
            tenantId: { type: "string" },
          },
          type: "object",
        },
        name: "operon_list_sources",
      },
      {
        description:
          "Propose an accountable mapping from raw sources to candidate records with full provenance (V0-CH-05)",
        inputSchema: {
          properties: {
            definitionDigest: { type: "string" },
            primaryKeyField: { type: "string" },
            propertyMappings: {
              items: {
                properties: {
                  sourceField: { type: "string" },
                  targetPropertyName: { type: "string" },
                },
                required: ["sourceField", "targetPropertyName"],
                type: "object",
              },
              type: "array",
            },
            sourceIds: { items: { type: "string" }, type: "array" },
            targetObjectTypeId: { type: "string" },
            tenantId: { type: "string" },
          },
          required: [
            "sourceIds",
            "definitionDigest",
            "targetObjectTypeId",
            "primaryKeyField",
            "propertyMappings",
          ],
          type: "object",
        },
        name: "operon_propose_mapping",
      },
      {
        description:
          "Admit candidate records from an approved mapping proposal into the Object Store (V0-CH-05)",
        inputSchema: {
          properties: {
            proposalId: { type: "string" },
          },
          required: ["proposalId"],
          type: "object",
        },
        name: "operon_admit_mapping_proposal",
      },
      {
        description:
          "Execute an exact bitemporal point-in-time query under an immutable WorldView (S04)",
        inputSchema: {
          properties: {
            environmentId: { type: "string" },
            knowledgeRevision: { type: "number" },
            maxStalenessMs: { type: "number" },
            params: { type: "object" },
            queryId: { type: "string" },
            releaseRef: { type: "string" },
            tenantId: { type: "string" },
            validTime: { type: "number" },
          },
          required: ["queryId"],
          type: "object",
        },
        name: "operon_exact_query",
      },
      {
        description:
          "Explain an exact bitemporal point query without executing, returning SQL plan and parameter bindings (S04)",
        inputSchema: {
          properties: {
            dialect: { enum: ["sqlite", "postgres"], type: "string" },
            objectId: { type: "string" },
            txTime: { type: "number" },
            typeId: { type: "string" },
            validTime: { type: "number" },
          },
          required: ["typeId", "objectId", "validTime", "txTime"],
          type: "object",
        },
        name: "operon_explain_query",
      },
      {
        description:
          "Propose an identity resolution (deterministic or language-model matching) with source-system keys and provenance (S03)",
        inputSchema: {
          properties: {
            action: { enum: ["link", "merge", "split"], type: "string" },
            confidence: { type: "number" },
            environmentId: { type: "string" },
            evidence: { items: { type: "object" }, type: "array" },
            idempotencyKey: { type: "string" },
            proposalId: { type: "string" },
            sourceKey: { type: "string" },
            sourceSystem: { type: "string" },
            splitDetails: { type: "object" },
            targetCanonicalId: { type: "string" },
            tenantId: { type: "string" },
          },
          required: [
            "sourceSystem",
            "sourceKey",
            "targetCanonicalId",
            "action",
            "confidence",
          ],
          type: "object",
        },
        name: "operon_propose_identity_resolution",
      },
      {
        description:
          "Resolve an identity proposal per S03, preserving history and invalidating affected projections",
        inputSchema: {
          properties: {
            decisionRef: { type: "string" },
            environmentId: { type: "string" },
            forceOverride: { type: "boolean" },
            idempotencyKey: { type: "string" },
            proposalId: { type: "string" },
            tenantId: { type: "string" },
          },
          required: ["proposalId", "decisionRef"],
          type: "object",
        },
        name: "operon_resolve_identity",
      },
      {
        description: "List pending or resolved identity resolution proposals",
        inputSchema: {
          properties: {
            tenantId: { type: "string" },
          },
          type: "object",
        },
        name: "operon_list_identity_proposals",
      },
      {
        description:
          "Prepare an action with policy/criteria verification, object revision recording, and exact canonical proposal digest calculation. Dry-run invariant: leaves canonical business state untouched (S07).",
        inputSchema: {
          properties: {
            actionId: {
              description: "Registered ActionType ID",
              type: "string",
            },
            environmentId: { type: "string" },
            grantId: { description: "Optional IntentGrant ID", type: "string" },
            parameters: {
              description: "Parameters for the action",
              type: "object",
            },
            proposerId: { type: "string" },
            proposerRoles: { items: { type: "string" }, type: "array" },
            proposerTier: { type: "number" },
            proposerType: { enum: ["user", "agent", "system"], type: "string" },
            tenantId: { type: "string" },
            ttlMs: { type: "number" },
          },
          required: ["actionId", "parameters"],
          type: "object",
        },
        name: "operon_prepare_action",
      },
      {
        description:
          "Approve or reject a prepared action proposal. Enforces exact digest binding (viewedDigest === preparedDigest), human reviewer requirements, no self-approval, and non-staleness (S07).",
        inputSchema: {
          properties: {
            assurance: {
              enum: ["human_verified", "delegated_service"],
              type: "string",
            },
            decision: { enum: ["approved", "rejected"], type: "string" },
            environmentId: { type: "string" },
            preparedDigest: {
              description: "Digest of prepared action",
              type: "string",
            },
            reason: { type: "string" },
            reviewerId: { type: "string" },
            reviewerRoles: { items: { type: "string" }, type: "array" },
            tenantId: { type: "string" },
            viewedDigest: {
              description: "Digest viewed by reviewer",
              type: "string",
            },
          },
          required: ["preparedDigest", "viewedDigest"],
          type: "object",
        },
        name: "operon_approve_prepared_action",
      },
      {
        description:
          "Atomically commit an approved action, updating business state, consuming approval, creating outbox entries, and recording idempotency (S08).",
        inputSchema: {
          properties: {
            approvalId: {
              description: "Optional approval record ID",
              type: "string",
            },
            environmentId: { type: "string" },
            idempotencyKey: {
              description: "Scoped idempotency key",
              type: "string",
            },
            preparedDigest: {
              description: "Canonical digest of prepared action",
              type: "string",
            },
            tenantId: { type: "string" },
          },
          required: ["preparedDigest", "idempotencyKey"],
          type: "object",
        },
        name: "operon_commit_action",
      },
      {
        description:
          "Get status and receipt of a committed operation by operationId (S08).",
        inputSchema: {
          properties: {
            operationId: { type: "string" },
            tenantId: { type: "string" },
          },
          required: ["operationId"],
          type: "object",
        },
        name: "operon_get_action_status",
      },
      {
        description:
          "Generate a disposable, grant-bounded application view (table, markdown card, or JSON) with lifecycle state labels (S13).",
        inputSchema: {
          properties: {
            audience: { type: "string" },
            data: { type: "object" },
            format: {
              enum: ["markdown", "table", "card", "json"],
              type: "string",
            },
            state: {
              enum: [
                "ACCEPTED",
                "PROPOSED",
                "RUNNING",
                "CONFIRMED",
                "HYPOTHETICAL",
              ],
              type: "string",
            },
            title: { type: "string" },
          },
          required: ["title", "state", "data"],
          type: "object",
        },
        name: "operon_generate_view",
      },
      {
        description:
          "Run Protected Company-in-a-Box evaluator and generate Ed25519-signed PublicF1Receipt (V0-CH-10 / S17)",
        inputSchema: {
          properties: {
            candidateDigest: { type: "string" },
            candidateId: { type: "string" },
            catalogDigest: { type: "string" },
            catalogId: { type: "string" },
            idempotencyKey: { type: "string" },
            profile: {
              enum: ["local", "production", "external-agent"],
              type: "string",
            },
            testCases: {
              items: {
                properties: {
                  assertions: { type: "number" },
                  errorMessage: { type: "string" },
                  executionTimeMs: { type: "number" },
                  id: { type: "string" },
                  name: { type: "string" },
                  status: {
                    enum: ["PASS", "FAIL", "INCONCLUSIVE"],
                    type: "string",
                  },
                },
                required: ["id", "name", "status", "assertions"],
                type: "object",
              },
              type: "array",
            },
          },
          required: [
            "candidateId",
            "candidateDigest",
            "catalogId",
            "catalogDigest",
            "testCases",
          ],
          type: "object",
        },
        name: "operon_assurance_evaluate_f1",
      },
      {
        description:
          "Run consented real-company mirror evaluation and generate Ed25519-signed F2Receipt (V0-CH-11 / S17)",
        inputSchema: {
          properties: {
            candidateDigest: { type: "string" },
            claim: {
              enum: ["model-and-query-only", "observed-action"],
              type: "string",
            },
            companyEvidenceRef: { type: "string" },
            consentScope: {
              properties: {
                consentGrantId: { type: "string" },
                dataScope: { items: { type: "string" }, type: "array" },
                expiresAt: { type: "number" },
                participantId: { type: "string" },
                purpose: { type: "string" },
              },
              required: [
                "consentGrantId",
                "participantId",
                "dataScope",
                "purpose",
                "expiresAt",
              ],
              type: "object",
            },
            corrections: {
              items: {
                properties: {
                  correctedAt: { type: "number" },
                  correctedBy: { type: "string" },
                  correctedValue: {},
                  correctionId: { type: "string" },
                  observedTarget: { type: "string" },
                  priorValue: {},
                  reason: { type: "string" },
                },
                required: [
                  "correctionId",
                  "observedTarget",
                  "correctedBy",
                  "reason",
                ],
                type: "object",
              },
              type: "array",
            },
            idempotencyKey: { type: "string" },
            participantId: { type: "string" },
            profileDigest: { type: "string" },
            rubricDigest: { type: "string" },
          },
          required: [
            "candidateDigest",
            "profileDigest",
            "rubricDigest",
            "companyEvidenceRef",
            "participantId",
            "consentScope",
            "corrections",
            "claim",
          ],
          type: "object",
        },
        name: "operon_assurance_mirror_f2",
      },
      {
        description:
          "Scan directory/files for protected benchmark material, private oracles, and gold leaks (V0-CH-12 / S17)",
        inputSchema: {
          properties: {
            allowedPublicOnly: { type: "boolean" },
            targetDirectory: { type: "string" },
          },
          type: "object",
        },
        name: "operon_assurance_scan_publication",
      },
      {
        description:
          "Cryptographically verify Ed25519 signature on an F1 or F2 receipt (S17)",
        inputSchema: {
          properties: {
            receipt: { type: "object" },
          },
          required: ["receipt"],
          type: "object",
        },
        name: "operon_assurance_verify_receipt",
      },
    ];

    // Project all Action cards into MCP tool schemas
    const actionTools = actionTypes.map(projectActionToTool).map((t) => ({
      description: t.description,
      inputSchema: t.inputSchema,
      name: t.name,
    }));

    return Promise.resolve({
      tools: [...standardTools, ...actionTools],
    });
  });

  // Handler: List Resources
  server.setRequestHandler(ListResourcesRequestSchema, (_request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const skills = yield* skillService.listSkills();
        const recipes = yield* recipeService.listRecipes();

        const skillResources = skills.map((s) => ({
          description: s.description,
          mimeType: "application/json",
          name: s.name,
          uri: `operon://skills/${s.id}`,
        }));

        const recipeResources = recipes.map((r) => ({
          description: r.description,
          mimeType: "application/json",
          name: r.name,
          uri: `operon://recipes/${r.id}`,
        }));

        return {
          resources: [...skillResources, ...recipeResources],
        };
      })
    )
  );

  // Handler: Read Resource
  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { uri } = request.params;
        if (uri.startsWith("operon://skills/")) {
          const skillId = uri.slice("operon://skills/".length);
          const skill = yield* skillService.getSkill(skillId);
          return {
            contents: [
              {
                mimeType: "application/json",
                text: JSON.stringify(skill, null, 2),
                uri,
              },
            ],
          };
        }
        if (uri.startsWith("operon://recipes/")) {
          const recipeId = uri.slice("operon://recipes/".length);
          const recipe = yield* recipeService.getRecipe(recipeId);
          return {
            contents: [
              {
                mimeType: "application/json",
                text: JSON.stringify(recipe, null, 2),
                uri,
              },
            ],
          };
        }

        return yield* new McpResourceNotFoundError({ uri });
      })
    )
  );

  // Handler: Call Tool
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args = {} } = request.params;

    // Default caller subject representing the LLM Agent
    const callerKey: McpKey = defaultCallerKey ?? {
      agentId: "agent-mcp-session",
      agentTier: 2, // Default: Propose tier
      keyId: "mcp-agent-key-1",
      name: "AutonomousAgent",
      role: "consumer",
    };

    const callerSubject: Subject = {
      agentTier: callerKey.agentTier,
      id: callerKey.agentId,
      name: callerKey.name,
      roles: ["ai_agent"],
      type: "agent",
    };

    const executeTool = Effect.fn("McpServer.executeTool")(function* () {
      if (name === "operon_query_objects") {
        const typeId = String(args.typeId) as ObjectTypeId;
        let objects = yield* objectStore.findObjects(typeId);

        if (securityEngine) {
          objects = securityEngine.filterInstances(objects, callerSubject);
          objects = objects.map((inst) =>
            securityEngine.projectInstance(inst, callerSubject)
          );
        }

        return {
          content: [
            {
              text: JSON.stringify({ count: objects.length, objects }, null, 2),
              type: "text",
            },
          ],
        };
      }

      if (name === "operon_get_object") {
        const typeId = String(args.typeId) as ObjectTypeId;
        const objectId = String(args.objectId);
        let obj = yield* objectStore.getObject(typeId, objectId);

        if (!obj) {
          return {
            content: [
              { text: `Object not found: ${typeId}/${objectId}`, type: "text" },
            ],
            isError: true,
          };
        }

        if (securityEngine) {
          const filtered = securityEngine.filterInstances([obj], callerSubject);
          if (filtered.length === 0) {
            return {
              content: [
                {
                  text: `Object '${objectId}' is restricted under active security view policies`,
                  type: "text",
                },
              ],
              isError: true,
            };
          }
          obj = securityEngine.projectInstance(obj, callerSubject);
        }

        return {
          content: [{ text: JSON.stringify(obj, null, 2), type: "text" }],
        };
      }

      if (name === "operon_list_inbox") {
        const pending = inbox.getPendingProposals();
        return {
          content: [
            {
              text: JSON.stringify(
                {
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
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      if (name === "operon_approve_proposal") {
        if (callerSubject.type !== "user") {
          return {
            content: [
              {
                text: JSON.stringify({
                  error: "Unauthorized",
                  message:
                    "Only authenticated human users can approve proposals. Autonomous agents cannot self-approve or fabricate approver credentials.",
                }),
                type: "text",
              },
            ],
            isError: true,
          };
        }

        const proposalId = String(args.proposalId);
        const decisionRecord = yield* inbox.approveProposal(
          proposalId,
          callerSubject
        );

        return {
          content: [
            {
              text: JSON.stringify(
                {
                  decisionRecordId: decisionRecord.id,
                  recordHash: decisionRecord.recordHash,
                  status: "APPROVED_AND_EXECUTED",
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      if (name === "operon_reject_proposal") {
        if (callerSubject.type !== "user") {
          return {
            content: [
              {
                text: JSON.stringify({
                  error: "Unauthorized",
                  message:
                    "Only authenticated human users can reject proposals with operational overrides.",
                }),
                type: "text",
              },
            ],
            isError: true,
          };
        }

        const proposalId = String(args.proposalId);
        const override = yield* inbox.rejectProposal(
          proposalId,
          callerSubject,
          String(args.category ?? "operational_override") as OverrideCategory,
          String(args.reason)
        );

        return {
          content: [
            {
              text: JSON.stringify(
                {
                  overrideRecordId: override.id,
                  status: "VETOED",
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      if (name === "operon_check_readiness") {
        const typeId = String(args.typeId) as ObjectTypeId;
        const objectId = String(args.objectId);
        const obj = yield* objectStore.getObject(typeId, objectId);
        const objType = objectTypeMap.get(typeId);

        if (!obj || !objType) {
          return {
            content: [
              {
                text: `Object or type not found: ${typeId}/${objectId}`,
                type: "text",
              },
            ],
            isError: true,
          };
        }

        const readiness = evaluateDecisionReadiness(obj, objType);
        return {
          content: [
            {
              text: JSON.stringify(
                {
                  objectId,
                  typeId,
                  decisionReadiness: readiness,
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      if (name === "operon_apply_definition_artifact") {
        const branch = String(args.branch);
        const artifact = args.artifact as any;
        const expectedRevision =
          typeof args.expectedRevision === "number"
            ? args.expectedRevision
            : undefined;
        const idempotencyKey = args.idempotencyKey
          ? String(args.idempotencyKey)
          : undefined;

        const receipt = yield* oms.applyArtifact({
          artifact,
          branch,
          expectedRevision,
          idempotencyKey,
        });

        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_inspect_candidate") {
        const candidateDigest = String(args.candidateDigest);
        const candidate = yield* oms.inspectCandidate(candidateDigest);
        return {
          content: [{ text: JSON.stringify(candidate, null, 2), type: "text" }],
        };
      }

      if (name === "operon_diff_candidate") {
        const candidateDigest = String(args.candidateDigest);
        const diff = yield* oms.diffCandidate(candidateDigest);
        return {
          content: [{ text: JSON.stringify(diff, null, 2), type: "text" }],
        };
      }

      if (name === "operon_publish_release") {
        const candidateDigest = String(args.candidateDigest);
        const expectedCurrentRelease = args.expectedCurrentRelease as any;
        const reviewRefs = Array.isArray(args.reviewRefs)
          ? args.reviewRefs.map(String)
          : [];
        const idempotencyKey = args.idempotencyKey
          ? String(args.idempotencyKey)
          : undefined;
        const publisherId = args.publisherId
          ? String(args.publisherId)
          : callerSubject.id;

        const publisher: Subject = {
          id: publisherId,
          name: publisherId.toUpperCase(),
          roles: ["lead_architect"],
          type: "user",
        };

        const pubReceipt = yield* oms.publishRelease({
          candidateDigest,
          expectedCurrentRelease,
          idempotencyKey,
          publisher,
          reviewRefs,
        });

        return {
          content: [
            { text: JSON.stringify(pubReceipt, null, 2), type: "text" },
          ],
        };
      }

      if (name === "operon_get_publication") {
        const publicationId = args.publicationId
          ? String(args.publicationId)
          : undefined;
        const idempotencyKey = args.idempotencyKey
          ? String(args.idempotencyKey)
          : undefined;

        const pubReceipt = yield* oms.getPublication({
          idempotencyKey,
          publicationId,
        });

        return {
          content: [
            { text: JSON.stringify(pubReceipt, null, 2), type: "text" },
          ],
        };
      }

      if (name === "operon_get_active_release") {
        const activeRelease = yield* oms.getActiveRelease();
        return {
          content: [
            { text: JSON.stringify(activeRelease, null, 2), type: "text" },
          ],
        };
      }

      if (name === "operon_list_skills") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const skills = yield* skillService.listSkills();
        return {
          content: [{ text: JSON.stringify(skills, null, 2), type: "text" }],
        };
      }

      if (name === "operon_get_skill") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const skill = yield* skillService.getSkill(String(args.skillId));
        return {
          content: [{ text: JSON.stringify(skill, null, 2), type: "text" }],
        };
      }

      if (name === "operon_list_recipes") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const recipes = yield* recipeService.listRecipes();
        return {
          content: [{ text: JSON.stringify(recipes, null, 2), type: "text" }],
        };
      }

      if (name === "operon_get_recipe") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const recipe = yield* recipeService.getRecipe(String(args.recipeId));
        return {
          content: [{ text: JSON.stringify(recipe, null, 2), type: "text" }],
        };
      }

      if (name === "operon_import_recipe") {
        yield* checkMcpKeyPermission(callerKey, "modify_schema");
        const receipt = yield* recipeService.importRecipe(
          args.pack as RecipePack,
          skillService
        );
        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_ingest_source") {
        yield* checkMcpKeyPermission(callerKey, "modify_pipeline");
        const receipt = yield* ingestionService.ingestRawSource({
          environmentId: args.environmentId
            ? String(args.environmentId)
            : undefined,
          idempotencyKey: args.idempotencyKey
            ? String(args.idempotencyKey)
            : undefined,
          locator: String(args.locator),
          mediaType: String(args.mediaType),
          permittedUses: args.permittedUses as string[] | undefined,
          rawPayload: args.payload,
          sensitivity: args.sensitivity as any,
          tenantId: args.tenantId ? String(args.tenantId) : undefined,
        });
        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_get_source") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const source = yield* ingestionService.getSource(
          String(args.sourceId),
          args.tenantId ? String(args.tenantId) : undefined
        );
        return {
          content: [{ text: JSON.stringify(source, null, 2), type: "text" }],
        };
      }

      if (name === "operon_list_sources") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const sources = yield* ingestionService.listSources(
          args.tenantId ? String(args.tenantId) : undefined
        );
        return {
          content: [{ text: JSON.stringify(sources, null, 2), type: "text" }],
        };
      }

      if (name === "operon_propose_mapping") {
        yield* checkMcpKeyPermission(callerKey, "modify_schema");
        const proposal = yield* ingestionService.proposeMapping({
          author: callerSubject,
          definitionDigest: String(args.definitionDigest),
          primaryKeyField: String(args.primaryKeyField),
          propertyMappings: args.propertyMappings as any,
          sourceIds: args.sourceIds as string[],
          targetObjectTypeId: String(args.targetObjectTypeId) as ObjectTypeId,
          tenantId: args.tenantId ? String(args.tenantId) : undefined,
        });
        return {
          content: [{ text: JSON.stringify(proposal, null, 2), type: "text" }],
        };
      }

      if (name === "operon_admit_mapping_proposal") {
        yield* checkMcpKeyPermission(callerKey, "modify_schema");
        const admitted = yield* ingestionService.admitProposal(
          String(args.proposalId),
          callerSubject
        );
        return {
          content: [{ text: JSON.stringify(admitted, null, 2), type: "text" }],
        };
      }

      if (name === "operon_exact_query") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const queryId = String(args.queryId);
        const validTime = args.validTime ? Number(args.validTime) : Date.now();
        const knowledgeRevision = args.knowledgeRevision
          ? Number(args.knowledgeRevision)
          : 1;
        const tenantId = args.tenantId ? String(args.tenantId) : "default";
        const environmentId = args.environmentId
          ? String(args.environmentId)
          : "default";
        const releaseRef = args.releaseRef
          ? String(args.releaseRef)
          : "active-release";

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

        const result = yield* reconciliationService.query(
          {
            cursor: null,
            params: (args.params as Record<string, unknown>) ?? {},
            queryId,
            releaseRef,
            worldView,
          },
          objectStore,
          {
            maxStalenessMs: args.maxStalenessMs
              ? Number(args.maxStalenessMs)
              : undefined,
          }
        );

        return {
          content: [{ text: JSON.stringify(result, null, 2), type: "text" }],
        };
      }

      if (name === "operon_explain_query") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const plan = reconciliationService.explainQuery(
          String(args.typeId),
          String(args.objectId),
          Number(args.validTime),
          Number(args.txTime),
          (args.dialect as any) ?? "sqlite"
        );
        return {
          content: [{ text: JSON.stringify(plan, null, 2), type: "text" }],
        };
      }

      if (name === "operon_propose_identity_resolution") {
        yield* checkMcpKeyPermission(callerKey, "modify_schema");
        const proposalId = args.proposalId
          ? String(args.proposalId)
          : `res_prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const proposal = yield* reconciliationService.proposeIdentityResolution(
          {
            action: args.action as any,
            confidence: Number(args.confidence),
            environmentId: args.environmentId
              ? String(args.environmentId)
              : undefined,
            evidence: (args.evidence as any) ?? [],
            idempotencyKey: args.idempotencyKey
              ? String(args.idempotencyKey)
              : undefined,
            proposalId,
            sourceKey: String(args.sourceKey),
            sourceSystem: String(args.sourceSystem),
            splitDetails: (args.splitDetails as any) ?? null,
            targetCanonicalId: String(args.targetCanonicalId),
            tenantId: args.tenantId ? String(args.tenantId) : undefined,
          }
        );
        return {
          content: [{ text: JSON.stringify(proposal, null, 2), type: "text" }],
        };
      }

      if (name === "operon_resolve_identity") {
        yield* checkMcpKeyPermission(callerKey, "modify_schema");
        const receipt = yield* reconciliationService.resolveIdentity(
          String(args.proposalId),
          String(args.decisionRef),
          {
            environmentId: args.environmentId
              ? String(args.environmentId)
              : undefined,
            forceOverride: Boolean(args.forceOverride),
            idempotencyKey: args.idempotencyKey
              ? String(args.idempotencyKey)
              : undefined,
            tenantId: args.tenantId ? String(args.tenantId) : undefined,
          }
        );
        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_list_identity_proposals") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const proposals = yield* reconciliationService.listProposals(
          args.tenantId ? String(args.tenantId) : undefined
        );
        return {
          content: [{ text: JSON.stringify(proposals, null, 2), type: "text" }],
        };
      }

      if (name === "operon_prepare_action") {
        yield* checkMcpKeyPermission(callerKey, "execute_action");
        const proposer: Subject = {
          agentTier: args.proposerTier
            ? (Number(args.proposerTier) as 1 | 2 | 3 | 4)
            : callerKey.agentTier,
          id: args.proposerId ? String(args.proposerId) : callerKey.agentId,
          name: callerKey.name,
          roles: Array.isArray(args.proposerRoles)
            ? (args.proposerRoles as string[])
            : ["ai_agent"],
          type: (args.proposerType as "user" | "agent" | "system") || "agent",
        };

        const prepared = yield* governedActionService.prepareAction({
          actionId: String(args.actionId),
          environmentId: args.environmentId
            ? String(args.environmentId)
            : "default",
          grantId: args.grantId ? String(args.grantId) : undefined,
          proposer,
          rawParameters: args.parameters ?? {},
          tenantId: args.tenantId ? String(args.tenantId) : "default",
          ttlMs: args.ttlMs ? Number(args.ttlMs) : undefined,
        });

        return {
          content: [{ text: JSON.stringify(prepared, null, 2), type: "text" }],
        };
      }

      if (name === "operon_approve_prepared_action") {
        yield* checkMcpKeyPermission(callerKey, "execute_action");
        const reviewer: Subject = {
          agentTier: 4,
          id: args.reviewerId ? String(args.reviewerId) : callerKey.agentId,
          name: callerKey.name,
          roles: Array.isArray(args.reviewerRoles)
            ? (args.reviewerRoles as string[])
            : ["approver"],
          type: (args.reviewerType as "user" | "agent" | "system") || "user",
        };

        const approval = yield* governedActionService.approvePreparedAction({
          decision: (args.decision as "approved" | "rejected") || "approved",
          preparedDigest: String(args.preparedDigest),
          reason: args.reason ? String(args.reason) : undefined,
          reviewerContext: {
            assurance:
              (args.assurance as "human_verified" | "delegated_service") ||
              "human_verified",
            environmentId: args.environmentId
              ? String(args.environmentId)
              : "default",
            reviewer,
            tenantId: args.tenantId ? String(args.tenantId) : "default",
          },
          viewedDigest: String(args.viewedDigest),
        });

        return {
          content: [{ text: JSON.stringify(approval, null, 2), type: "text" }],
        };
      }

      if (name === "operon_commit_action") {
        yield* checkMcpKeyPermission(callerKey, "execute_action");
        const tenantId = args.tenantId ? String(args.tenantId) : "default";
        const environmentId = args.environmentId
          ? String(args.environmentId)
          : "default";
        const preparedDigest = String(args.preparedDigest);
        const idempotencyKey = String(args.idempotencyKey);

        const prepared = yield* governedActionService.getPreparedAction(
          preparedDigest,
          tenantId
        );

        let approval = undefined;
        if (args.approvalId) {
          approval = yield* governedActionService.getApprovalRecord(
            String(args.approvalId),
            tenantId
          );
        }

        const receipt = yield* atomicCommitService.commit({
          approval,
          environmentId,
          idempotencyKey,
          prepared,
          tenantId,
        });

        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_get_action_status") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const tenantId = args.tenantId ? String(args.tenantId) : "default";
        const operationId = String(args.operationId);

        const operation = yield* atomicCommitService.getOperation(
          operationId,
          tenantId
        );

        if (!operation) {
          return {
            content: [
              { text: `Operation '${operationId}' not found`, type: "text" },
            ],
            isError: true,
          };
        }

        return {
          content: [{ text: JSON.stringify(operation, null, 2), type: "text" }],
        };
      }

      if (name === "operon_generate_view") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const view = generateDisposableAppView({
          audience: args.audience ? String(args.audience) : undefined,
          data: args.data as any,
          format: args.format as any,
          state: (args.state as any) ?? "CONFIRMED",
          title: String(args.title),
        });

        return {
          content: [{ text: JSON.stringify(view, null, 2), type: "text" }],
        };
      }

      if (name === "operon_assurance_evaluate_f1") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const receipt = yield* f1Evaluator.evaluate({
          candidateDigest: String(args.candidateDigest),
          candidateId: String(args.candidateId),
          catalogDigest: String(args.catalogDigest),
          catalogId: String(args.catalogId),
          idempotencyKey: args.idempotencyKey
            ? String(args.idempotencyKey)
            : undefined,
          profile: (args.profile as any) ?? "local",
          testCases: (args.testCases as any) ?? [],
        });
        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_assurance_mirror_f2") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const receipt = yield* f2Mirror.evaluateMirror({
          candidateDigest: String(args.candidateDigest),
          claim: (args.claim as any) ?? "observed-action",
          companyEvidenceRef: String(args.companyEvidenceRef),
          consentScope: args.consentScope as any,
          corrections: (args.corrections as any) ?? [],
          idempotencyKey: args.idempotencyKey
            ? String(args.idempotencyKey)
            : undefined,
          participantId: String(args.participantId),
          profileDigest: String(args.profileDigest),
          rubricDigest: String(args.rubricDigest),
        });
        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_assurance_scan_publication") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const targetDir = args.targetDirectory
          ? String(args.targetDirectory)
          : process.cwd();
        const scanRes = yield* publicationBoundary.scanDirectory(targetDir, {
          allowedPublicOnly: args.allowedPublicOnly === true,
        });
        return {
          content: [{ text: JSON.stringify(scanRes, null, 2), type: "text" }],
        };
      }

      if (name === "operon_assurance_verify_receipt") {
        yield* checkMcpKeyPermission(callerKey, "query_runtime");
        const rcpt = args.receipt as any;
        let isValid = false;
        if (rcpt.outcome) {
          isValid = yield* f1Evaluator.verifyReceipt(rcpt);
        } else if (rcpt.claim) {
          isValid = yield* f2Mirror.verifyReceipt(rcpt);
        }
        return {
          content: [
            { text: JSON.stringify({ isValid }, null, 2), type: "text" },
          ],
        };
      }

      // Check if it's an action tool (starts with operon_)
      const actionId = name.startsWith("operon_")
        ? name.replace("operon_", "")
        : name;
      const action = actionMap.get(actionId);

      if (action) {
        yield* checkMcpKeyPermission(callerKey, "execute_action");
        const agentSubject: Subject = {
          agentTier: callerKey.agentTier,
          id: callerKey.agentId,
          name: callerKey.name,
          roles: ["ai_agent"],
          type: "agent",
        };

        const result = yield* executeWritePipeline(
          {
            actionType: action,
            rawParameters: args,
            security: {
              correlationId: `mcp-${Date.now()}`,
              subject: agentSubject,
              timestamp: Date.now(),
            },
          },
          objectStore,
          auditStore
        );

        if (result.status === "proposed") {
          inbox.addProposal(
            {
              actionType: action,
              rawParameters: args,
              security: {
                correlationId: `mcp-${Date.now()}`,
                subject: agentSubject,
                timestamp: Date.now(),
              },
            },
            result.decisionRecord
          );

          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    decisionRecordId: result.decisionRecord.id,
                    message:
                      "Action was successfully routed to the Human Action Inbox for review and confirmation.",
                    proposalId: result.proposalId,
                    status: "PROPOSAL_CREATED",
                  },
                  null,
                  2
                ),
                type: "text",
              },
            ],
          };
        }

        return {
          content: [
            {
              text: JSON.stringify(
                {
                  status: "EXECUTED",
                  decisionRecordId: result.decisionRecord.id,
                  recordHash: result.decisionRecord.recordHash,
                  updatedCount: result.updatedObjects.length,
                },
                null,
                2
              ),
              type: "text",
            },
          ],
        };
      }

      return {
        content: [{ text: `Unknown tool: ${name}`, type: "text" }],
        isError: true,
      };
    });

    return Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(executeTool());
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }

        const failReason = exit.cause.reasons.find(Cause.isFailReason);
        if (failReason) {
          const failure = failReason.error;
          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    details: (failure as any)?.details ?? undefined,
                    error:
                      (failure as any)?._tag ??
                      (failure as any)?.name ??
                      "ExecutionError",
                    message: (failure as any)?.message ?? String(failure),
                  },
                  null,
                  2
                ),
                type: "text" as const,
              },
            ],
            isError: true,
          };
        }

        const dieReason = exit.cause.reasons.find(Cause.isDieReason);
        return {
          content: [
            {
              text: JSON.stringify(
                {
                  error: "ExecutionDefect",
                  message: dieReason
                    ? String(dieReason.defect)
                    : Cause.pretty(exit.cause),
                },
                null,
                2
              ),
              type: "text" as const,
            },
          ],
          isError: true,
        };
      })
    );
  });

  return server;
}
