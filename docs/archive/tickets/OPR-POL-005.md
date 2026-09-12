# OPR-POL-005 - No indirect policy bypass

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

All reads, computations, writes, audit views, exports and development operations use the same authoritative enforcement contract.

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

- **POL-005.T01:** Attempt each prohibited operation via HTTP, MCP, SDK, OSS, set(), inbox, readiness and export. **Expected:** Equivalent denial across the actual public surfaces.
- **POL-005.T02:** Invoke a low-level privileged store from an ordinary runtime request. **Expected:** Service encapsulation/credentials prevent bypass; privileged recovery paths are separately authorized and audited.
- **BAI-019:** Resolve exact published Agent Auth artifact, peer dependencies and core 1.7.4; run plugin integration tests. **Expected:** Record real artifact hashes and outcomes; loose peer range or main manifest does not count as compatibility evidence.
- **BAI-020:** Authenticate an agent session whose user field names a human sponsor; invoke a human-only approval. **Expected:** Actual actor remains the agent; sponsor identity cannot satisfy human-only review.
- **BAI-021:** Invoke default execute and custom-location routes with granted capability but disallowed arguments. **Expected:** Both enforce identical grants, constraints and Operon mandate checks; session authentication alone never suffices.
- **BAI-022:** Generate tools from a spec containing readiness, export and administrative GET/POST endpoints. **Expected:** Only approved capabilities are exposed; HTTP method is never the sole default grant or approval criterion.
- **BAI-023:** Revoke a plugin grant, replay agent proof across replicas and inspect downstream session verification. **Expected:** Revoked calls fail; proof is verified once at entry and trusted context propagated without double-consuming replay IDs.
- **BAI-024:** Register a test agent with an explicitly approved narrow grant and complete an eligible operation. **Expected:** Actual plugin protocol succeeds through the shared Operon policy and durable operation path; no proxy bypass.
- **BAI-043:** A privileged person requests a public-room explanation requiring private leadership context. **Expected:** Retrieval/use/release follows destination authorization; requester visibility alone cannot authorize publication.
- **BAI-044:** Probe readiness, inbox, search counts, errors, existence, schema discovery and explanations for hidden resources. **Expected:** Uniform policy enforcement covers metadata and derived outputs with safe non-disclosing responses.
- **BAI-045:** Send approved-to-read sensitive data to an unapproved hosted model, tool destination or logging provider. **Expected:** Purpose/processor/destination controls run before transmission, not only on final answer text.
- **BAI-046:** Derive memory, embeddings, caches or evaluation examples from mixed permissions; revoke/delete a source. **Expected:** Derived use remains scoped; retraction and rebuilding follow policy; no implicit training or company-wide sharing.
- **BAI-047:** Change room membership or root grant during generation, notification queue delay or streaming response. **Expected:** Release checks respect defined checkpoints; no claim to recall bytes already delivered; changed recipients trigger reevaluation.
- **BAI-048:** Evaluate a hidden blocker through a specifically authorized service and return an allowed coarse decision. **Expected:** Permitted workflow gets the minimal usable result without exposing protected evidence or treating invisibility as absence.
- **BAI-049:** Try direct auth-client registration, role writes, SCIM mappings, API-key issuance and policy-table mutation. **Expected:** All authority-changing surfaces are governed; ordinary model/action permissions cannot edit the authority root.
- **BAI-050:** Let an implementing agent alter its tests/evidence and then attempt production publication with the same identity. **Expected:** Independent authority protects expected outcomes, credentials and release decision; self-issued evidence is insufficient.
- **BAI-051:** Attempt direct upstream API calls with borrowed user/provider tokens or resolveHeaders-generated global credentials. **Expected:** Only designated workers hold narrow credentials; upstream use remains tenant, operation and mandate bound.
- **BAI-052:** Drop/reorder/duplicate organization, grant and identity hooks while source records change. **Expected:** Durable reconciliation and authoritative critical checks prevent a dropped hook from preserving revoked access.
- **BAI-053:** Exercise break-glass, identity-provider outage recovery and key restoration through controlled procedures. **Expected:** Short-lived independently authorized recovery works and is audited; no permanent universal backdoor.
- **BAI-054:** An authorized operator manages one identity tenant and its grants without viewing unrelated business data. **Expected:** Necessary administration succeeds with explicit separation of system management and domain access.

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

Requirement IDs: POL-005. Acceptance case IDs: POL-005.T01, POL-005.T02, BAI-019, BAI-020, BAI-021, BAI-022, BAI-023, BAI-024, BAI-043, BAI-044, BAI-045, BAI-046, BAI-047, BAI-048, BAI-049, BAI-050, BAI-051, BAI-052, BAI-053, BAI-054. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
