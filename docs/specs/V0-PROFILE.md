# Self-contained V0-PROFILE

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
- D01-D04 are recipe-specific open decisions, never generic-kernel blockers. D-V0-BUSINESS-01 remains open and nonblocking until a commercial claim is made. D-V0-LICENSE-01 is approved: public license is MIT. V0 OSS distribution excludes company data, hidden cases, gold outputs, private oracles, thresholds and evaluator weights.

## Realization contract

**Release:** V0  
**Executable intent:** V0 is a durable CLI/MCP-first external-agent profile with no permanent Studio, native mission runtime or hidden enterprise dependency.

Acceptance requires the V0 A-E/F1/F2 issue gates on the same pinned candidate and profile.

## Normative specification

**Status:** approved product direction for the initial release profile; implementation contracts still require bounded engineering approval before production claims.

## Product definition

V0 is an agent-agnostic, governed substrate. The client-side user points their own agent at a company and its sources; the agent uses public CLI/MCP contracts, versioned skills and recipes to build, inspect, reconcile and act on a versioned operational mirror. Operon supplies substrate, contracts, skills, recipes and benchmark evidence. It does not require a first-party hosted agent and does not require a permanent Operon UI for any V0 workflow.

Zero-UI is an interaction rule, not a lack of possible views. A task may produce a dynamic, disposable or publishable generated app, and MCP Apps are an optional projection. The same workflow must remain completable through text-only CLI/MCP tools and resources. Generated views never expand authority.

## Gates

- **V0-A — Agent protocol, profiles and durable state.** Strict CLI/MCP, external-agent profiles, versioned results, durable shared state and honest diagnostics.
- **V0-B — Public authoring spine.** Atomic populated ontology ChangeSets, validate/apply/inspect/diff/propose/review/publish, transport parity and recoverable publication.
- **V0-C — Source admission, ingestion and provenance.** Raw source inventory, agent-proposed mappings, deterministic structured ingestion, uncertain interpretations as claims, quarantine, lineage, coverage and freshness.
- **V0-D — Reconciliation and operational mirror.** Accountable lifecycle, governed entity resolution, visible contradictions, process reconstruction, temporal state and completeness.
- **V0-E — Agent use, safe action and generated views.** Exact queries, grants, preparation, approval, atomic commit, delivery/recovery, audit, optional MCP Apps/generated views and text-only parity.
- **V0-F — Dual thesis gate.** Both F1 and F2 must pass for the same release family; neither substitutes for the other.

## F1 and F2

**F1 — Company-in-a-Box.** A protected benchmark with private gold, hidden cases, oracles, thresholds and evaluator policy. It scores model quality, entity resolution, provenance, conflict handling, process reconstruction, question answering, action safety, CLI/MCP ergonomics, time to first useful insight and corrections before first safe action. Public examples may demonstrate shape; protected scoring material must not appear in public packages, histories, build artifacts, logs or reports.

**F2 — Real company mirror.** One eligible real company, the first that satisfies consent and source-access requirements, supplies a bounded authorized source set. A non-Operon external agent follows the public path. The company recognizes entities, links, provenance, conflicts and missingness and finds at least one query or view useful under a predeclared rubric. At least one correction travels through the public authoring/adjudication path. Any live action is separately authorized and observed or explicitly excluded.

## Post-V0 scope

Permanent Studio/Workspace, first-party mission runtime, all nine enterprise-family packages, federation, broad production/cloud/sovereign profiles, the maximum Factory and formal expansion remain constitutional maximum-scope obligations. They are not V0 release gates unless a bounded dependency is proved for a V0 binary criterion.

## Approved boundaries

D16 resolves the initial release profile to this V0. D-CONS-06 makes V0-A..V0-F the critical path. D-V0-BUSINESS-01 remains open by design and does not block V0. D-V0-DIST-01 approves OSS distribution of kernel/contracts/skills/recipes for now and private benchmark protection. D-V0-LICENSE-01 is approved as public MIT; any future closure model is not adopted. D01-D04 are recipe/domain-pack blockers only.

## Interpretation rule

Any path or source citation above is provenance or an intended implementation location, not a dependency needed to understand this contract. This document contains the controlling behavior and acceptance boundary.
