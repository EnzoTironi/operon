# OPR-POL-004 - Submission versus approval authority

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

Use independent action-submission and confirmation/escalation matrices, including relationship-based exclusions.

## Applicable contracts (fully stated)

- **S06:** Evaluate intent, information use and aggregate authority once; budgets, purpose and output audience attenuate access.

## Ticket-specific decisions

- none

## Exact implementation locations

- packages/runtime/src/security-views.ts
- packages/schema/src/
- packages/mcp/src/server.ts

## Steps

1. Resolve and freeze the relevant S06 contract; retain existing source vocabulary and open decisions.
2. Implement the stated obligation in the listed actual execution paths, reusing the shared service instead of creating an interface-specific bypass.
3. Add the exact preserved positive/negative scenarios and independently derived edge cases with real pinned dependencies.
4. Demonstrate recovery, lifecycle, authorization and observations relevant to this obligation; document unsupported profiles.

## Executable tests

- **POL-004.T01:** Use submit-only credentials to approve, or read-only credentials to change state. **Expected:** No transition and a precise authorization denial.
- **POL-004.T02:** Create a conflicting kinship/assignment/ownership relation after a proposal. **Expected:** Current relationship-based policy is enforced at execution, not only cached roles.
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

Requirement IDs: POL-004. Acceptance case IDs: POL-004.T01, POL-004.T02, BAI-001, BAI-002, BAI-003, BAI-004, BAI-005, BAI-006, BAI-007, BAI-008, BAI-009, BAI-010, BAI-011, BAI-012. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
