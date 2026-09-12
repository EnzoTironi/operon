# OPR-TXN-005 - Durable logical idempotency

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

Bind idempotency keys to tenant/caller/action intent and record outcomes transactionally.

## Applicable contracts (fully stated)

- **S08:** Atomically commit state, decision, approval consumption, deduplication, reservation and outbox; reconcile unknown remote outcomes.

## Ticket-specific decisions

- none

## Exact implementation locations

- packages/runtime/src/write-pipeline.ts
- packages/runtime/src/object-store.ts
- packages/runtime/src/audit.ts
- packages/runtime/src/sql-store.ts
- packages/runtime/src/cluster.ts

## Steps

1. Resolve and freeze the relevant S08 contract; retain existing source vocabulary and open decisions.
2. Implement the stated obligation in the listed actual execution paths, reusing the shared service instead of creating an interface-specific bypass.
3. Add the exact preserved positive/negative scenarios and independently derived edge cases with real pinned dependencies.
4. Demonstrate recovery, lifecycle, authorization and observations relevant to this obligation; document unsupported profiles.

## Executable tests

- **TXN-005.T01:** Submit the same logical action concurrently through several connections/transports and after restart. **Expected:** One logical transition and corresponding delivery command set are committed.
- **TXN-005.T02:** Reuse a key with different parameters, action or scoped principal. **Expected:** Reject conflicting reuse without revealing another principal’s result.
- **BAI-037:** Race multiple workers and descendants reserving against one root allowance. **Expected:** Committed spend plus active reservations never exceeds the shared limit; all consumption references one durable ledger.
- **BAI-038:** Retry requests with fresh proof but the same operation key; rerun lazy execution and concurrent approval effects. **Expected:** Exactly one logical operation consumes authorization and budget; modified payload with same key is rejected.
- **BAI-039:** Kill processes before/after authorization consumption, budget reservation, state change, decision and outbox commit. **Expected:** Required local records are atomic; recovery never rolls back a different accepted operation.
- **BAI-040:** Lose recipient response after application and then retry/compensate under revoked authority. **Expected:** Unknown remains explicit; reservation is held until safe reconciliation, and irreversible success is not described as undone.
- **BAI-041:** Try currency switching, negative/overflow amounts, rounded quantities and many individually small operations. **Expected:** Typed units and aggregate limits hold; splitting work does not evade thresholds.
- **BAI-042:** Cancel an unissued operation and reconcile known failures, then execute eligible replacement work. **Expected:** Only verified released reservations become spendable again; permitted work is not permanently blocked by stale ledger rows.

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

Requirement IDs: TXN-005. Acceptance case IDs: TXN-005.T01, TXN-005.T02, BAI-037, BAI-038, BAI-039, BAI-040, BAI-041, BAI-042. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
