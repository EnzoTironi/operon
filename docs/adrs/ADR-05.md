# ADR-05

## Program frame (normative in this document)

Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence and the result algebra. CLI, MCP, SDK, generated application surfaces, recipes and enterprise modules are adapters over that kernel and may not reimplement its rules.

Release order is V0 -> V1 -> V2 -> V3. V0 proves external-agent authoring, ingestion, reconciliation and safe action. V1 proves Action Inbox, exact approval, durable execution and honest outcomes. V2 adds post-V0 missions, disposable generated surfaces and the recipes/skills/module ecosystem. V3 adds federation, factory, sovereign operations and formal assurance. A later release cannot be claimed before the preceding gate passes on the same pinned candidate with independent evidence.

Current status is `SPEC_CONSISTENT_NOT_PRODUCT_PASS`: no runtime case has been executed by this dossier.

## Decision

**Status:** PROPOSED until explicitly superseded or approved.

Better Auth supplies identity/protocol integration; Operon supplies operational authority.

## Context and trade-off

Avoid unnecessary custom auth while preserving purpose, audience and state-aware business decisions.

## Consequences

Implementations must use the shared kernel boundary, preserve truthful outcomes and cannot claim product acceptance from documentation alone. A conflicting public contract or migration stops work until a versioned decision is recorded.

## Required evidence

Version-qualified session/OAuth/MCP/agent profiles and actor/sponsor separation.

## Rollback / supersession

Supersede with a new versioned ADR, retain the old decision and receipts, declare migration compatibility, disable affected writes during migration and reconcile in-flight unknown outcomes.
