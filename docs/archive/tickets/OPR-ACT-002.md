# OPR-ACT-002 - Four verdicts and error separation

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

Distinguish ALLOW, REVIEW, DENY and UNKNOWN where adopted; explicitly document a three-valued adapter’s missingness mapping.

## Applicable contracts (fully stated)

- **S07:** Preparation causes no business effect; approval binds the exact normalized proposal, release, evidence and effect digest.

## Ticket-specific decisions

- D05 [ENGINEERING_DEFAULT_APPROVED_V42]: Canonical decision algebra is ALLOW | DENY | REVIEW_REQUIRED | EVIDENCE_INSUFFICIENT. Infrastructure/protocol failure is a separate typed error, never a decision. DENY is authoritative policy refusal; REVIEW_REQUIRED means an authorized reviewer may decide; EVIDENCE_INSUFFICIENT means required evidence is missing/stale/hidden and cannot become ALLOW. Re-evaluate at commit/delivery. This is an engineering default made in v4.2 and may be overridden only by a new versioned decision with migration and transport mappings.

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

- **ACT-002.T01:** Evaluate satisfied rules, human discretion, non-waivable failure and insufficient information. **Expected:** Distinct expected dispositions are recorded; ALLOW is not permission to bypass approvals.
- **ACT-002.T02:** Timeout or fail the policy/verifier service. **Expected:** Return unavailable/error or conservative review per policy, never an ALLOW from missing evidence.

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

Requirement IDs: ACT-002. Acceptance case IDs: ACT-002.T01, ACT-002.T02. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
