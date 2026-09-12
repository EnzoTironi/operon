# OPR-APR-006 - Delegation, handover and appeal

**Release/workstream:** V1 / WS04 - Safe action and durable execution  
**Priority/status:** P1 / OPEN  
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

Model power transfer and appeals as governed, time-bound transitions with preserved lineage.

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

- **APR-006.T01:** Delegate, use, expire and withdraw review authority. **Expected:** Every transfer has actor, scope and interval; expired/withdrawn delegation cannot approve.
- **APR-006.T02:** Appeal a rejected waiver. **Expected:** It re-enters review linked to the original decision, never directly becomes approved.
- **BAI-031:** Delegate subsets, broader predicates, longer expiry, new recipients and incompatible authority sources. **Expected:** A child cannot exceed the parent; undecidable subset comparison is rejected/reviewed, not guessed by the model.
- **BAI-032:** Revoke the root during child issuance and during worker dispatch on separate processes. **Expected:** Revocation/issuance ordering is recorded; new dispatch after the declared effective checkpoint is denied.
- **BAI-033:** Sign out a user who launched user-bound and organization-sponsored mandates; then offboard the user. **Expected:** Each follows its declared dependency; organizational work survives only under an independently valid sponsor/handover.
- **BAI-034:** Change relevant evidence, current policy, action release or membership after approval. **Expected:** Runtime applies current mandatory restrictions and the approved release/plan binding before commit/dispatch.
- **BAI-035:** Partition epoch store or identity authority while an agent presents a still-valid signed credential. **Expected:** Critical operations fail closed; any degraded read profile obeys explicit bounds and cannot issue new write authority.
- **BAI-036:** Run a multi-step mission with approved delegated bounds and independent outcome checking. **Expected:** Legitimate work completes without human approval for every step; exact permitted scope remains explainable.

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

Requirement IDs: APR-006. Acceptance case IDs: APR-006.T01, APR-006.T02, BAI-031, BAI-032, BAI-033, BAI-034, BAI-035, BAI-036. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
