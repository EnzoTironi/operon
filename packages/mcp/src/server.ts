import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AuditStore,
  DynamicSecurityEngine,
  ObjectStore,
  OverrideCategory,
} from "@operon/runtime";
import {
  ActionInbox,
  evaluateDecisionReadiness,
  executeWritePipeline,
  OntologyMetadataService,
} from "@operon/runtime";
import type {
  ActionType,
  ObjectType,
  ObjectTypeId,
  Subject,
} from "@operon/schema";
import { Effect } from "effect";

import type { McpKey } from "./keys.js";
import { assertMcpKeyPermission } from "./keys.js";
import { projectActionToTool } from "./projection.js";

export interface OperonMcpServerOptions {
  readonly objectTypes: readonly ObjectType[];
  readonly actionTypes: readonly ActionType[];
  readonly objectStore: ObjectStore;
  readonly auditStore: AuditStore;
  readonly inbox?: ActionInbox;
  readonly oms?: OntologyMetadataService;
  readonly securityEngine?: DynamicSecurityEngine;
  readonly defaultCallerKey?: McpKey;
}

export function createOperonMcpServer(options: OperonMcpServerOptions) {
  const {
    objectTypes,
    actionTypes,
    objectStore,
    auditStore,
    securityEngine,
    defaultCallerKey,
  } = options;

  const inbox = options.inbox ?? new ActionInbox(auditStore, objectStore);
  const oms = options.oms ?? new OntologyMetadataService();

  const server = new Server(
    {
      name: "operon-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
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

  // Handler: Call Tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

    try {
      assertMcpKeyPermission(callerKey, "execute_action");

      if (name === "operon_query_objects") {
        const typeId = String(args.typeId) as ObjectTypeId;
        let objects = await Effect.runPromise(objectStore.findObjects(typeId));

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
        let obj = await Effect.runPromise(
          objectStore.getObject(typeId, objectId)
        );

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
        const decisionRecord = await Effect.runPromise(
          inbox.approveProposal(proposalId, callerSubject)
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
        const override = await Effect.runPromise(
          inbox.rejectProposal(
            proposalId,
            callerSubject,
            String(args.category ?? "operational_override") as OverrideCategory,
            String(args.reason)
          )
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
        const obj = await Effect.runPromise(
          objectStore.getObject(typeId, objectId)
        );
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

        const receipt = await Effect.runPromise(
          oms.applyArtifact({
            artifact,
            branch,
            expectedRevision,
            idempotencyKey,
          })
        );

        return {
          content: [{ text: JSON.stringify(receipt, null, 2), type: "text" }],
        };
      }

      if (name === "operon_inspect_candidate") {
        const candidateDigest = String(args.candidateDigest);
        const candidate = await Effect.runPromise(
          oms.inspectCandidate(candidateDigest)
        );
        return {
          content: [{ text: JSON.stringify(candidate, null, 2), type: "text" }],
        };
      }

      if (name === "operon_diff_candidate") {
        const candidateDigest = String(args.candidateDigest);
        const diff = await Effect.runPromise(
          oms.diffCandidate(candidateDigest)
        );
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

        const pubReceipt = await Effect.runPromise(
          oms.publishRelease({
            candidateDigest,
            expectedCurrentRelease,
            idempotencyKey,
            publisher,
            reviewRefs,
          })
        );

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

        const pubReceipt = await Effect.runPromise(
          oms.getPublication({
            idempotencyKey,
            publicationId,
          })
        );

        return {
          content: [
            { text: JSON.stringify(pubReceipt, null, 2), type: "text" },
          ],
        };
      }

      if (name === "operon_get_active_release") {
        const activeRelease = await Effect.runPromise(oms.getActiveRelease());
        return {
          content: [
            { text: JSON.stringify(activeRelease, null, 2), type: "text" },
          ],
        };
      }

      // Check if it's an action tool (starts with operon_)
      const actionId = name.startsWith("operon_")
        ? name.replace("operon_", "")
        : name;
      const action = actionMap.get(actionId);

      if (action) {
        const agentSubject: Subject = {
          agentTier: callerKey.agentTier,
          id: callerKey.agentId,
          name: callerKey.name,
          roles: ["ai_agent"],
          type: "agent",
        };

        const result = await Effect.runPromise(
          executeWritePipeline(
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
          )
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
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error.name ?? "ExecutionError",
                message: error.message ?? String(error),
                details: error.details ?? undefined,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
