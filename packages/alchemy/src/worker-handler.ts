import type {
  ActionExecutionResult,
  ActionInbox,
  AuditStore,
  HttpAuthMiddleware,
  ObjectStore,
  OverrideCategory,
} from "@operon/runtime";
import {
  evaluateDecisionReadiness,
  executeWritePipeline,
} from "@operon/runtime";
import type {
  ActionType,
  ObjectType,
  ObjectTypeId,
  Subject,
} from "@operon/schema";
import { Cause, Clock, Effect, Exit, Option, Predicate } from "effect";
import type { Schema } from "effect";

export interface OperonWorkerContext {
  readonly objectTypes: readonly ObjectType[];
  readonly actionTypes: readonly ActionType[];
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly inbox: ActionInbox;
  readonly authMiddleware?: HttpAuthMiddleware;
}

interface ErrorInfo {
  readonly details?: unknown;
  readonly message?: string;
  readonly name?: string;
}

function formatExecutionError(cause: Cause.Cause<unknown>): Response {
  const errorOpt = Cause.findErrorOption(cause);
  if (Option.isSome(errorOpt) && Predicate.isObject(errorOpt.value)) {
    // SAFETY: extracted error value is an object with standard error attributes
    const err = errorOpt.value as ErrorInfo;
    return Response.json(
      {
        details: err.details,
        error: err.name ?? "ExecutionError",
        message: err.message ?? Cause.pretty(cause),
      },
      { status: 400 }
    );
  }
  return Response.json(
    {
      error: "ExecutionError",
      message: Cause.pretty(cause),
    },
    { status: 400 }
  );
}

function formatInboxError(cause: Cause.Cause<unknown>): Response {
  const errorOpt = Cause.findErrorOption(cause);
  const errorVal = Option.isSome(errorOpt) ? errorOpt.value : undefined;
  const statusCode = Predicate.isTagged(errorVal, "AuthorizationError")
    ? 403
    : 400;
  const message =
    Predicate.isObject(errorVal) &&
    "message" in errorVal &&
    Predicate.isString(errorVal.message)
      ? errorVal.message
      : Cause.pretty(cause);
  return Response.json({ error: message }, { status: statusCode });
}

function resolveClientIp(request: Request): string | undefined {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for") ??
    undefined
  );
}

function verifyWithMiddleware(
  authMiddleware: HttpAuthMiddleware,
  authHeader: string,
  clientIp?: string
): Promise<{ subject: Subject; clientIp?: string } | { error: Response }> {
  return Effect.runPromise(
    authMiddleware.authenticateHeader(authHeader, clientIp).pipe(
      Effect.map((securityContext) => ({
        clientIp,
        subject: securityContext.subject,
      })),
      Effect.catchCause((cause) => {
        const errorOpt = Cause.findErrorOption(cause);
        const reason = Option.isSome(errorOpt)
          ? errorOpt.value.reason
          : "Authentication verification failed";
        return Effect.succeed({
          error: Response.json(
            {
              error: "Unauthorized",
              message: "Authentication verification failed",
              reason,
            },
            { status: 401 }
          ),
        });
      })
    )
  );
}

function authenticateRequest(
  request: Request,
  authMiddleware?: HttpAuthMiddleware
): Promise<{ subject: Subject; clientIp?: string } | { error: Response }> {
  const authHeader = request.headers.get("authorization");
  const clientIp = resolveClientIp(request);

  if (!authHeader) {
    return Promise.resolve({
      error: Response.json(
        {
          error: "Unauthorized",
          message: "Missing Authorization header (Bearer token required)",
        },
        { status: 401 }
      ),
    });
  }

  if (authMiddleware) {
    return verifyWithMiddleware(authMiddleware, authHeader, clientIp);
  }

  return Promise.resolve({
    error: Response.json(
      {
        error: "Unauthorized",
        message:
          "No authentication verifier configured; unverified credentials rejected",
      },
      { status: 401 }
    ),
  });
}

function handleHealthCheck(pathname: string): Response | undefined {
  if (pathname === "/health" || pathname === "/") {
    return Response.json({
      service: "operon-runtime",
      status: "ok",
      timestamp: Date.now(),
    });
  }
  return undefined;
}

