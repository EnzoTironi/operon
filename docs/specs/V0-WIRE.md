# Self-contained V0-WIRE

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

## Realization contract

**Release:** V0  
**Executable intent:** All V0 operations use versioned request/result schemas, server-bound context, stable errors and shared CLI/MCP services.

Acceptance requires the V0 A-E/F1/F2 issue gates on the same pinned candidate and profile.

## Normative specification

**Status:** candidate contract for review before implementation. It closes the shape of the V0 public path but does not claim implementation, production authentication or release approval.

## Contract families

The V0 public surface has six families:

1. **Identity and discovery** — authenticate actor/sponsor/tenant/environment, select Build/Operate resources, list tools/resources/skills/recipes and negotiate versions.
2. **Build authoring** — put/get definition artifacts, create/get branches, validate/apply/inspect/diff candidate ChangeSets, propose/review/publish and recover publication status.
3. **Skills and recipes** — list/get versioned machine-readable skills and domain recipes. Importing a recipe never grants authority.
4. **Sources and mappings** — register/list/get source inventories; propose/review/apply agent-suggested mappings. Raw bytes and field-level evidence remain linked; uncertain interpretation stays a claim.
5. **Query and evidence** — execute typed release queries with WorldView, coverage and cursor; retrieve evidence only when authorized.
6. **Safe operation** — prepare, submit approval, execute, inspect status and recover outcomes. Unknown external outcomes remain unknown; retries cannot silently duplicate effects.

## Normative constraints

- CLI and MCP invoke the same services and produce equivalent state, denial and disclosure.
- JSON/YAML is an authoring representation; executable meaning is a versioned immutable release.
- Candidate population is atomic: every valid member exists together or none do.
- Propose never mutates the active release; publish binds the reviewed digest and separately authorized actor.
- No CLI flag, MCP argument, recipe, prompt or generated app can mint a user role, tier, mandate or grant.
- Query results identify release, WorldView, evidence coverage, uncertainty and cursor/revision.
- External execution records state, decision, approval consumption, idempotency, reservations, outbound intent and reconciliation.
- A text-only agent can complete every V0 workflow. MCP Apps/generated apps are optional projections and inherit the caller's authority only.

## State and transport

Persistent profile state must survive process restart and concurrent readers. Corruption enters explicit quarantine/recovery. Unknown flags, unsupported versions, unauthorized tools and malformed payloads return one versioned result envelope on the result channel; diagnostics do not contaminate machine-readable output. Idempotency keys bind request digest, tenant, resource and operation identity.

## Open engineering approvals

Implementation still requires approval of concrete schema names, profiles, runtime result algebra, durable adapter and publication authority. See `decisions.json` and `issues/`.

## Interpretation rule

Any path or source citation above is provenance or an intended implementation location, not a dependency needed to understand this contract. This document contains the controlling behavior and acceptance boundary.
