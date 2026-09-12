# OPR-WW-003 - Compliance before optimization

**Release/workstream:** V2 / WS08 - Recipes, skills and generated modules  
**Priority/status:** P1 / OPEN  
**Owner:** Implementer with independent verifier  
**Depends on:** WS01, WS02, WS04, WS06

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

Permit-version deterministic limits and the versioned margin veto unsafe optimization; model scope is explicit.

## Applicable contracts (fully stated)

- **S14:** Domain capabilities ship as versioned recipes, skills and generated modules over public kernel contracts.

## Ticket-specific decisions

- D01 [OPEN]: A domain/source owner selects and versions the comparator, updates the normative rule and table together, and approves tests just below, at and above the threshold. Keep the discrepancy visible until then; this plan chooses neither clinical nor industrial operating limits.
- D03 [OPEN]: Confirm that the full applicability declaration is normative, explicitly bind its inputs, and test each boundary and missing input. Do not represent the shortened example as the complete scope check.

## Exact implementation locations

- examples/
- proposed domain-packages/

## Steps

1. Resolve and freeze the relevant S14 contract; retain existing source vocabulary and open decisions.
2. Implement the stated obligation in the listed actual execution paths, reusing the shared service instead of creating an interface-specific bypass.
3. Add the exact preserved positive/negative scenarios and independently derived edge cases with real pinned dependencies.
4. Demonstrate recovery, lifecycle, authorization and observations relevant to this obligation; document unsupported profiles.

## Executable tests

- **WW-003.T01:** Supply predicted values below, equal to and above 0.9 times the permit limit. **Expected:** Equality behavior is blocked pending D01; other cases follow the resolved deterministic comparator.
- **WW-003.T02:** Test COD below/equal/above 800 and temperature below/equal/above 8 in the teaching fixture. **Expected:** Scope boundary is explicit after D03 resolution; out-of-scope predictions cannot independently authorize.

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

Requirement IDs: WW-003. Acceptance case IDs: WW-003.T01, WW-003.T02. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
