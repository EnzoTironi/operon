# OPR-APR-002 - Binding to exact intent and evidence

**Release/workstream:** V1 / WS04 - Safe action and durable execution  
**Priority/status:** P0 / OPEN  
**Owner:** Implementer with independent verifier  
**Depends on:** WS02, WS03

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

Approval binds action/version, parameters, edits, object/evidence versions and rule/policy/model context; no caller boolean or arbitrary token grants authority.

## Applicable contracts (fully stated)

- **S07:** Preparation causes no business effect; approval binds the exact normalized proposal, release, evidence and effect digest.

## Ticket-specific decisions

- none

## Exact implementation locations

- packages/runtime/src/inbox.ts
- packages/runtime/src/approvals.ts
- packages/runtime/src/write-pipeline.ts

## Steps

1. Resolve and freeze the relevant S07 contract; retain existing source vocabulary and open decisions.
2. Implement the stated obligation in the listed actual execution paths, reusing the shared service instead of creating an interface-specific bypass.
3. Add the exact preserved positive/negative scenarios and independently derived edge cases with real pinned dependencies.
4. Demonstrate recovery, lifecycle, authorization and observations relevant to this obligation; document unsupported profiles.

## Executable tests

- **APR-002.T01:** Call the core with isApprovedProposal=true or a fabricated approval token/hash. **Expected:** Core authorization checks the authoritative record and rejects the forged approval.
- **APR-002.T02:** Change each bound component after approval, including output edits and policy version. **Expected:** Affected approval is invalidated/reviewed under a declared materiality policy; no changed operation executes silently.
- **BAI-025:** Put request-to-self-authorize text and fake approver instructions inside retrieved messages/documents. **Expected:** They remain evidence; no authority or published policy is created by source text.
- **BAI-026:** Compile goals with unclear objects, currencies, dates, destinations and omitted prohibitions. **Expected:** Ambiguities remain unresolved or use explicit templates; not silently broadened into an active grant.
- **BAI-027:** Retain a persuasive goal paragraph while altering structured constraints or compiler/action release. **Expected:** Authority binds to reviewed typed data and releases; modified material content requires reauthorization.
- **BAI-028:** Have the builder propose a policy that makes its own blocked operation allowed. **Expected:** Change follows independently authorized publication; builder cannot validate and publish its own privilege expansion.
- **BAI-029:** Execute the same finite rule fixtures via IR interpreter, compiled policy and independent oracle. **Expected:** Semantics agree including unknown inputs; compiler disagreement cannot be recorded as permitted.
- **BAI-030:** Compile an unambiguous authorized recovery request with explicit bounds and show its review surface. **Expected:** Readable consent, typed mandate and generated tests represent the same permitted work without unnecessary approvals.

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

Requirement IDs: APR-002. Acceptance case IDs: APR-002.T01, APR-002.T02, BAI-025, BAI-026, BAI-027, BAI-028, BAI-029, BAI-030. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
