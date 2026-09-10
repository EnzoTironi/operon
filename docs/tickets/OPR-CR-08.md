# OPR-CR-08 - Repair: Internal action APIs still accept unbacked authority shortcuts

**Release/workstream:** V1 / WS03 - Identity, grants and authority  
**Priority/status:** P0 / OPEN  
**Owner:** Implementer plus independent verifier  
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

Resolve approval IDs against a durable trusted store, bind exact release/evidence/edit plan, and authorize all effectful paths; do not serialize capability objects as unverified caller flags.

## Applicable contracts (fully stated)

- **S06:** Evaluate intent, information use and aggregate authority once; budgets, purpose and output audience attenuate access.

## Ticket-specific decisions

- none

## Exact implementation locations

- packages/runtime/src/write-pipeline.ts:23-40
- packages/runtime/src/write-pipeline.ts:103-119
- packages/runtime/src/write-pipeline.ts:245-270
- packages/runtime/src/write-pipeline.ts:307-338

## Steps

1. Freeze the touched schemas and typed errors.
2. Add failing positive, denial, restart/concurrency and fault-injection tests as applicable.
3. Implement through the shared kernel and thin adapters.
4. Capture candidate/profile-bound evidence for independent verification.

## Executable tests

- **CR-08.REGRESSION:** Negative service/API/extension cases plus legitimate authorized execution; adversarial alternate paths must cross the same policy and transaction checks. **Expected:** Exact historical counterexample fails safely while the corresponding legitimate operation succeeds; real dependencies and external observations required.

## Binary completion gate

- Real dependency regression and related adapter contracts pass
- No interface-specific workaround or weakened assertion

## Deliverables

- Resolve approval IDs against a durable trusted store, bind exact release/evidence/edit plan, and authorize all effectful paths; do not serialize capability objects as unverified caller flags.
- Exact regression through the public or declared internal boundary
- Positive control and independent recovery observations

## Rollback

Disable discovery of the changed contract, stop new writes, preserve readable receipts/history, revert routing rather than evidence, test backward/forward migration on a persisted copy, and reconcile every in-flight `UNKNOWN`.

## Non-goals

- A source edit alone does not close this finding
- Historical diagnostic substitutes cannot count as real integration

## Provenance note

Requirement IDs: AUTH-001. Acceptance case IDs: AUTH-001.T01, AUTH-001.T02, BAI-001, BAI-002, BAI-003, BAI-004, BAI-005, BAI-006, BAI-013, BAI-014, BAI-015, BAI-016, BAI-017, BAI-018. These identifiers preserve audit lineage; no external file is required to execute or judge this ticket.
