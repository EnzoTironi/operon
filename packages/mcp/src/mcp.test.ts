import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryAuditStore, InMemoryObjectStore } from "@operon/runtime";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { McpKey } from "./index.js";
import {
  assertBuilderKey,
  assertMcpKeyPermission,
  createOperonMcpServer,
  McpSecurityError,
  projectActionToTool,
  projectObjectTypeToGrounding,
} from "./index.js";

describe("@operon/mcp", () => {
  it("should enforce key boundaries between Consumer Key and Builder Key", () => {
    const consumerKey: McpKey = {
      agentId: "agent-1",
      agentTier: 2,
      keyId: "consumer-1",
      name: "AnalysisAgent",
      role: "consumer",
    };

    const builderKey: McpKey = {
      agentId: "dev-agent",
      agentTier: 4,
      keyId: "builder-1",
      name: "SchemaEngineer",
      role: "builder",
    };

    // Consumer key cannot modify schema or pipeline
    expect(() => assertMcpKeyPermission(consumerKey, "modify_schema")).toThrow(
      McpSecurityError
    );
    expect(() =>
      assertMcpKeyPermission(consumerKey, "modify_pipeline")
    ).toThrow(McpSecurityError);

    // Builder key cannot execute production actions
    expect(() => assertMcpKeyPermission(builderKey, "execute_action")).toThrow(
      McpSecurityError
    );

    // Legitimate permissions pass
    expect(() =>
      assertMcpKeyPermission(consumerKey, "execute_action")
    ).not.toThrow();
    expect(() =>
      assertMcpKeyPermission(consumerKey, "query_runtime")
    ).not.toThrow();
    expect(() =>
      assertMcpKeyPermission(builderKey, "modify_schema")
    ).not.toThrow();
    expect(() =>
      assertMcpKeyPermission(builderKey, "modify_pipeline")
    ).not.toThrow();

    // assertBuilderKey helper validation
    expect(() =>
      Effect.runSync(assertBuilderKey("bk_builder_secret"))
    ).not.toThrow();
    expect(() => Effect.runSync(assertBuilderKey(builderKey))).not.toThrow();
    expect(() =>
      Effect.runSync(assertBuilderKey("ck_consumer_secret"))
    ).toThrow(/Builder key required/u);
    expect(() => Effect.runSync(assertBuilderKey(consumerKey))).toThrow(
      /Builder key required/u
    );
  });

  it("should dynamically project Action cards and ObjectTypes into MCP schemas and groundings", () => {
    const TestAction = defineActionType({
      defaultExecutionMode: "proposal",
      description: "Adjust secondary clarifier return sludge valve percentage",
      id: "set_valve_position",
      minimumAgentTier: 2,
      name: "Set Valve Position",
      parametersSchema: Schema.Struct({
        openingPercent: Schema.Number,
        tankId: Schema.String,
      }),
      riskTier: "medium",
    });

    const projectedTool = projectActionToTool(TestAction);
    expect(projectedTool.name).toBe("operon_set_valve_position");
    expect(projectedTool.description).toContain(
      "clarifier return sludge valve"
    );
    expect(projectedTool.inputSchema.type).toBe("object");
    expect(projectedTool.inputSchema.properties.tankId).toBeDefined();

    // Project action with non-TypeLiteral schema (fallback path)
    const NonLiteralAction = defineActionType({
      defaultExecutionMode: "automated",
      description: "Generic untyped action",
      id: "generic_action",
      minimumAgentTier: 1,
      name: "Generic Action",
      parametersSchema: Schema.Unknown as any,
      riskTier: "low",
    });
    const projectedGeneric = projectActionToTool(NonLiteralAction);
    expect(projectedGeneric.inputSchema.properties.params).toBeDefined();

    // Project ObjectType into structured grounding prompt
    const TestObjectType = defineObjectType({
      description: "Water treatment tank",
      id: "ClarifierTank",
      name: "Clarifier Tank",
      primaryKey: "id",
      properties: {
        id: defineProperty({ description: "Tank ID", schema: Schema.String }),
        sludgeDepth: defineProperty({
          description: "Depth in meters",
          freshnessBudget: { maxStalenessMs: 120000, onStale: "warn" },
          schema: Schema.Number,
        }),
      },
      typology: "master",
    });
    const grounding = projectObjectTypeToGrounding(TestObjectType);
    expect(grounding).toContain(
      "### ObjectType: Clarifier Tank (ClarifierTank)"
    );
    expect(grounding).toContain("Max staleness: 120s");
  });

  it("should execute full MCP client-server protocol over InMemoryTransport with zero mocks", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();

    const PatientType = defineObjectType({
      description: "Hospital Inpatient",
      id: "Patient",
      name: "Patient",
      primaryKey: "patientId",
      properties: {
        name: defineProperty({
          schema: Schema.String,
          description: "Full Name",
        }),
        patientId: defineProperty({
          schema: Schema.String,
          description: "ID",
          required: true,
        }),
      },
      typology: "master",
    });

    await Effect.runPromise(
      objectStore.putObject({
        id: "P001",
        lastModifiedAt: Date.now(),
        properties: { name: "Zhang Minghua", patientId: "P001" },
        typeId: PatientType.id,
        version: 1,
      })
    );

    const ProposeAction = defineActionType({
      defaultExecutionMode: "proposal",
      description: "Adjust secondary clarifier valve",
      id: "set_valve_position",
      minimumAgentTier: 2,
      name: "Set Valve Position",
      parametersSchema: Schema.Struct({
        openingPercent: Schema.Number,
        tankId: Schema.String,
      }),
      riskTier: "medium",
    });

    const AutomatedAction = defineActionType({
      defaultExecutionMode: "automated",
      description: "Update patient vitals",
      id: "update_vitals",
      minimumAgentTier: 1,
      name: "Update Vitals",
      parametersSchema: Schema.Struct({
        heartRate: Schema.Number,
        patientId: Schema.String,
      }),
      riskTier: "low",
      targetObjectTypeId: "Patient",
    });

    const server = createOperonMcpServer({
      actionTypes: [ProposeAction, AutomatedAction],
      auditStore,
      defaultCallerKey: {
        agentId: "agent-tier4",
        agentTier: 4,
        keyId: "key-tier4",
        name: "Tier4Agent",
        role: "consumer",
      },
      objectStore,
      objectTypes: [PatientType],
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: "test-mcp-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    // 1. List tools: Should include standard tools and projected action tools
    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);
    expect(toolNames).toContain("operon_query_objects");
    expect(toolNames).toContain("operon_check_readiness");
    expect(toolNames).toContain("operon_set_valve_position");
    expect(toolNames).toContain("operon_update_vitals");

    // 2. Call Tool: operon_query_objects
    const queryResult = (await client.callTool({
      arguments: { typeId: "Patient" },
      name: "operon_query_objects",
    })) as any;
    expect(queryResult.isError).toBeFalsy();
    const queryBody = JSON.parse(queryResult.content[0].text);
    expect(queryBody.count).toBe(1);
    expect(queryBody.objects[0].id).toBe("P001");
    expect(queryBody.objects[0].properties.name).toBe("Zhang Minghua");

    // 3. Call Tool: operon_check_readiness (existing object)
    const readinessResult = (await client.callTool({
      arguments: { objectId: "P001", typeId: "Patient" },
      name: "operon_check_readiness",
    })) as any;
    expect(readinessResult.isError).toBeFalsy();
    const readinessBody = JSON.parse(readinessResult.content[0].text);
    expect(readinessBody.objectId).toBe("P001");
    expect(readinessBody.decisionReadiness.isReady).toBe(true);

    // 4. Call Tool: operon_check_readiness (non-existent object)
    const badReadinessResult = (await client.callTool({
      arguments: { objectId: "P999", typeId: "Patient" },
      name: "operon_check_readiness",
    })) as any;
    expect(badReadinessResult.isError).toBe(true);
    expect(badReadinessResult.content[0].text).toContain(
      "Object or type not found"
    );

    // 5. Call Tool: operon_set_valve_position (Proposal Mode)
    const proposeResult = (await client.callTool({
      arguments: { openingPercent: 45, tankId: "tank-alpha" },
      name: "operon_set_valve_position",
    })) as any;
    expect(proposeResult.isError).toBeFalsy();
    const proposeBody = JSON.parse(proposeResult.content[0].text);
    expect(proposeBody.status).toBe("PROPOSAL_CREATED");
    expect(proposeBody.proposalId).toBeDefined();

    // 6. Call Tool: operon_update_vitals (Automated Mode)
    const autoResult = (await client.callTool({
      arguments: { heartRate: 72, patientId: "P001" },
      name: "operon_update_vitals",
    })) as any;
    expect(autoResult.isError).toBeFalsy();
    const autoBody = JSON.parse(autoResult.content[0].text);
    expect(autoBody.status).toBe("EXECUTED");
    expect(autoBody.recordHash).toBeDefined();

    // 7. Call Tool: Unknown Tool
    const unknownResult = (await client.callTool({
      arguments: {},
      name: "operon_non_existent_tool",
    })) as any;
    expect(unknownResult.isError).toBe(true);
    expect(unknownResult.content[0].text).toContain("Unknown tool");

    // 8. Call Tool: Invalid parameters (triggers error branch)
    const invalidResult = (await client.callTool({
      arguments: { openingPercent: "not-a-number", tankId: "tank-alpha" },
      name: "operon_set_valve_position",
    })) as any;
    expect(invalidResult.isError).toBe(true);
  });

  it("should enforce Builder Key on AI FDE and create branch proposals with full changesets", async () => {
    const { OntologyMetadataService } = await import("@operon/runtime");
    const { AIFdeAgent } = await import("./ai-fde.js");
    const oms = new OntologyMetadataService();
    const fde = new AIFdeAgent(oms);

    const fdeAuthor = {
      id: "ai-fde",
      name: "AI Forward Deployed Engineer",
      roles: ["fde_agent"],
      type: "agent" as const,
    };

    // Consumer key fails
    const failAttempt = await Effect.runPromise(
      fde
        .executeInstruction({
          apiKey: "ck_consumer_123",
          author: fdeAuthor,
          instruction: "Add FlightObservation",
          synthesizedChangeSet: {},
          targetBranchName: "fde-flight-obs",
        })
        .pipe(Effect.result)
    );
    expect(failAttempt._tag).toBe("Failure");

    // Builder key succeeds with full objectTypes, linkTypes, and actionTypes changeset
    const successResult = await Effect.runPromise(
      fde.executeInstruction({
        apiKey: "bk_builder_secret_789",
        author: fdeAuthor,
        instruction: "Add FlightObservation and Link",
        synthesizedChangeSet: {
          actionTypes: [
            defineActionType({
              defaultExecutionMode: "automated",
              description: "Log altimeter reading",
              id: "log_altimeter",
              minimumAgentTier: 1,
              name: "Log Altimeter",
              parametersSchema: Schema.Struct({ reading: Schema.Number }),
              riskTier: "low",
            }),
          ],
          linkTypes: [
            defineLinkType({
              cardinality: "one-to-many",
              description: "Flight to observation link",
              id: "FlightToObservation",
              sourceToTargetName: "observations",
              sourceTypeId: "Flight",
              targetToSourceName: "flight",
              targetTypeId: "FlightObservation",
            }),
          ],
          objectTypes: [
            defineObjectType({
              description: "Flight Sensor Data",
              id: "FlightObservation",
              name: "Flight Observation",
              primaryKey: "id",
              properties: {
                altitude: defineProperty({
                  description: "Feet",
                  schema: Schema.Number,
                }),
                id: defineProperty({
                  description: "ID",
                  schema: Schema.String,
                }),
              },
              typology: "observation",
            }),
          ],
        },
        targetBranchName: "fde-flight-obs",
      })
    );

    expect(successResult.branchName).toBe("fde-flight-obs");
    expect(successResult.proposal.status).toBe("open");
    expect(successResult.proposal.changeSet.addedObjectTypes.length).toBe(1);
    expect(successResult.proposal.changeSet.addedLinkTypes.length).toBe(1);
    expect(successResult.proposal.changeSet.addedActionTypes.length).toBe(1);
    expect(successResult.summary).toContain("AI FDE created branch");
  });

  it("should use fallback default caller key when defaultCallerKey option is omitted", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const server = createOperonMcpServer({
      actionTypes: [],
      auditStore,
      objectStore,
      objectTypes: [],
    });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(sTransport);
    const client = new Client(
      { name: "test-client-2", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(cTransport);
    const res = (await client.callTool({
      arguments: { typeId: "AnyType" },
      name: "operon_query_objects",
    })) as any;
    expect(res.isError).toBeFalsy();
  });
});
