# OPR-AUTHINT-11 - Enforce model egress and output audiences

**Release/workstream:** V1 / WS03 - Identity, grants and authority  
**Priority/status:** P1 / OPEN  
**Owner:** Identity/authority implementer plus independent security verifier  
**Depends on:** OPR-AUTHINT-10

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

Apply processor/purpose restrictions before retrieval or model transmission; control recipients, caches, training use and streaming/notification release.

## Applicable contracts (fully stated)

- **S06:** Evaluate intent, information use and aggregate authority once; budgets, purpose and output audience attenuate access.

## Ticket-specific decisions

- D-BAI-04 [PROPOSED_NOT_APPROVED]: 

## Exact implementation locations

- packages/runtime/src/security-views.ts
- packages/schema/src/
- packages/mcp/src/server.ts

## Steps

1. Freeze the touched schemas and typed errors.
2. Add failing positive, denial, restart/concurrency and fault-injection tests as applicable.
3. Implement through the shared kernel and thin adapters.
4. Capture candidate/profile-bound evidence for independent verification.

## Executable tests

- **BAI-023:** Revoke a plugin grant, replay agent proof across replicas and inspect downstream session verification. **Expected:** Revoked calls fail; proof is verified once at entry and trusted context propagated without double-consuming replay IDs.
- **BAI-024:** Register a test agent with an explicitly approved narrow grant and complete an eligible operation. **Expected:** Actual plugin protocol succeeds through the shared Operon policy and durable operation path; no proxy bypass.
- **BAI-025:** Put request-to-self-authorize text and fake approver instructions inside retrieved messages/documents. **Expected:** They remain evidence; no authority or published policy is created by source text.
- **BAI-026:** Compile goals with unclear objects, currencies, dates, destinations and omitted prohibitions. **Expected:** Ambiguities remain unresolved or use explicit templates; not silently broadened into an active grant.
- **BAI-027:** Retain a persuasive goal paragraph while altering structured constraints or compiler/action release. **Expected:** Authority binds to reviewed typed data and releases; modified material content requires reauthorization.
- **BAI-028:** Have the builder propose a policy that makes its own blocked operation allowed. **Expected:** Change follows independently authorized publication; builder cannot validate and publish its own privilege expansion.
- **BAI-029:** Execute the same finite rule fixtures via IR interpreter, compiled policy and independent oracle. **Expected:** Semantics agree including unknown inputs; compiler disagreement cannot be recorded as permitted.
- **BAI-030:** Compile an unambiguous authorized recovery request with explicit bounds and show its review surface. **Expected:** Readable consent, typed mandate and generated tests represent the same permitted work without unnecessary approvals.
- **BAI-031:** Delegate subsets, broader predicates, longer expiry, new recipients and incompatible authority sources. **Expected:** A child cannot exceed the parent; undecidable subset comparison is rejected/reviewed, not guessed by the model.
- **BAI-032:** Revoke the root during child issuance and during worker dispatch on separate processes. **Expected:** Revocation/issuance ordering is recorded; new dispatch after the declared effective checkpoint is denied.
- **BAI-033:** Sign out a user who launched user-bound and organization-sponsored mandates; then offboard the user. **Expected:** Each follows its declared dependency; organizational work survives only under an independently valid sponsor/handover.
- **BAI-034:** Change relevant evidence, current policy, action release or membership after approval. **Expected:** Runtime applies current mandatory restrictions and the approved release/plan binding before commit/dispatch.
- **BAI-035:** Partition epoch store or identity authority while an agent presents a still-valid signed credential. **Expected:** Critical operations fail closed; any degraded read profile obeys explicit bounds and cannot issue new write authority.
- **BAI-036:** Run a multi-step mission with approved delegated bounds and independent outcome checking. **Expected:** Legitimate work completes without human approval for every step; exact permitted scope remains explainable.
- **BAI-037:** Race multiple workers and descendants reserving against one root allowance. **Expected:** Committed spend plus active reservations never exceeds the shared limit; all consumption references one durable ledger.
- **BAI-038:** Retry requests with fresh proof but the same operation key; rerun lazy execution and concurrent approval effects. **Expected:** Exactly one logical operation consumes authorization and budget; modified payload with same key is rejected.
- **BAI-039:** Kill processes before/after authorization consumption, budget reservation, state change, decision and outbox commit. **Expected:** Required local records are atomic; recovery never rolls back a different accepted operation.
- **BAI-040:** Lose recipient response after application and then retry/compensate under revoked authority. **Expected:** Unknown remains explicit; reservation is held until safe reconciliation, and irreversible success is not described as undone.
- **BAI-041:** Try currency switching, negative/overflow amounts, rounded quantities and many individually small operations. **Expected:** Typed units and aggregate limits hold; splitting work does not evade thresholds.
- **BAI-042:** Cancel an unissued operation and reconcile known failures, then execute eligible replacement work. **Expected:** Only verified released reservations become spendable again; permitted work is not permanently blocked by stale ledger rows.
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
- **BAI-055:** Execute identical positive and negative contracts through HTTP, MCP, SDK, UI, jobs and webhook paths. **Expected:** Verdicts and obligations agree; no optional security-engine path or demo principal in production.
- **BAI-056:** Disable one tenant check, custom grant check, budget lock, audience guard or release binding at a time. **Expected:** Independent tests fail for each seeded defect and record the changed candidate; implementation cannot weaken the oracle.
- **BAI-057:** Measure policy latency, false denials, task completion, approval burden and revocation lag with realistic data. **Expected:** Results satisfy explicitly approved workload/SLO profiles; allow-everything or deny-everything cannot qualify.
- **BAI-058:** Run commercial incident to bounded recovery with quality constraints, customer-specific messages and financial confirmation. **Expected:** End-to-end receipts demonstrate real outcomes and aggregate bounds, not merely successful tool calls.
- **BAI-059:** Provision a person, delegate work, transfer responsibility, remove membership and verify pending operations. **Expected:** Both people and agents follow the correct lifecycle across Studio, Workspace, integrations and Factory.
- **BAI-060:** Attempt to release using skipped tests, substitute-runtime passes, stale lockfiles or unqualified plugin/deployment profiles. **Expected:** Gate rejects insufficient evidence; a valid exact-candidate build with required real integration results is accepted.

## Binary completion gate

- Matched cases executed through the actual qualified profile
- No candidate-controlled authority or release-gate changes

## Deliverables

- Apply processor/purpose restrictions before retrieval or model transmission; control recipients, caches, training use and streaming/notification release.
- Pinned dependency/configuration manifest
- Real positive and negative integration cases
- Independent evidence and documented limits

## Rollback

Disable discovery of the changed contract, stop new writes, preserve readable receipts/history, revert routing rather than evidence, test backward/forward migration on a persisted copy, and reconcile every in-flight `UNKNOWN`.

## Non-goals

- Do not treat Agent Auth as stable without qualification
- Do not infer business approval from authentication

## Provenance note

Requirement IDs: none. Acceptance case IDs: BAI-023, BAI-024, BAI-025, BAI-026, BAI-027, BAI-028, BAI-029, BAI-030, BAI-031, BAI-032, BAI-033, BAI-034, BAI-035, BAI-036, BAI-037, BAI-038, BAI-039, BAI-040, BAI-041, BAI-042, BAI-043, BAI-044, BAI-045, BAI-046, BAI-047, BAI-048, BAI-049, BAI-050, BAI-051, BAI-052, BAI-053, BAI-054, BAI-055, BAI-056, BAI-057, BAI-058, BAI-059, BAI-060. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
