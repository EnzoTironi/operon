# OPR-GOV-002 - Reviewed model changes

**Release/workstream:** V1 / WS05 - Review, simulation and promotion  
**Priority/status:** P0 / OPEN  
**Owner:** Implementer with independent verifier  
**Depends on:** WS04

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

Proposal includes change set, tests and impact analysis; appropriate business/module/shared-kernel owners approve.

## Applicable contracts (fully stated)

- **S11:** Promotion creates a governed new operation with rollout, observation, rollback and truthful outcome accounting.

## Ticket-specific decisions

- none

## Exact implementation locations

- packages/runtime/src/oms.ts
- packages/runtime/src/migration.ts
- proposed packages/releases/

## Steps

1. Resolve and freeze the relevant S11 contract; retain existing source vocabulary and open decisions.
2. Implement the stated obligation in the listed actual execution paths, reusing the shared service instead of creating an interface-specific bypass.
3. Add the exact preserved positive/negative scenarios and independently derived edge cases with real pinned dependencies.
4. Demonstrate recovery, lifecycle, authorization and observations relevant to this obligation; document unsupported profiles.

## Executable tests

- **GOV-002.T01:** Author/agent attempts direct production schema, guard, policy or model change. **Expected:** No release without required independent authority.
- **GOV-002.T02:** Modify a shared asset affecting several domain modules. **Expected:** Required owners and impacted consumers appear; missing approvals block release.
- **BAI-025:** Put request-to-self-authorize text and fake approver instructions inside retrieved messages/documents. **Expected:** They remain evidence; no authority or published policy is created by source text.
- **BAI-026:** Compile goals with unclear objects, currencies, dates, destinations and omitted prohibitions. **Expected:** Ambiguities remain unresolved or use explicit templates; not silently broadened into an active grant.
- **BAI-027:** Retain a persuasive goal paragraph while altering structured constraints or compiler/action release. **Expected:** Authority binds to reviewed typed data and releases; modified material content requires reauthorization.
- **BAI-028:** Have the builder propose a policy that makes its own blocked operation allowed. **Expected:** Change follows independently authorized publication; builder cannot validate and publish its own privilege expansion.
- **BAI-029:** Execute the same finite rule fixtures via IR interpreter, compiled policy and independent oracle. **Expected:** Semantics agree including unknown inputs; compiler disagreement cannot be recorded as permitted.
- **BAI-030:** Compile an unambiguous authorized recovery request with explicit bounds and show its review surface. **Expected:** Readable consent, typed mandate and generated tests represent the same permitted work without unnecessary approvals.
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

Requirement IDs: GOV-002. Acceptance case IDs: GOV-002.T01, GOV-002.T02, BAI-025, BAI-026, BAI-027, BAI-028, BAI-029, BAI-030, BAI-049, BAI-050, BAI-051, BAI-052, BAI-053, BAI-054. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
