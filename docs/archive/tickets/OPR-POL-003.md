# OPR-POL-003 - Derived information inherits restrictions

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

Derived values are at least as restricted as required inputs unless a reviewed declassification rule applies.

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

- **POL-003.T01:** Hide individual inputs but request an identifying aggregate or prediction derived from them. **Expected:** No access via unreviewed aggregation; allowed declassification has explicit policy and audit.
- **POL-003.T02:** Apply an approved transformation with a valid release policy. **Expected:** Only its declared output/scope becomes visible; original input rights do not expand.
- **BAI-043:** A privileged person requests a public-room explanation requiring private leadership context. **Expected:** Retrieval/use/release follows destination authorization; requester visibility alone cannot authorize publication.
- **BAI-044:** Probe readiness, inbox, search counts, errors, existence, schema discovery and explanations for hidden resources. **Expected:** Uniform policy enforcement covers metadata and derived outputs with safe non-disclosing responses.
- **BAI-045:** Send approved-to-read sensitive data to an unapproved hosted model, tool destination or logging provider. **Expected:** Purpose/processor/destination controls run before transmission, not only on final answer text.
- **BAI-046:** Derive memory, embeddings, caches or evaluation examples from mixed permissions; revoke/delete a source. **Expected:** Derived use remains scoped; retraction and rebuilding follow policy; no implicit training or company-wide sharing.
- **BAI-047:** Change room membership or root grant during generation, notification queue delay or streaming response. **Expected:** Release checks respect defined checkpoints; no claim to recall bytes already delivered; changed recipients trigger reevaluation.
- **BAI-048:** Evaluate a hidden blocker through a specifically authorized service and return an allowed coarse decision. **Expected:** Permitted workflow gets the minimal usable result without exposing protected evidence or treating invisibility as absence.

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

Requirement IDs: POL-003. Acceptance case IDs: POL-003.T01, POL-003.T02, BAI-043, BAI-044, BAI-045, BAI-046, BAI-047, BAI-048. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
