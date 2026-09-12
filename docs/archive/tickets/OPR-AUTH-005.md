# OPR-AUTH-005 - Trusted approval identity at MCP boundary

**Release/workstream:** V1 / WS03 - Identity, grants and authority  
**Priority/status:** P0 / OPEN  
**Owner:** Implementer with independent verifier  
**Depends on:** WS01

## Program frame (normative in this document)

Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence and the result algebra. CLI, MCP, SDK, generated application surfaces, recipes and enterprise modules are adapters over that kernel and may not reimplement its rules.

Release order is V0 -> V1 -> V2 -> V3. V0 proves external-agent authoring, ingestion, reconciliation and safe action. V1 proves Action Inbox, exact approval, durable execution and honest outcomes. V2 adds post-V0 missions, disposable generated surfaces and the recipes/skills/module ecosystem. V3 adds federation, factory, sovereign operations and formal assurance. A later release cannot be claimed before the preceding gate passes on the same pinned candidate with independent evidence.

Current status is `SPEC_CONSISTENT_NOT_PRODUCT_PASS`: no runtime case has been executed by this dossier.

## Decision capsule (normative in this document)

- D16: V0 is CLI/MCP-first, agent-agnostic and has no permanent UI; both public OSS and private real-company proof gates are mandatory.
- D-CONS-06: execute V0-A protocol/state, V0-B authoring, V0-C ingestion/provenance, V0-D reconciliation/mirror, V0-E safe use/action/views, then F1/F2.
- D-CONS-04: demo, maintenance, production and external-agent profiles are distinct; a client cannot mint identity or authority.
- D-CONS-01: canonical terms are TaskMandate, IntentGrant, WorldView, PreparedAction, DefinitionRelease and ChangeSet.
- D-CONS-02: SQLite is the durable local/benchmark profile; Node/PostgreSQL is the real-company reference profile; evidence never transfers between profiles.
- D15: V0 executes bounded registered actions only; larger plans and missions are post-V0.
- D05 engineering default: business results are exactly ALLOW, DENY, REVIEW_REQUIRED or EVIDENCE_INSUFFICIENT; infrastructure failure is a separate channel. Changing this requires a versioned decision and migration.
- D01-D04 are recipe-specific open decisions, never generic-kernel blockers. D-V0-BUSINESS-01 and D-V0-LICENSE-01 remain open and nonblocking until a commercial or public licensing claim is made. V0 OSS distribution excludes company data, hidden cases, gold outputs, private oracles, thresholds and evaluator weights.

## Objective

MCP approval/rejection tools cannot synthesize a human reviewer from arguments or defaults.

## Applicable contracts (fully stated)

- **S05:** Bind actor, sponsor, tenant, environment and grants server-side through replaceable auth/protocol adapters.

## Ticket-specific decisions

- none

## Exact implementation locations

- packages/runtime/src/auth.ts
- packages/alchemy/src/worker-handler.ts
- packages/mcp/src/server.ts

## Steps

1. Resolve and freeze the relevant S05 contract; retain existing source vocabulary and open decisions.
2. Implement the stated obligation in the listed actual execution paths, reusing the shared service instead of creating an interface-specific bypass.
3. Add the exact preserved positive/negative scenarios and independently derived edge cases with real pinned dependencies.
4. Demonstrate recovery, lifecycle, authorization and observations relevant to this obligation; document unsupported profiles.

## Executable tests

- **AUTH-005.T01:** Create a proposal through a real agent MCP session, then call approval with supervisor IDs/roles. **Expected:** No approval or execution occurs; a tool argument cannot mint a human identity.
- **AUTH-005.T02:** Approve from a separately authenticated human context or refer to its persisted approval. **Expected:** The verified human and the exact proposal are recorded without borrowing their token into the agent session.
- **BAI-013:** Exercise official client and server libraries for the selected current profile, plus any explicitly supported legacy endpoint. **Expected:** Real discovery, consent and tools work; protocol downgrade or unsupported SDK composition fails clearly.
- **BAI-014:** Boot configured identity service and inspect registered routes/plugins and generated migrations. **Expected:** Exactly one OAuth-provider configuration owns issuance; mcp and duplicate oauthProvider registration are rejected.
- **BAI-015:** Present tokens for another resource/client or service and request unauthorized machine scopes. **Expected:** Issuer/resource/client constraints hold and machine grants require configured administrator authority.
- **BAI-016:** Replay a valid proof on another live process, after restart, and with wrong method/URL/token hash. **Expected:** Shared replay enforcement rejects duplicates and altered requests; memory-only replay store cannot qualify.
- **BAI-017:** Return private/special-use addresses, redirects and DNS rebinding from metadata/JWKS endpoints. **Expected:** Approved transport denies unsafe fetches; legitimate public metadata resolves within resource limits.
- **BAI-018:** Use registered client-credentials and authorization-code/PKCE profiles to execute a permitted mission step. **Expected:** Both preserve actual actor and authority provenance; no end-user token is passed to unrelated upstream services.
- **BAI-019:** Resolve exact published Agent Auth artifact, peer dependencies and core 1.7.4; run plugin integration tests. **Expected:** Record real artifact hashes and outcomes; loose peer range or main manifest does not count as compatibility evidence.
- **BAI-020:** Authenticate an agent session whose user field names a human sponsor; invoke a human-only approval. **Expected:** Actual actor remains the agent; sponsor identity cannot satisfy human-only review.
- **BAI-021:** Invoke default execute and custom-location routes with granted capability but disallowed arguments. **Expected:** Both enforce identical grants, constraints and Operon mandate checks; session authentication alone never suffices.
- **BAI-022:** Generate tools from a spec containing readiness, export and administrative GET/POST endpoints. **Expected:** Only approved capabilities are exposed; HTTP method is never the sole default grant or approval criterion.
- **BAI-023:** Revoke a plugin grant, replay agent proof across replicas and inspect downstream session verification. **Expected:** Revoked calls fail; proof is verified once at entry and trusted context propagated without double-consuming replay IDs.
- **BAI-024:** Register a test agent with an explicitly approved narrow grant and complete an eligible operation. **Expected:** Actual plugin protocol succeeds through the shared Operon policy and durable operation path; no proxy bypass.

## Binary completion gate

- Applicable protected case instances passed with the required evidence class
- Same candidate/tree/lock/configuration used for implementation and result
- Independent verifier accepts artifacts; no self-approval
- Documentation, migration/recovery and disclosure constraints complete

## Deliverables

- Implementation and public contract changes
- Executable tests linked to case IDs
- Candidate-bound evidence and independent observations
- Migration/recovery and operator documentation where applicable

## Rollback

Disable discovery of the changed contract, stop new writes, preserve readable receipts/history, revert routing rather than evidence, test backward/forward migration on a persisted copy, and reconcile every in-flight `UNKNOWN`.

## Non-goals

- Do not close unrelated requirements merely because this case passes
- Do not modify protected expected outcomes to match the implementation
- Do not issue production credentials or resolve regulated-domain rules

## Provenance note

Requirement IDs: AUTH-005. Acceptance case IDs: AUTH-005.T01, AUTH-005.T02, BAI-013, BAI-014, BAI-015, BAI-016, BAI-017, BAI-018, BAI-019, BAI-020, BAI-021, BAI-022, BAI-023, BAI-024. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
