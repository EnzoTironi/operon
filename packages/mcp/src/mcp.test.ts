import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryAuditStore,
  InMemoryObjectStore,
  OntologyMetadataService,
} from "@operon/runtime";
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
  it("enforces key boundaries between Consumer Key and Builder Key", () => {
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

  it("dynamically projects Action cards and ObjectTypes into MCP schemas and groundings", () => {
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

  it("executes full MCP client-server protocol over InMemoryTransport with zero mocks", async () => {
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
      oms: new OntologyMetadataService(),
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

  it("enforces Builder Key on AI FDE and creates branch proposals with full changesets", async () => {
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

  it("uses fallback default caller key when defaultCallerKey option is omitted", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const server = createOperonMcpServer({
      actionTypes: [],
      auditStore,
      objectStore,
      objectTypes: [],
      oms: new OntologyMetadataService(),
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

  it("handles V0-B DefinitionArtifact application, candidate inspection, and publication through MCP tools", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const server = createOperonMcpServer({
      actionTypes: [],
      auditStore,
      objectStore,
      objectTypes: [],
      oms: new OntologyMetadataService(),
    });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(sTransport);
    const client = new Client(
      { name: "test-v0-b-mcp-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(cTransport);

    // Verify all 6 OMS tools are listed
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("operon_apply_definition_artifact");
    expect(toolNames).toContain("operon_inspect_candidate");
    expect(toolNames).toContain("operon_diff_candidate");
    expect(toolNames).toContain("operon_publish_release");
    expect(toolNames).toContain("operon_get_publication");
    expect(toolNames).toContain("operon_get_active_release");

    // Apply artifact via MCP
    const testArtifact = {
      actions: [
        {
          description: "Alert emergency dispatch",
          effectClass: "external_side_effect",
          id: "alert_dispatch",
          name: "Alert Dispatch",
          parametersSchema: { severity: "string" },
          requiredRoles: ["dispatcher"],
          riskTier: "high",
        },
      ],
      freshness: [],
      links: [],
      policies: [],
      queries: [],
      types: [
        {
          id: "Incident",
          name: "Incident",
          primaryKey: "id",
          properties: {
            description: { name: "description", type: "string" },
            id: { name: "id", required: true, type: "string" },
          },
        },
      ],
    };

    const applyRes = (await client.callTool({
      arguments: {
        artifact: testArtifact,
        branch: "main",
        idempotencyKey: "mcp-idemp-1",
      },
      name: "operon_apply_definition_artifact",
    })) as any;
    expect(applyRes.isError).toBeFalsy();
    const applyBody = JSON.parse(applyRes.content[0].text);
    expect(applyBody.status).toBe("applied");
    const candidateDigest = applyBody.candidateDigest;
    expect(candidateDigest).toBeDefined();

    // Inspect candidate via MCP
    const inspectRes = (await client.callTool({
      arguments: { candidateDigest },
      name: "operon_inspect_candidate",
    })) as any;
    expect(inspectRes.isError).toBeFalsy();
    const inspectBody = JSON.parse(inspectRes.content[0].text);
    expect(inspectBody.canonicalDigest).toBe(candidateDigest);

    // Diff candidate via MCP
    const diffRes = (await client.callTool({
      arguments: { candidateDigest },
      name: "operon_diff_candidate",
    })) as any;
    expect(diffRes.isError).toBeFalsy();
    const diffBody = JSON.parse(diffRes.content[0].text);
    expect(diffBody.addedTypes).toContain("Incident");
    expect(diffBody.addedActions).toContain("alert_dispatch");

    // Publish release via MCP
    const publishRes = (await client.callTool({
      arguments: {
        candidateDigest,
        expectedCurrentRelease: { kind: "none" },
        idempotencyKey: "mcp-pub-idemp-1",
        publisherId: "arch_lead",
        reviewRefs: ["rev_approval_001"],
      },
      name: "operon_publish_release",
    })) as any;
    expect(publishRes.isError).toBeFalsy();
    const publishBody = JSON.parse(publishRes.content[0].text);
    expect(publishBody.status).toBe("published");
    expect(publishBody.release.version).toBe("1.0.0");
    const pubId = publishBody.publicationId;

    // Get active release via MCP
    const activeRes = (await client.callTool({
      arguments: {},
      name: "operon_get_active_release",
    })) as any;
    expect(activeRes.isError).toBeFalsy();
    const activeBody = JSON.parse(activeRes.content[0].text);
    expect(activeBody.releaseId).toBe(publishBody.release.releaseId);

    // Get publication via MCP
    const getPubRes = (await client.callTool({
      arguments: { publicationId: pubId },
      name: "operon_get_publication",
    })) as any;
    expect(getPubRes.isError).toBeFalsy();
    const getPubBody = JSON.parse(getPubRes.content[0].text);
    expect(getPubBody.publicationId).toBe(pubId);
  });

  it("supports versioned skills and recipes discovery, MCP resources, and authority boundary enforcement (V0-CH-04)", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const oms = new OntologyMetadataService();

    const server = createOperonMcpServer({
      actionTypes: [],
      auditStore,
      defaultCallerKey: {
        agentId: "test-builder-agent",
        agentTier: 4,
        keyId: "bk-test",
        name: "Test Builder",
        role: "builder",
      },
      objectStore,
      objectTypes: [],
      oms,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    // 1. List skills via MCP tool
    const listSkillsRes = (await client.callTool({
      arguments: {},
      name: "operon_list_skills",
    })) as any;
    expect(listSkillsRes.isError).toBeFalsy();
    const skills = JSON.parse(listSkillsRes.content[0].text);
    expect(skills.length).toBeGreaterThanOrEqual(3);
    const auditSkill = skills.find(
      (s: any) => s.id === "operon.skill.audit-investigation"
    );
    expect(auditSkill).toBeDefined();
    expect(auditSkill.minContract).toBe("operon.kernel/v0");
    expect(auditSkill.requiredTools).toContain("operon_verify_audit_ledger");
    expect(auditSkill.digest).toBeDefined();

    // 2. Get specific skill
    const getSkillRes = (await client.callTool({
      arguments: { skillId: "operon.skill.audit-investigation" },
      name: "operon_get_skill",
    })) as any;
    expect(getSkillRes.isError).toBeFalsy();
    const skillDetail = JSON.parse(getSkillRes.content[0].text);
    expect(skillDetail.id).toBe("operon.skill.audit-investigation");
    expect(skillDetail.authorityPrerequisites).toContain("auditor");

    // 3. List and read MCP resources
    const resourcesRes = await client.listResources();
    expect(resourcesRes.resources.length).toBeGreaterThanOrEqual(4);
    const skillResource = resourcesRes.resources.find(
      (r) => r.uri === "operon://skills/operon.skill.audit-investigation"
    );
    expect(skillResource).toBeDefined();

    const readRes = await client.readResource({
      uri: "operon://skills/operon.skill.audit-investigation",
    });
    expect(readRes.contents).toHaveLength(1);
    const readSkill = JSON.parse((readRes.contents[0] as any).text);
    expect(readSkill.id).toBe("operon.skill.audit-investigation");

    // 4. List recipes via MCP tool
    const listRecipesRes = (await client.callTool({
      arguments: {},
      name: "operon_list_recipes",
    })) as any;
    expect(listRecipesRes.isError).toBeFalsy();
    const recipes = JSON.parse(listRecipesRes.content[0].text);
    expect(recipes.length).toBeGreaterThanOrEqual(1);
    expect(recipes[0].id).toBe("operon.recipe.aviation-skywise");

    // 5. Import recipe pack via MCP tool and verify S14: recipe import grants no authority
    const { AviationSkywisePack } = await import("@operon/recipes");
    const importRes = (await client.callTool({
      arguments: { pack: AviationSkywisePack },
      name: "operon_import_recipe",
    })) as any;
    expect(importRes.isError).toBeFalsy();
    const receipt = JSON.parse(importRes.content[0].text);
    expect(receipt.imported).toBe(true);
    expect(receipt.recipeId).toBe("operon.recipe.aviation-skywise");
    // S14 Contract Invariant
    expect(receipt.grantedAuthorityCount).toBe(0);
  });

  it("supports accountable source ingestion, mapping proposals, provenance, and admission (V0-CH-05)", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const oms = new OntologyMetadataService();

    const server = createOperonMcpServer({
      actionTypes: [],
      auditStore,
      defaultCallerKey: {
        agentId: "fde-builder-agent",
        agentTier: 4,
        keyId: "bk-fde-1",
        name: "FDE Builder",
        role: "builder",
      },
      objectStore,
      objectTypes: [],
      oms,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "test-client-ingest", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    // 1. Ingest raw source via MCP
    const ingestRes = (await client.callTool({
      arguments: {
        idempotencyKey: "mcp-ingest-1",
        locator: "s3://raw-lake/tanks/batch1.json",
        mediaType: "application/json",
        payload: [{ tankId: "T-900", volumeLiters: 15000 }],
        tenantId: "tenant_ops",
      },
      name: "operon_ingest_source",
    })) as any;
    expect(ingestRes.isError).toBeFalsy();
    const receipt = JSON.parse(ingestRes.content[0].text);
    expect(receipt.status).toBe("ingested");
    const sourceId = receipt.sourceArtifact.sourceId;

    // 2. Replay same source with same idempotency key returns replayed
    const replayRes = (await client.callTool({
      arguments: {
        idempotencyKey: "mcp-ingest-1",
        locator: "s3://raw-lake/tanks/batch1.json",
        mediaType: "application/json",
        payload: [{ tankId: "T-900", volumeLiters: 15000 }],
        tenantId: "tenant_ops",
      },
      name: "operon_ingest_source",
    })) as any;
    expect(replayRes.isError).toBeFalsy();
    const replayReceipt = JSON.parse(replayRes.content[0].text);
    expect(replayReceipt.status).toBe("replayed");

    // 3. Propose mapping from raw source to candidate record
    const proposeRes = (await client.callTool({
      arguments: {
        definitionDigest: "def_release_123",
        primaryKeyField: "tankId",
        propertyMappings: [
          { sourceField: "volumeLiters", targetPropertyName: "volume" },
        ],
        sourceIds: [sourceId],
        targetObjectTypeId: "StorageTank",
      },
      name: "operon_propose_mapping",
    })) as any;
    expect(proposeRes.isError).toBeFalsy();
    const proposal = JSON.parse(proposeRes.content[0].text);
    expect(proposal.records).toHaveLength(1);
    expect(proposal.records[0].rawRecordId).toBe("T-900");
    expect(
      proposal.records[0].provenance.fieldProvenances["volume"]
    ).toBeDefined();

    // 4. Verify S03 invariant: store is NOT mutated before proposal admission
    const beforeAdmit = await Effect.runPromise(
      objectStore.getObject("StorageTank" as any, "T-900")
    );
    expect(beforeAdmit).toBeUndefined();

    // 5. Admit proposal via MCP
    const admitRes = (await client.callTool({
      arguments: { proposalId: proposal.proposalId },
      name: "operon_admit_mapping_proposal",
    })) as any;
    expect(admitRes.isError).toBeFalsy();
    const admitted = JSON.parse(admitRes.content[0].text);
    expect(admitted.status).toBe("approved");

    // 6. Canonical store now contains admitted object instance
    const afterAdmit = await Effect.runPromise(
      objectStore.getObject("StorageTank" as any, "T-900")
    );
    expect(afterAdmit).toBeDefined();
    expect(afterAdmit?.properties["volume"]).toBe(15000);
  });
});
