import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  F1EvaluatorService,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import { BUILTIN_RECIPES, RecipeService } from "@operon/recipes";
import type { RecipeRegistryService } from "@operon/recipes";
import type {
  AuditStore,
  DynamicSecurityEngine,
  ObjectStore,
  OntologyMetadataService,
  OperonService,
} from "@operon/runtime";
import {
  AccountableIngestionService,
  ActionInbox,
  AtomicCommitService,
  AuthorityService,
  GovernedActionService,
  OperonServiceImpl,
  ReconciliationService,
} from "@operon/runtime";
import { serializeJson } from "@operon/schema";
import type {
  ActionParameters,
  ActionType,
  ObjectType,
  Subject,
} from "@operon/schema";
import { BUILTIN_SKILLS, SkillService } from "@operon/skills";
import type { SkillRegistryService } from "@operon/skills";
import { Cause, Data, Effect, Exit, Predicate } from "effect";

import type { McpKey } from "./keys.js";
import { projectActionToTool } from "./projection.js";
import type {
  ToolCallResult,
  ToolExecutionContext,
} from "./server-handlers.js";
import {
  handleDynamicAction,
  STANDARD_TOOL_HANDLERS,
} from "./server-handlers.js";
import { STANDARD_TOOL_DEFINITIONS } from "./standard-tools.js";

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

interface ToolExecutionDeps {
  readonly actionMap: Map<string, ActionType>;
  readonly objectTypeMap: Map<string, ObjectType>;
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
  readonly defaultCallerKey?: McpKey;
}

function resolveSkillService(
  service?: SkillRegistryService
): SkillRegistryService {
  if (service) {
    return service;
  }
  const s = SkillService.make();
  for (const skill of BUILTIN_SKILLS) {
    Effect.runSync(s.registerSkill(skill));
  }
  return s;
}

function resolveRecipeService(
  service?: RecipeRegistryService
): RecipeRegistryService {
  if (service) {
    return service;
  }
  const r = RecipeService.make();
  for (const recipe of BUILTIN_RECIPES) {
    Effect.runSync(r.registerRecipe(recipe));
  }
  return r;
}

function resolveExecutionServices(
  options: OperonMcpServerOptions,
  authorityService: AuthorityService,
  actionTypesMap: Map<string, ActionType>
) {
  const governedActionService =
    options.governedActionService ??
    new GovernedActionService(
      options.actionTypes,
      options.objectStore,
      authorityService
    );

  const atomicCommitService =
    options.atomicCommitService ??
    new AtomicCommitService({
      actionTypes: actionTypesMap,
      auditStore: options.auditStore,
      authorityService,
      objectStore: options.objectStore,
    });

  return { atomicCommitService, governedActionService };
}

function resolveAssuranceServices(options: OperonMcpServerOptions) {
  const f1Evaluator = options.f1Evaluator ?? new F1EvaluatorService();
  const f2Mirror = options.f2Mirror ?? new F2MirrorService();
  const publicationBoundary =
    options.publicationBoundary ?? new PublicationBoundaryService();
  return { f1Evaluator, f2Mirror, publicationBoundary };
}

function resolveOperonService(
  options: OperonMcpServerOptions,
  deps: {
    governedActionService: GovernedActionService;
    atomicCommitService: AtomicCommitService;
    authorityService: AuthorityService;
    reconciliationService: ReconciliationService;
    f1Evaluator: F1EvaluatorService;
    f2Mirror: F2MirrorService;
    publicationBoundary: PublicationBoundaryService;
  }
): OperonService {
  if (options.operonService) {
    return options.operonService;
  }
  return new OperonServiceImpl({
    atomicCommitService: deps.atomicCommitService,
    authorityService: deps.authorityService,
    f1Evaluator: deps.f1Evaluator,
    f2Mirror: deps.f2Mirror,
    governedActionService: deps.governedActionService,
    objectStore: options.objectStore,
    publicationBoundary: deps.publicationBoundary,
    reconciliationService: deps.reconciliationService,
  });
}

function resolveCallerKey(defaultCallerKey?: McpKey): McpKey {
  if (defaultCallerKey) {
    return defaultCallerKey;
  }
  return {
    agentId: "agent-mcp-session",
    agentTier: 2,
    keyId: "mcp-agent-key-1",
    name: "AutonomousAgent",
    role: "consumer",
  };
}

