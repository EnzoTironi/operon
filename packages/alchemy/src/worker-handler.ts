import type {
  ActionInbox,
  AuditStore,
  HttpAuthMiddleware,
  ObjectStore,
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
import { Effect } from "effect";

export interface OperonWorkerContext {
  readonly objectTypes: readonly ObjectType[];
  readonly actionTypes: readonly ActionType[];
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly inbox: ActionInbox;
  readonly authMiddleware?: HttpAuthMiddleware;
}

async function authenticateRequest(
  request: Request,
  authMiddleware?: HttpAuthMiddleware
): Promise<{ subject: Subject; clientIp?: string } | { error: Response }> {
  const authHeader = request.headers.get("authorization") ?? undefined;
  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for") ??
    undefined;

  if (!authHeader) {
    return {
      error: Response.json(
        {
          error: "Unauthorized",
          message: "Missing Authorization header (Bearer token required)",
        },
        { status: 401 }
      ),
    };
  }

  if (authMiddleware) {
    const authResult = await Effect.runPromise(
      authMiddleware
        .authenticateHeader(authHeader, clientIp)
        .pipe(Effect.result)
    );
    if (authResult._tag === "Failure") {
      return {
        error: Response.json(
          {
            error: "Unauthorized",
            message: "Authentication verification failed",
            reason: (authResult.failure as any).reason,
          },
          { status: 401 }
        ),
      };
    }
    return { clientIp, subject: authResult.success.subject };
  }

  // Unverified credentials are never accepted without configured authMiddleware
  return {
    error: Response.json(
      {
        error: "Unauthorized",
        message:
          "No authentication verifier configured; unverified credentials rejected",
      },
      { status: 401 }
    ),
  };
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
    const url = new URL(request.url);
    const { pathname } = url;

    // Healthcheck
    if (pathname === "/health" || pathname === "/") {
      return Response.json({
        service: "operon-runtime",
        status: "ok",
        timestamp: Date.now(),
      });
    }

    // 4C Decision Readiness Check
    if (pathname.startsWith("/api/readiness/") && request.method === "GET") {
      const parts = pathname.replace("/api/readiness/", "").split("/");
      const [typeIdStr, objectId] = parts;
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

    // Action Submission (7-step write pipeline) - Strictly Authenticated
    if (pathname === "/api/actions/submit" && request.method === "POST") {
      const auth = await authenticateRequest(request, ctx.authMiddleware);
      if ("error" in auth) {
        return auth.error;
      }

      const bodyResult = await Effect.runPromise(
        Effect.tryPromise({
          try: () => request.json() as Promise<Record<string, unknown>>,
          catch: (err) => err,
        }).pipe(Effect.exit)
      );

      if (bodyResult._tag === "Failure") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const body = bodyResult.value;
      const actionTypeId = String(body.actionTypeId);
      const action = actionMap.get(actionTypeId);

      if (!action) {
        return Response.json(
          { error: `ActionType '${actionTypeId}' not found` },
          { status: 404 }
        );
      }

      // Use ONLY the authenticated subject from verified token; body.subject is strictly ignored
      const verifiedSubject: Subject = auth.subject;

      return await Effect.runPromise(
        executeWritePipeline(
          {
            actionType: action,
            rawParameters: body.parameters,
            security: {
              clientIp: auth.clientIp,
              correlationId: String(body.correlationId ?? `req-${Date.now()}`),
              subject: verifiedSubject,
              timestamp: Date.now(),
            },
          },
          ctx.objectStore,
          ctx.auditStore
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.status === "proposed") {
                ctx.inbox.addProposal(
                  {
                    actionType: action,
                    rawParameters: body.parameters,
                    security: {
                      clientIp: auth.clientIp,
                      correlationId: String(
                        body.correlationId ?? `req-${Date.now()}`
                      ),
                      subject: verifiedSubject,
                      timestamp: Date.now(),
                    },
                  },
                  result.decisionRecord
                );
              }
            })
          ),
          Effect.map((result) => Response.json(result, { status: 200 })),
          Effect.catch((error: unknown) => {
            const err = error as {
              details?: unknown;
              message?: string;
              name?: string;
            };
            return Effect.succeed(
              Response.json(
                {
                  details: err.details,
                  error: err.name ?? "ExecutionError",
                  message: err.message ?? String(error),
                },
                { status: 400 }
              )
            );
          }),
          Effect.catchDefect((defect: unknown) => {
            const err = defect as {
              details?: unknown;
              message?: string;
              name?: string;
            };
            return Effect.succeed(
              Response.json(
                {
                  details: err?.details,
                  error: err?.name ?? "ExecutionError",
                  message: err?.message ?? String(defect),
                },
                { status: 400 }
              )
            );
          })
        )
      );
    }

    // Action Inbox: List Pending - Strictly Authenticated
    if (pathname === "/api/inbox/pending" && request.method === "GET") {
      const auth = await authenticateRequest(request, ctx.authMiddleware);
      if ("error" in auth) {
        return auth.error;
      }

      const pending = ctx.inbox.getPendingProposals();
      return Response.json({ count: pending.length, proposals: pending });
    }

    // Action Inbox: Approve Proposal - Strictly Authenticated
    if (
      pathname.startsWith("/api/inbox/") &&
      pathname.endsWith("/approve") &&
      request.method === "POST"
    ) {
      const auth = await authenticateRequest(request, ctx.authMiddleware);
      if ("error" in auth) {
        return auth.error;
      }

      const proposalId = pathname
        .replace("/api/inbox/", "")
        .replace("/approve", "");

      // Verify human operator status and approver capabilities
      const approverSubject = auth.subject;

      return await Effect.runPromise(
        ctx.inbox.approveProposal(proposalId, approverSubject).pipe(
          Effect.map((approved) =>
            Response.json({ decisionRecord: approved, status: "APPROVED" })
          ),
          Effect.catch((error: unknown) => {
            const err = error as Error;
            const statusCode =
              (err as any)._tag === "AuthorizationError" ? 403 : 400;
            return Effect.succeed(
              Response.json(
                { error: err.message ?? String(error) },
                { status: statusCode }
              )
            );
          }),
          Effect.catchDefect((defect: unknown) => {
            const err = defect as Error;
            const statusCode =
              (err as any)?._tag === "AuthorizationError" ? 403 : 400;
            return Effect.succeed(
              Response.json(
                { error: err?.message ?? String(defect) },
                { status: statusCode }
              )
            );
          })
        )
      );
    }

    // Action Inbox: Reject / Veto Proposal (First-Class Override) - Strictly Authenticated
    if (
      pathname.startsWith("/api/inbox/") &&
      pathname.endsWith("/reject") &&
      request.method === "POST"
    ) {
      const auth = await authenticateRequest(request, ctx.authMiddleware);
      if ("error" in auth) {
        return auth.error;
      }

      const proposalId = pathname
        .replace("/api/inbox/", "")
        .replace("/reject", "");
      const body = (await request.json()) as Record<string, unknown>;
      const humanSubject = auth.subject;

      return await Effect.runPromise(
        ctx.inbox
          .rejectProposal(
            proposalId,
            humanSubject,
            (body.category as any) ?? "operational_override",
            String(body.reason ?? "Rejected by frontline operator")
          )
          .pipe(
            Effect.map((override) =>
              Response.json({ overrideRecord: override, status: "VETOED" })
            ),
            Effect.catch((error: unknown) => {
              const err = error as Error;
              const statusCode =
                (err as any)._tag === "AuthorizationError" ? 403 : 400;
              return Effect.succeed(
                Response.json(
                  { error: err.message ?? String(error) },
                  { status: statusCode }
                )
              );
            }),
            Effect.catchDefect((defect: unknown) => {
              const err = defect as Error;
              const statusCode =
                (err as any)?._tag === "AuthorizationError" ? 403 : 400;
              return Effect.succeed(
                Response.json(
                  { error: err?.message ?? String(defect) },
                  { status: statusCode }
                )
              );
            })
          )
      );
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  };
}