async function handleReadiness(
  pathname: string,
  method: string,
  ctx: OperonWorkerContext,
  objectTypeMap: Map<string, ObjectType>
): Promise<Response | undefined> {
  if (!pathname.startsWith("/api/readiness/") || method !== "GET") {
    return undefined;
  }

  const parts = pathname.replace("/api/readiness/", "").split("/");
  const [typeIdStr, objectId] = parts;
  // SAFETY: typeIdStr is parsed from the URL path parameter
  const typeId = typeIdStr as ObjectTypeId;

  const objType = objectTypeMap.get(typeId);
  if (!objType) {
    return Response.json(
      { error: `ObjectType '${typeId}' not registered` },
      { status: 404 }
    );
  }

  const obj = await Effect.runPromise(
    ctx.objectStore.getObject(typeId, objectId)
  );
  if (!obj) {
    return Response.json(
      { error: `Object '${objectId}' not found` },
      { status: 404 }
    );
  }

  const readiness = evaluateDecisionReadiness(obj, objType);
  return Response.json(readiness);
}

interface SubmitBody {
  readonly actionTypeId: string;
  readonly parameters?: Record<string, Schema.Json>;
  readonly correlationId?: string;
}

interface RawSubmitInput {
  readonly actionTypeId: string;
  readonly correlationId?: string;
  readonly parameters?: Record<string, Schema.Json>;
}

function isRawSubmitInput(input: unknown): input is RawSubmitInput {
  return (
    Predicate.isObject(input) &&
    "actionTypeId" in input &&
    Predicate.isString(input.actionTypeId)
  );
}

function extractCorrelationId(raw: RawSubmitInput): string | undefined {
  if (Predicate.isString(raw.correlationId)) {
    return raw.correlationId;
  }
  return undefined;
}

function extractParameters(
  raw: RawSubmitInput
): Record<string, Schema.Json> | undefined {
  if (Predicate.isObject(raw.parameters)) {
    // SAFETY: request parameters validated as an object structure
    return raw.parameters as Record<string, Schema.Json>;
  }
  return undefined;
}

async function extractSubmitBody(
  request: Request
): Promise<Option.Option<SubmitBody>> {
  const jsonExit = await Effect.runPromise(
    Effect.tryPromise({
      try: () => request.json(),
      catch: () => undefined,
    }).pipe(Effect.exit)
  );

  if (!Exit.isSuccess(jsonExit) || !isRawSubmitInput(jsonExit.value)) {
    return Option.none();
  }

  const raw = jsonExit.value;
  return Option.some({
    actionTypeId: raw.actionTypeId,
    correlationId: extractCorrelationId(raw),
    parameters: extractParameters(raw),
  });
}

async function handleSubmitAction(
  request: Request,
  ctx: OperonWorkerContext,
  actionMap: Map<string, ActionType>
): Promise<Response> {
  const auth = await authenticateRequest(request, ctx.authMiddleware);
  if ("error" in auth) {
    return auth.error;
  }

  const submitBodyOpt = await extractSubmitBody(request);
  if (Option.isNone(submitBodyOpt)) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const submitBody = submitBodyOpt.value;
  const action = actionMap.get(submitBody.actionTypeId);
  if (!action) {
    return Response.json(
      { error: `ActionType '${submitBody.actionTypeId}' not found` },
      { status: 404 }
    );
  }

  const verifiedSubject: Subject = auth.subject;
  const correlationId = submitBody.correlationId ?? `req-${Date.now()}`;

  const verifiedParameters = submitBody.parameters ?? {};

  const recordProposalIfProposed = Effect.fn("recordProposalIfProposed")(
    function* (result: ActionExecutionResult) {
      if (result.status === "proposed") {
        const now = yield* Clock.currentTimeMillis;
        ctx.inbox.addProposal(
          {
            actionType: action,
            rawParameters: verifiedParameters,
            security: {
              clientIp: auth.clientIp,
              correlationId,
              subject: verifiedSubject,
              timestamp: now,
            },
          },
          result.decisionRecord
        );
      }
    }
  );

  return await Effect.runPromise(
    executeWritePipeline(
      {
        actionType: action,
        rawParameters: verifiedParameters,
        security: {
          clientIp: auth.clientIp,
          correlationId,
          subject: verifiedSubject,
          timestamp: Date.now(),
        },
      },
      ctx.objectStore,
      ctx.auditStore
    ).pipe(
      Effect.tap(recordProposalIfProposed),
      Effect.map((result) => Response.json(result, { status: 200 })),
      Effect.catchCause((cause) => Effect.succeed(formatExecutionError(cause)))
    )
  );
}

async function handleInboxPending(
  request: Request,
  ctx: OperonWorkerContext
): Promise<Response> {
  const auth = await authenticateRequest(request, ctx.authMiddleware);
  if ("error" in auth) {
    return auth.error;
  }

  const pending = ctx.inbox.getPendingProposals();
  return Response.json({ count: pending.length, proposals: pending });
}

