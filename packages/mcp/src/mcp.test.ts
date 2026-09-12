import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CellAuth, CellSessionVerifier } from "@operon/cell-auth";
import {
  InMemoryAuditStore,
  InMemoryObjectStore,
  OntologyMetadataService,
  SessionVerifier,
} from "@operon/runtime";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { ApproverBinding, McpKey } from "./index.js";
import {
  assertBuilderKey,
  assertMcpKeyPermission,
  createOperonMcpServer,
  McpSecurityError,
  projectActionToTool,
  projectObjectTypeToGrounding,
  unboundApprover,
} from "./index.js";

interface MemoryApprover {
  readonly binding: ApproverBinding;
  readonly userId: string;
}

/** A human with a live session on a memory-backed cell auth store. */
async function issueMemoryApprover(input: {
  readonly email: string;
  readonly name: string;
}): Promise<MemoryApprover> {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* CellAuth;
      const verifier = yield* SessionVerifier;
      const issued = yield* auth.issueApproverSession(input);
      return {
        binding: { _tag: "Session", token: issued.token, verifier },
        userId: issued.userId,
      } satisfies MemoryApprover;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          CellSessionVerifier,
          CellAuth.layer({
            secret: Redacted.make("mcp-test-secret-with-32-characters!!"),
            store: { kind: "memory" },
          })
        )
      ),
      Effect.scoped
    )
  );
}

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
      approver: unboundApprover,
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
      approver: unboundApprover,
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
      approver: unboundApprover,
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
      approver: unboundApprover,
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
      approver: unboundApprover,
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

    // 5. Admission before human review is refused
    const prematureRes = (await client.callTool({
      arguments: { proposalId: proposal.proposalId },
      name: "operon_admit_mapping_proposal",
    })) as any;
    expect(prematureRes.isError).toBe(true);
    expect(JSON.parse(prematureRes.content[0].text).error).toBe(
      "ApprovalsPolicyViolationError"
    );

    // 6. A human approves the digest, then admission merges the batch
    const reviewRes = (await client.callTool({
      arguments: {
        proposalId: proposal.proposalId,
        reviewerId: "ops-owner",
        verdict: "approve",
        viewedDigest: proposal.digest,
      },
      name: "operon_review_mapping_proposal",
    })) as any;
    expect(reviewRes.isError).toBeFalsy();
    expect(JSON.parse(reviewRes.content[0].text).status).toBe("approved");

    const admitRes = (await client.callTool({
      arguments: { proposalId: proposal.proposalId },
      name: "operon_admit_mapping_proposal",
    })) as any;
    expect(admitRes.isError).toBeFalsy();
    const admitted = JSON.parse(admitRes.content[0].text);
    expect(admitted.status).toBe("merged");

    // 7. Canonical store now contains admitted object instance
    const afterAdmit = await Effect.runPromise(
      objectStore.getObject("StorageTank" as any, "T-900")
    );
    expect(afterAdmit).toBeDefined();
    expect(afterAdmit?.properties["volume"]).toBe(15000);
  });

  it("supports exact bitemporal queries, explain, and identity resolution via MCP tools (V0-CH-06)", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();
    const oms = new OntologyMetadataService();

    // Seed object into store
    await Effect.runPromise(
      objectStore.putObject({
        id: "tank-exact-1",
        lastModifiedAt: Date.now(),
        properties: { status: "operational", volume: 20000 },
        typeId: "StorageTank" as any,
        version: 1,
      })
    );

    const builderKey: McpKey = {
      agentId: "mcp-agent",
      agentTier: 3,
      keyId: "builder-key",
      name: "ReconciliationAgent",
      role: "builder",
    };

    const server = createOperonMcpServer({
      approver: unboundApprover,
      actionTypes: [],
      auditStore,
      defaultCallerKey: builderKey,
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

    // 1. Execute exact query via MCP
    const queryRes = (await client.callTool({
      arguments: {
        queryId: "StorageTank",
        validTime: Date.now(),
      },
      name: "operon_exact_query",
    })) as any;
    expect(queryRes.isError).toBeFalsy();
    const queryResult = JSON.parse(queryRes.content[0].text);
    expect(queryResult.rows).toHaveLength(1);
    expect(queryResult.rows[0].id).toBe("tank-exact-1");
    expect(queryResult.worldView).toBeDefined();
    expect(queryResult.coverage.isStale).toBe(false);

    // 2. Explain query via MCP
    const explainRes = (await client.callTool({
      arguments: {
        objectId: "tank-exact-1",
        txTime: Date.now(),
        typeId: "StorageTank",
        validTime: Date.now(),
      },
      name: "operon_explain_query",
    })) as any;
    expect(explainRes.isError).toBeFalsy();
    const plan = JSON.parse(explainRes.content[0].text);
    expect(plan.sql).toContain("SELECT");
    expect(plan.params).toContain("tank-exact-1");

    // 3. Propose identity resolution (ambiguous)
    const propRes = (await client.callTool({
      arguments: {
        action: "merge",
        confidence: 0.65, // below 0.85 threshold
        key: {
          kind: "source_pk",
          sourceSystem: "scada_legacy",
          value: "legacy-tank-A",
        },
        targetCanonicalId: "tank-exact-1",
      },
      name: "operon_propose_identity_resolution",
    })) as any;
    expect(propRes.isError).toBeFalsy();
    const proposal = JSON.parse(propRes.content[0].text);
    expect(proposal.proposalId).toBeDefined();

    // 4. Resolve without override: stays unresolved_ambiguous
    const resolveAmbiguousRes = (await client.callTool({
      arguments: {
        decisionRef: "dec-mcp-ai",
        proposalId: proposal.proposalId,
      },
      name: "operon_resolve_identity",
    })) as any;
    expect(resolveAmbiguousRes.isError).toBeFalsy();
    const ambigReceipt = JSON.parse(resolveAmbiguousRes.content[0].text);
    expect(ambigReceipt.status).toBe("unresolved_ambiguous");

    // 5. Resolve with forceOverride: succeeds
    const resolveOverrideRes = (await client.callTool({
      arguments: {
        decisionRef: "dec-human-admin",
        forceOverride: true,
        proposalId: proposal.proposalId,
      },
      name: "operon_resolve_identity",
    })) as any;
    expect(resolveOverrideRes.isError).toBeFalsy();
    const resolvedReceipt = JSON.parse(resolveOverrideRes.content[0].text);
    expect(resolvedReceipt.status).toBe("resolved");
    expect(resolvedReceipt.invalidatedProjections).toHaveLength(2);

    // 6. List identity proposals
    const listRes = (await client.callTool({
      arguments: {},
      name: "operon_list_identity_proposals",
    })) as any;
    expect(listRes.isError).toBeFalsy();
    const list = JSON.parse(listRes.content[0].text);
    expect(list).toHaveLength(1);
    expect(list[0].proposalId).toBe(proposal.proposalId);
  });

  it("handles Gate V0-E Safe Operation (prepare, approve, commit, status, generate_view) through MCP tools", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();

    // Register a test action
    const updateVitalsAction = defineActionType({
      defaultExecutionMode: "proposal",
      description: "Update patient heart rate and vitals",
      id: "update_vitals",
      minimumAgentTier: 3,
      mutation: (params, ctx) =>
        Effect.gen(function* () {
          const obj = yield* ctx.getObject("Patient" as any, params.patientId);
          if (!obj) {
            return [];
          }
          return [
            {
              ...obj,
              properties: {
                ...(obj.properties as Record<string, unknown>),
                heartRate: params.heartRate,
              },
            },
          ];
        }),
      name: "Update Vitals",
      parametersSchema: Schema.Struct({
        heartRate: Schema.Number,
        patientId: Schema.String,
      }),
      riskTier: "high",
      submissionCriteria: [
        {
          description: "Heart rate must be positive",
          evaluate: (params) =>
            Effect.succeed(
              params.heartRate > 0
                ? { passed: true as const }
                : {
                    failureReason: "Heart rate must be positive",
                    passed: false as const,
                    verdict: "deny" as const,
                  }
            ),
          id: "positive_hr",
        },
      ],
      targetObjectTypeId: "Patient",
    });

    const physician = await issueMemoryApprover({
      email: "physician@clinic.example",
      name: "Dra. Helena",
    });
    const server = createOperonMcpServer({
      actionTypes: [updateVitalsAction],
      approver: physician.binding,
      auditStore,
      objectStore,
      objectTypes: [],
      oms: new OntologyMetadataService(),
    });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(sTransport);
    const client = new Client(
      { name: "test-v0-e-mcp-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(cTransport);

    // Seed target object
    await Effect.runPromise(
      objectStore.putObject({
        id: "PAT-001",
        lastModifiedAt: Date.now(),
        properties: { heartRate: 70 },
        typeId: "Patient" as any,
        version: 1,
      })
    );

    // 1. Verify tools list includes the 5 new tools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("operon_prepare_action");
    expect(toolNames).toContain("operon_approve_prepared_action");
    expect(toolNames).toContain("operon_commit_action");
    expect(toolNames).toContain("operon_get_action_status");
    expect(toolNames).toContain("operon_generate_view");

    // 2. Prepare action via MCP (Dry-run: no business writes)
    const prepRes = (await client.callTool({
      arguments: {
        actionId: "update_vitals",
        parameters: { heartRate: 85, patientId: "PAT-001" },
        proposerId: "agent-doc",
        proposerTier: 3,
        proposerType: "agent",
      },
      name: "operon_prepare_action",
    })) as any;
    expect(prepRes.isError).toBeFalsy();
    const prepared = JSON.parse(prepRes.content[0].text);
    expect(prepared.canonicalDigest).toBeDefined();
    expect(prepared.verdict).toBe("review");

    // Verify dry-run invariant: object still has version 1 and old heartRate
    const unmodObj = await Effect.runPromise(
      objectStore.getObject("Patient" as any, "PAT-001")
    );
    expect(unmodObj).toBeDefined();
    expect((unmodObj!.properties as any).heartRate).toBe(70);

    // 3. Approve prepared action via MCP as the bound human session
    const appRes = (await client.callTool({
      arguments: {
        decision: "approved",
        preparedDigest: prepared.canonicalDigest,
        viewedDigest: prepared.canonicalDigest,
      },
      name: "operon_approve_prepared_action",
    })) as any;
    expect(appRes.isError).toBeFalsy();
    const approval = JSON.parse(appRes.content[0].text);
    expect(approval.id).toBeDefined();
    expect(approval.recordHash).toBeDefined();
    expect(approval.reviewerContext.reviewer.id).toBe(physician.userId);
    expect(approval.reviewerContext.reviewer.type).toBe("user");
    expect(approval.reviewerContext.assurance).toBe("human_verified");

    // 4. Commit action via MCP
    const commitRes = (await client.callTool({
      arguments: {
        approvalId: approval.id,
        idempotencyKey: "mcp-idem-commit-1",
        preparedDigest: prepared.canonicalDigest,
      },
      name: "operon_commit_action",
    })) as any;
    expect(commitRes.isError).toBeFalsy();
    const receipt = JSON.parse(commitRes.content[0].text);
    expect(receipt.status).toBe("COMMITTED");
    expect(receipt.receiptDigest).toBeDefined();

    // Verify business state changed
    const modObj = await Effect.runPromise(
      objectStore.getObject("Patient" as any, "PAT-001")
    );
    expect(modObj).toBeDefined();
    expect((modObj!.properties as any).heartRate).toBe(85);
    expect(modObj!.version).toBe(2);

    // 5. Get action status via MCP
    const statusRes = (await client.callTool({
      arguments: {
        operationId: receipt.operationId,
      },
      name: "operon_get_action_status",
    })) as any;
    expect(statusRes.isError).toBeFalsy();
    const statusObj = JSON.parse(statusRes.content[0].text);
    expect(statusObj.operationId).toBe(receipt.operationId);
    expect(statusObj.status).toBe("COMMITTED");

    // 6. Generate disposable view via MCP
    const viewRes = (await client.callTool({
      arguments: {
        data: { heartRate: 85, patientId: "PAT-001", status: "STABLE" },
        format: "card",
        state: "CONFIRMED",
        title: "Patient Vitals Summary",
      },
      name: "operon_generate_view",
    })) as any;
    expect(viewRes.isError).toBeFalsy();
    const viewObj = JSON.parse(viewRes.content[0].text);
    expect(viewObj.rendered).toContain("[STATE: CONFIRMED]");
    expect(viewObj.isDisposable).toBe(true);
    expect(viewObj.sourceOfTruth).toBe("OPERON_KERNEL");
  });

  it("evaluates F1, verifies receipt, evaluates F2 mirror, and scans publication boundary via MCP (Gate V0-F: V0-CH-10, V0-CH-11, V0-CH-12)", async () => {
    const objectStore = new InMemoryObjectStore();
    const auditStore = new InMemoryAuditStore();

    const server = createOperonMcpServer({
      approver: unboundApprover,
      actionTypes: [],
      auditStore,
      defaultCallerKey: {
        agentId: "agent-evaluator",
        agentTier: 4,
        keyId: "key-evaluator",
        name: "EvaluatorAgent",
        role: "consumer",
      },
      objectStore,
      objectTypes: [],
      oms: new OntologyMetadataService(),
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: "test-mcp-evaluator", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    // 1. Evaluate F1 Company-in-a-Box via MCP
    const f1Res = (await client.callTool({
      arguments: {
        candidateDigest: "cand_mcp_sha256_12345",
        candidateId: "candidate-v0-mcp",
        catalogDigest: "cat_mcp_sha256_67890",
        catalogId: "catalog-v0-mcp",
        profile: "local",
        testCases: [
          {
            assertions: 6,
            executionTimeMs: 50,
            id: "MCP-TC-01",
            name: "Kernel Concurrency Safety",
            status: "PASS",
          },
        ],
      },
      name: "operon_assurance_evaluate_f1",
    })) as any;
    expect(f1Res.isError).toBeFalsy();
    const f1Receipt = JSON.parse(f1Res.content[0].text);
    expect(f1Receipt.outcome).toBe("PASS");
    expect(f1Receipt.signature).toBeDefined();
    expect(f1Receipt.signerPublicKey).toBeDefined();

    // 2. Verify F1 Receipt via MCP
    const verifyF1Res = (await client.callTool({
      arguments: {
        receipt: f1Receipt,
      },
      name: "operon_assurance_verify_receipt",
    })) as any;
    expect(verifyF1Res.isError).toBeFalsy();
    const verifyF1Obj = JSON.parse(verifyF1Res.content[0].text);
    expect(verifyF1Obj.isValid).toBe(true);

    // 3. Evaluate F2 Consented Mirror via MCP
    const f2Res = (await client.callTool({
      arguments: {
        candidateDigest: "cand_mcp_sha256_12345",
        claim: "observed-action",
        companyEvidenceRef: "evidence://metro_hospital/mcp_mirror_run_1",
        consentScope: {
          consentGrantId: "consent_mcp_001",
          createdAt: Date.now() - 500,
          dataScope: ["patients", "prescriptions"],
          expiresAt: Date.now() + 86400000,
          participantId: "hospital_corp_alpha",
          purpose: "clinical mirror validation",
        },
        corrections: [
          {
            correctedAt: Date.now(),
            correctedBy: "specialist_physician",
            correctedValue: 12,
            correctionId: "corr_mcp_01",
            observedTarget: "Patient/P001/currentDose",
            priorValue: 15,
            reason: "Adjustment for low eGFR",
          },
        ],
        participantId: "hospital_corp_alpha",
        profileDigest: "prof_postgres_mirror_ref",
        rubricDigest: "rubric_mcp_eval_v0",
      },
      name: "operon_assurance_mirror_f2",
    })) as any;
    expect(f2Res.isError).toBeFalsy();
    const f2Receipt = JSON.parse(f2Res.content[0].text);
    expect(f2Receipt.claim).toBe("observed-action");
    expect(f2Receipt.correctionRefs).toEqual(["corr_mcp_01"]);
    expect(f2Receipt.signature).toBeDefined();

    // 4. Scan publication boundary via MCP
    const scanRes = (await client.callTool({
      arguments: {
        allowedPublicOnly: true,
        targetDirectory: `${process.cwd()}/benchmarks/public`,
      },
      name: "operon_assurance_scan_publication",
    })) as any;
    expect(scanRes.isError).toBeFalsy();
    const scanObj = JSON.parse(scanRes.content[0].text);
    expect(scanObj.isClean).toBe(true);
  });
});