function indexById<T extends { readonly id: string }>(
  items: readonly T[]
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

function indexActions(actions: readonly ActionType[]): Map<string, ActionType> {
  const map = new Map<string, ActionType>();
  for (const a of actions) {
    map.set(a.id, a);
    map.set(`operon_${a.id}`, a);
  }
  return map;
}

function executeTool(
  name: string,
  ctx: ToolExecutionContext
): Effect.Effect<ToolCallResult, unknown> {
  const standardHandler = STANDARD_TOOL_HANDLERS.get(name);
  if (standardHandler) {
    return standardHandler(ctx);
  }
  const action = ctx.actionMap.get(name);
  if (action) {
    return handleDynamicAction(action, ctx);
  }
  return Effect.succeed({
    content: [{ text: `Unknown tool: ${name}`, type: "text" }],
    isError: true,
  });
}

interface FailureInfo {
  readonly details?: unknown;
  readonly error: string;
  readonly message: string;
}

function extractFailureRecord(cause: unknown): FailureInfo {
  if (Predicate.isObject(cause)) {
    // SAFETY: narrowed to object by Predicate.isObject
    const errorRecord = cause as {
      readonly _tag?: string;
      readonly name?: string;
      readonly message?: string;
      readonly details?: unknown;
    };
    const error = errorRecord._tag ?? errorRecord.name ?? "ExecutionError";
    const message = errorRecord.message ?? String(cause);
    return {
      details: errorRecord.details,
      error,
      message,
    };
  }
  return {
    error: "ExecutionError",
    message: String(cause),
  };
}

function formatFailFailure(cause: unknown): ToolCallResult {
  const info = extractFailureRecord(cause);
  return {
    content: [
      {
        text: JSON.stringify(info, null, 2),
        type: "text",
      },
    ],
    isError: true,
  };
}

function formatDieFailure(cause: Cause.Cause<unknown>): ToolCallResult {
  const dieReason = cause.reasons.find(Cause.isDieReason);
  const message = dieReason ? String(dieReason.defect) : Cause.pretty(cause);
  return {
    content: [
      {
        text: JSON.stringify({ error: "ExecutionDefect", message }, null, 2),
        type: "text",
      },
    ],
    isError: true,
  };
}

function formatToolFailure(cause: Cause.Cause<unknown>): ToolCallResult {
  const failReason = cause.reasons.find(Cause.isFailReason);
  if (failReason) {
    return formatFailFailure(failReason.error);
  }
  return formatDieFailure(cause);
}

function registerListToolsHandler(
  server: Server,
  actionTypes: readonly ActionType[]
) {
  server.setRequestHandler(ListToolsRequestSchema, (_request) => {
    const actionTools = actionTypes.map(projectActionToTool).map((t) => ({
      description: t.description,
      inputSchema: t.inputSchema,
      name: t.name,
    }));

    return Promise.resolve({
      tools: [...STANDARD_TOOL_DEFINITIONS, ...actionTools],
    });
  });
}

function registerResourceHandlers(
  server: Server,
  skillService: SkillRegistryService,
  recipeService: RecipeRegistryService
) {
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
                text: serializeJson(skill),
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
                text: serializeJson(recipe),
                uri,
              },
            ],
          };
        }

        return yield* new McpResourceNotFoundError({ uri });
      })
    )
  );
}

function registerCallToolHandler(server: Server, deps: ToolExecutionDeps) {
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params.name;
    // SAFETY: request parameters parsed as ActionParameters (Record<string, Schema.Json>)
    const args = (request.params.arguments ?? {}) as ActionParameters;
    const callerKey = resolveCallerKey(deps.defaultCallerKey);
    const callerSubject: Subject = {
      agentTier: callerKey.agentTier,
      id: callerKey.agentId,
      name: callerKey.name,
      roles: ["ai_agent"],
      type: "agent",
    };

    const ctx: ToolExecutionContext = {
      ...deps,
      args,
      callerKey,
      callerSubject,
      name,
    };

    // SAFETY: tool execution returns compliant MCP CallToolResult structure
    return Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(executeTool(name, ctx));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return formatToolFailure(exit.cause);
      })
    ) as Promise<CallToolResult>;
  });
}

export function createOperonMcpServer(options: OperonMcpServerOptions) {
  const {
    actionTypes,
    auditStore,
    defaultCallerKey,
    objectStore,
    objectTypes,
    oms,
    securityEngine,
  } = options;

  const inbox = options.inbox ?? new ActionInbox(auditStore, objectStore);
  const skillService = resolveSkillService(options.skillService);
  const recipeService = resolveRecipeService(options.recipeService);
  const ingestionService =
    options.ingestionService ?? new AccountableIngestionService(objectStore);
  const reconciliationService =
    options.reconciliationService ?? ReconciliationService.make();
  const authorityService = options.authorityService ?? new AuthorityService();

  const actionTypesMap = indexActions(actionTypes);
  const objectTypeMap = indexById(objectTypes);

  const { atomicCommitService, governedActionService } =
    resolveExecutionServices(options, authorityService, actionTypesMap);

  const { f1Evaluator, f2Mirror, publicationBoundary } =
    resolveAssuranceServices(options);

  const operonService = resolveOperonService(options, {
    atomicCommitService,
    authorityService,
    f1Evaluator,
    f2Mirror,
    governedActionService,
    publicationBoundary,
    reconciliationService,
  });

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

  registerListToolsHandler(server, actionTypes);
  registerResourceHandlers(server, skillService, recipeService);
  registerCallToolHandler(server, {
    actionMap: actionTypesMap,
    atomicCommitService,
    auditStore,
    authorityService,
    defaultCallerKey,
    f1Evaluator,
    f2Mirror,
    governedActionService,
    inbox,
    ingestionService,
    objectStore,
    objectTypeMap,
    oms,
    operonService,
    publicationBoundary,
    recipeService,
    reconciliationService,
    securityEngine,
    skillService,
  });

  return server;
}
