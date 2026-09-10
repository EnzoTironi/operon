# S00 - Program architecture and release gates

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

## Dependency spine

| Workstream | Release | Owns | Depends on | Exit artifact |
| --- | --- | --- | --- | --- |
| WS01 | V1 | Contract and build spine (S01, S02) | none | verified contract and build spine contract |
| WS02 | V1 | Canonical knowledge and time (S03, S04) | WS01 | verified canonical knowledge and time contract |
| WS03 | V1 | Identity, grants and authority (S05, S06) | WS01 | verified identity, grants and authority contract |
| WS04 | V1 | Safe action and durable execution (S07, S08) | WS02, WS03 | verified safe action and durable execution contract |
| WS05 | V1 | Review, simulation and promotion (S09, S10, S11) | WS04 | verified review, simulation and promotion contract |
| WS06 | V2 | Missions and agent runtime (S12) | WS02, WS03, WS04 | verified missions and agent runtime contract |
| WS07 | V2 | Generated application surfaces (S13) | WS01, WS03, WS04, WS06 | verified generated application surfaces contract |
| WS08 | V2 | Recipes, skills and generated modules (S14) | WS01, WS02, WS04, WS06 | verified recipes, skills and generated modules contract |
| WS09 | V3 | Connectors and portable authority (S15) | WS03, WS04, WS05 | verified connectors and portable authority contract |
| WS10 | V3 | Deployment and sovereign operations (S16) | WS01, WS02, WS03, WS04 | verified deployment and sovereign operations contract |
| WS11 | V3 | Independent evidence and factory (S17) | WS01, WS05, WS10 | verified independent evidence and factory contract |
| WS12 | V1 | Agent protocol and verification ecosystem (S18) | WS01, WS04, WS05 | verified agent protocol and verification ecosystem contract |
| WS13 | V3 | Formal assurance and optimization (S19) | WS01, WS02, WS05 | verified formal assurance and optimization contract |

## Release acceptance

- V0 exits only when A-E and F1/F2 pass on one candidate while protected material stays private.
- V1/G1 exits only when crash, retry and concurrency suites prove every accepted action reaches a truthful state and independent evidence verifies it.
- V2/G2 exits only when two unrelated recipes and one generated application use public kernel contracts and survive regeneration and migration.
- V3/G3 exits only when federated authority, regional recovery, supply-chain provenance and formal checks pass in an isolated enterprise profile.

## Change and rollback

A public schema, state-machine, security-boundary or migration change requires a versioned ADR. Disable new discovery/writes before rollback, retain readable historical receipts, migrate on a persisted copy and reconcile every in-flight unknown outcome.
