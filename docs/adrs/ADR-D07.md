# ADR-D07 - Reference-existence theorem and creation within an action

## Program frame (normative in this document)

Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence and the result algebra. CLI, MCP, SDK, generated application surfaces, recipes and enterprise modules are adapters over that kernel and may not reimplement its rules.

Release order is V0 -> V1 -> V2 -> V3. V0 proves external-agent authoring, ingestion, reconciliation and safe action. V1 proves Action Inbox, exact approval, durable execution and honest outcomes. V2 adds post-V0 missions, disposable generated surfaces and the recipes/skills/module ecosystem. V3 adds federation, factory, sovereign operations and formal assurance. A later release cannot be claimed before the preceding gate passes on the same pinned candidate with independent evidence.

Current status is `SPEC_CONSISTENT_NOT_PRODUCT_PASS`: no runtime case has been executed by this dossier.

## Status and applicability

**Status:** OPEN  
**Applicability:** program contract

## Context

The type-reliability metatheorem says every referenced instance exists before execution. A runtime may also create an object and link it within the same staged action. A proof must distinguish pre-existing references from newly bound identities.

## Decision / required resolution

Define the selected action fragment and transition semantics: either exclude new-reference effects in that theorem or prove a correctly stated extension with well-scoped fresh identities. Do not claim the literal theorem covers an unmodeled case.

## Consequences

- Approved decisions govern every implementation and acceptance case in their applicability boundary.
- Open decisions block only the affected claim or recipe; they do not silently acquire a default.
- D01-D04 never block the generic kernel. Business-model and exact-license decisions do not block private engineering, but do block the corresponding public/commercial claim.
- Evidence must bind the exact candidate, profile and decision version.

## Verification and rollback

Test both permitted and denied boundaries plus migration/restart behavior. To change this decision, issue a superseding ADR, preserve historical receipts, publish compatibility rules inside the new artifact and reconcile in-flight operations before re-enabling writes.
