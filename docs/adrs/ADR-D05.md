# ADR-D05 - Three-valued review versus explicit UNKNOWN

## Program frame (normative in this document)

Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence and the result algebra. CLI, MCP, SDK, generated application surfaces, recipes and enterprise modules are adapters over that kernel and may not reimplement its rules.

Release order is V0 -> V1 -> V2 -> V3. V0 proves external-agent authoring, ingestion, reconciliation and safe action. V1 proves Action Inbox, exact approval, durable execution and honest outcomes. V2 adds post-V0 missions, disposable generated surfaces and the recipes/skills/module ecosystem. V3 adds federation, factory, sovereign operations and formal assurance. A later release cannot be claimed before the preceding gate passes on the same pinned candidate with independent evidence.

Current status is `SPEC_CONSISTENT_NOT_PRODUCT_PASS`: no runtime case has been executed by this dossier.

## Status and applicability

**Status:** ENGINEERING_DEFAULT_APPROVED_V42  
**Applicability:** program contract

## Context

The book uses three-valued allow/review/deny in worked hooks and discusses explicit unknown and open/closed-world declarations in the broader framework. The documents do not impose one universal missingness encoding for every decision class.

## Decision / required resolution

Canonical decision algebra is ALLOW | DENY | REVIEW_REQUIRED | EVIDENCE_INSUFFICIENT. Infrastructure/protocol failure is a separate typed error, never a decision. DENY is authoritative policy refusal; REVIEW_REQUIRED means an authorized reviewer may decide; EVIDENCE_INSUFFICIENT means required evidence is missing/stale/hidden and cannot become ALLOW. Re-evaluate at commit/delivery. This is an engineering default made in v4.2 and may be overridden only by a new versioned decision with migration and transport mappings.

## Consequences

- Approved decisions govern every implementation and acceptance case in their applicability boundary.
- Open decisions block only the affected claim or recipe; they do not silently acquire a default.
- D01-D04 never block the generic kernel. Business-model and exact-license decisions do not block private engineering, but do block the corresponding public/commercial claim.
- Evidence must bind the exact candidate, profile and decision version.

## Verification and rollback

Test both permitted and denied boundaries plus migration/restart behavior. To change this decision, issue a superseding ADR, preserve historical receipts, publish compatibility rules inside the new artifact and reconcile in-flight operations before re-enabling writes.
