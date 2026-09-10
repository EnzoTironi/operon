# OPR-AUTHINT-04 - Project organization lifecycle and revocation

**Release/workstream:** V1 / WS03 - Identity, grants and authority  
**Priority/status:** P0 / OPEN  
**Owner:** Identity/authority implementer plus independent security verifier  
**Depends on:** OPR-AUTHINT-02

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

Map stable membership/SSO/SCIM identities; reconcile events and authorization epochs; define user-bound versus organization-owned mandate lifecycle.

## Applicable contracts (fully stated)

- **S05:** Bind actor, sponsor, tenant, environment and grants server-side through replaceable auth/protocol adapters.

## Ticket-specific decisions

- D-BAI-01 [PROPOSED_NOT_APPROVED]: 

## Exact implementation locations

- packages/runtime/src/auth.ts
- packages/alchemy/src/worker-handler.ts
- packages/mcp/src/server.ts

## Steps

1. Freeze the touched schemas and typed errors.
2. Add failing positive, denial, restart/concurrency and fault-injection tests as applicable.
3. Implement through the shared kernel and thin adapters.
4. Capture candidate/profile-bound evidence for independent verification.

## Executable tests

- **BAI-001:** Present a browser session token, OAuth access token, ID token, and agent JWT to each configured credential profile. **Expected:** Only the intended profile accepts its credential; no fallback parser or ID-token-as-access-token path.
- **BAI-002:** Use wrong issuer/resource, missing subject or expiry where required, HS/RSA confusion, EdDSA supported key and overlapping rotated keys. **Expected:** Invalid cases fail closed; the valid configured EdDSA and documented rotation overlap succeed.
- **BAI-003:** Send cookie-authenticated state changes from untrusted origins and spoof forwarding headers; test approved browser origin. **Expected:** Business CSRF/host controls block hostile requests and accept the legitimate flow independently of auth-route protection.
- **BAI-004:** Supply roles, tenant, actor kind and agent tier in request bodies, custom claims and writable metadata. **Expected:** Only trusted issuer-specific mappings and current server records set authority fields; caller data cannot overwrite them.
- **BAI-005:** Revoke a cached browser session; attempt low-risk read and high-impact approval under the declared freshness profiles. **Expected:** Sensitive paths use authoritative lookup; stale-cache duration is measured and does not exceed the declared profile.
- **BAI-006:** Exercise configured passkey/SSO/MFA and recovery paths against real database adapters. **Expected:** Legitimate users complete sign-in and recovery without unreviewed loss of required assurance; no tokens enter logs.
- **BAI-007:** Choose another organization in a header, URL, active-org cookie or stale client tab. **Expected:** Tenant is resolved against current membership and grant scope; no cross-tenant records or actions.
- **BAI-008:** Assign a dynamic organization role and test server permission checks; try substring roles such as not-an-admin. **Expected:** Exact configured capabilities are enforced; valid dynamic role succeeds and deceptive role names fail.
- **BAI-009:** Use same email across untrusted issuers or tenants and modify role assertions outside allowlisted mappings. **Expected:** Stable issuer/subject linking rules prevent unintended account linking or platform-administrator promotion.
- **BAI-010:** Deactivate a member while grants, sessions and jobs exist; replay older provisioning events. **Expected:** Member-linked grants stop at defined checkpoints; stale events cannot restore authority or lower the epoch.
- **BAI-011:** Run actual SCIM provisioning on PostgreSQL and attempt to select a D1-only SCIM deployment. **Expected:** PostgreSQL rollback cases preserve integrity; unsupported D1 profile is rejected before a support claim.
- **BAI-012:** Create/invite/remove members and teams, and transfer a sponsored mission by an authorized administrator. **Expected:** Management works; platform administration does not silently imply every business approval authority.
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

## Binary completion gate

- Matched cases executed through the actual qualified profile
- No candidate-controlled authority or release-gate changes

## Deliverables

- Map stable membership/SSO/SCIM identities; reconcile events and authorization epochs; define user-bound versus organization-owned mandate lifecycle.
- Pinned dependency/configuration manifest
- Real positive and negative integration cases
- Independent evidence and documented limits

## Rollback

Disable discovery of the changed contract, stop new writes, preserve readable receipts/history, revert routing rather than evidence, test backward/forward migration on a persisted copy, and reconcile every in-flight `UNKNOWN`.

## Non-goals

- Do not treat Agent Auth as stable without qualification
- Do not infer business approval from authentication

## Provenance note

Requirement IDs: none. Acceptance case IDs: BAI-001, BAI-002, BAI-003, BAI-004, BAI-005, BAI-006, BAI-007, BAI-008, BAI-009, BAI-010, BAI-011, BAI-012, BAI-013, BAI-014, BAI-015, BAI-016, BAI-017, BAI-018, BAI-019, BAI-020, BAI-021, BAI-022. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