async function handleInboxApprove(
  request: Request,
  pathname: string,
  ctx: OperonWorkerContext
): Promise<Response> {
  const auth = await authenticateRequest(request, ctx.authMiddleware);
  if ("error" in auth) {
    return auth.error;
  }

  const proposalId = pathname
    .replace("/api/inbox/", "")
    .replace("/approve", "");

  return await Effect.runPromise(
    ctx.inbox.approveProposal(proposalId, auth.subject).pipe(
      Effect.map((approved) =>
        Response.json({ decisionRecord: approved, status: "APPROVED" })
      ),
      Effect.catchCause((cause) => Effect.succeed(formatInboxError(cause)))
    )
  );
}

const OVERRIDE_CATEGORIES = new Set<string>([
  "missing_evidence",
  "model_out_of_scope",
  "clinical_discretion",
  "operational_override",
  "safety_veto",
]);

function isOverrideCategory(category: unknown): category is OverrideCategory {
  return Predicate.isString(category) && OVERRIDE_CATEGORIES.has(category);
}

interface RawRejectInput {
  readonly category?: unknown;
  readonly reason?: unknown;
}

function isRawRejectInput(input: unknown): input is RawRejectInput {
  return Predicate.isObject(input);
}

function resolveRejectCategory(input: RawRejectInput): OverrideCategory {
  if (isOverrideCategory(input.category)) {
    return input.category;
  }
  return "operational_override";
}

function resolveRejectReason(input: RawRejectInput): string {
  if (Predicate.isString(input.reason)) {
    return input.reason;
  }
  return "Rejected by frontline operator";
}

interface RejectBody {
  readonly category: OverrideCategory;
  readonly reason: string;
}

async function parseRejectBody(request: Request): Promise<RejectBody> {
  const jsonExit = await Effect.runPromise(
    Effect.tryPromise({
      try: () => request.json(),
      catch: () => undefined,
    }).pipe(Effect.exit)
  );

  if (Exit.isSuccess(jsonExit) && isRawRejectInput(jsonExit.value)) {
    const raw = jsonExit.value;
    return {
      category: resolveRejectCategory(raw),
      reason: resolveRejectReason(raw),
    };
  }

  return {
    category: "operational_override",
    reason: "Rejected by frontline operator",
  };
}

async function handleInboxReject(
  request: Request,
  pathname: string,
  ctx: OperonWorkerContext
): Promise<Response> {
  const auth = await authenticateRequest(request, ctx.authMiddleware);
  if ("error" in auth) {
    return auth.error;
  }

  const proposalId = pathname.replace("/api/inbox/", "").replace("/reject", "");
  const rejectBody = await parseRejectBody(request);

  return await Effect.runPromise(
    ctx.inbox
      .rejectProposal(
        proposalId,
        auth.subject,
        rejectBody.category,
        rejectBody.reason
      )
      .pipe(
        Effect.map((override) =>
          Response.json({ overrideRecord: override, status: "VETOED" })
        ),
        Effect.catchCause((cause) => Effect.succeed(formatInboxError(cause)))
      )
  );
}

function routeInbox(
  request: Request,
  pathname: string,
  ctx: OperonWorkerContext
): Promise<Response> {
  if (request.method === "GET") {
    return handleInboxPending(request, ctx);
  }
  if (pathname.endsWith("/approve")) {
    return handleInboxApprove(request, pathname, ctx);
  }
  if (pathname.endsWith("/reject")) {
    return handleInboxReject(request, pathname, ctx);
  }
  return Promise.resolve(
    Response.json({ error: "Not Found" }, { status: 404 })
  );
}

function dispatchApi(
  request: Request,
  pathname: string,
  ctx: OperonWorkerContext,
  actionMap: Map<string, ActionType>
): Promise<Response> {
  if (pathname === "/api/actions/submit" && request.method === "POST") {
    return handleSubmitAction(request, ctx, actionMap);
  }
  if (pathname.startsWith("/api/inbox/")) {
    return routeInbox(request, pathname, ctx);
  }
  return Promise.resolve(
    Response.json({ error: "Not Found" }, { status: 404 })
  );
}

export function createWorkerFetchHandler(ctx: OperonWorkerContext) {
  const actionMap = new Map<string, ActionType>();
  for (const a of ctx.actionTypes) {
    actionMap.set(a.id, a);
  }

  const objectTypeMap = new Map<string, ObjectType>();
  for (const o of ctx.objectTypes) {
    objectTypeMap.set(o.id, o);
  }

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);

    const health = handleHealthCheck(pathname);
    if (health) {
      return health;
    }

    const readiness = await handleReadiness(
      pathname,
      request.method,
      ctx,
      objectTypeMap
    );
    if (readiness) {
      return readiness;
    }

    return dispatchApi(request, pathname, ctx, actionMap);
  };
}
