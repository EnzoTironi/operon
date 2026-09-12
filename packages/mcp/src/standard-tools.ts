export interface StandardToolProperty {
  readonly default?: string | number | boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly items?: {
    readonly properties?: Record<string, StandardToolProperty>;
    readonly required?: readonly string[];
    readonly type?: string;
  };
  readonly properties?: Record<string, StandardToolProperty>;
  readonly required?: readonly string[];
  readonly type?: string;
}

export interface StandardToolDefinition {
  readonly description: string;
  readonly inputSchema: {
    readonly properties?: Record<string, StandardToolProperty>;
    readonly required?: readonly string[];
    readonly type: "object";
  };
  readonly name: string;
}

export const STANDARD_TOOL_DEFINITIONS: readonly StandardToolDefinition[] = [
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
    description: "Diff a candidate ChangeSet against the active main release",
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
      "Record a human review of a mapping proposal (batch admission) as the human whose authenticated cell session is bound to this server. The reviewer must differ from the author and must cite the digest they viewed. Fails when no approver session is bound; reviewer identity is never taken from arguments.",
    inputSchema: {
      properties: {
        comments: { type: "string" },
        proposalId: { type: "string" },
        verdict: {
          enum: ["approve", "reject", "request_changes"],
          type: "string",
        },
        viewedDigest: {
          description: "Proposal digest the reviewer saw",
          type: "string",
        },
      },
      required: ["proposalId", "verdict", "viewedDigest"],
      type: "object",
    },
    name: "operon_review_mapping_proposal",
  },
  {
    description:
      "Admit an approved mapping proposal: writes every candidate record to main at admission grade 'batch'. Refused until the approvals policy is met (V0-CH-05)",
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
      "Search quarantine: raw payload items (grade quarantine) and typed candidate records of open batches (grade candidate). Nothing here is an object in main.",
    inputSchema: {
      properties: {
        grade: { enum: ["quarantine", "candidate"], type: "string" },
        targetObjectTypeId: { type: "string" },
        tenantId: { type: "string" },
        text: {
          description: "Case-insensitive substring to match",
          type: "string",
        },
      },
      type: "object",
    },
    name: "operon_search_quarantine",
  },
  {
    description:
      "Admission grade of an object in main: 'batch' (admitted by a reviewed mapping proposal) or 'decision' (written by an executed Action). Null when the object did not enter through the accountable pipeline.",
    inputSchema: {
      properties: {
        objectId: { type: "string" },
        typeId: { type: "string" },
      },
      required: ["typeId", "objectId"],
      type: "object",
    },
    name: "operon_get_admission",
  },
  {
    description:
      "Derive identity resolution keys from an email address: a normalized email key for the person and, unless the domain is a public mail domain, a domain key for the organization.",
    inputSchema: {
      properties: {
        email: { type: "string" },
        suppressedDomains: {
          description:
            "Extra domains that never become an organization, unioned with the public mail domain list. Public domains cannot be opted out of.",
          items: { type: "string" },
          type: "array",
        },
      },
      required: ["email"],
      type: "object",
    },
    name: "operon_derive_identity_keys",
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
      "Propose an identity resolution keyed by an IdentityKey (email, domain or source_pk) with provenance (S03). Use operon_derive_identity_keys to build email and domain keys.",
    inputSchema: {
      properties: {
        action: { enum: ["link", "merge", "split"], type: "string" },
        confidence: { type: "number" },
        environmentId: { type: "string" },
        evidence: { items: { type: "object" }, type: "array" },
        idempotencyKey: { type: "string" },
        key: {
          description:
            "{ kind: 'email', value } | { kind: 'domain', value } | { kind: 'source_pk', sourceSystem, value }",
          properties: {
            kind: { enum: ["email", "domain", "source_pk"], type: "string" },
            sourceSystem: { type: "string" },
            value: { type: "string" },
          },
          required: ["kind", "value"],
          type: "object",
        },
        proposalId: { type: "string" },
        splitDetails: { type: "object" },
        targetCanonicalId: { type: "string" },
        tenantId: { type: "string" },
      },
      required: ["key", "targetCanonicalId", "action", "confidence"],
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
      "Approve or reject a prepared action proposal as the human whose authenticated cell session is bound to this server. Enforces exact digest binding (viewedDigest === preparedDigest), no self-approval, and non-staleness (S07). Fails when no approver session is bound; reviewer identity is never taken from arguments.",
    inputSchema: {
      properties: {
        decision: { enum: ["approved", "rejected"], type: "string" },
        environmentId: { type: "string" },
        preparedDigest: {
          description: "Digest of prepared action",
          type: "string",
        },
        reason: { type: "string" },
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
  {
    description:
      "Examine operational run diagnostics separating business, policy, and infrastructure outcomes with redacted secrets (S18)",
    inputSchema: {
      properties: {
        runId: {
          description:
            "Correlation or run ID to retrieve diagnostic bundle for",
          type: "string",
        },
      },
      required: ["runId"],
      type: "object",
    },
    name: "operon_diagnose",
  },
];
