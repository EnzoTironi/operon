# Operon V3 Release Gate Gap Analysis & Execution Plan

This document establishes the authoritative mapping between the **Operon V3 Release Specification** (Gate `G3`, Workstreams `WS09`, `WS10`, `WS11`, `WS13`, tickets `V3-01` through `V3-08`) and the current state of the monorepo.

---

## 1. Executive Program Frame

- **Architecture Principle**: Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence, and the result algebra (`ALLOW`, `DENY`, `REVIEW_REQUIRED`, `EVIDENCE_INSUFFICIENT`).
- **Release Order**: `V0 -> V1 -> V2 -> V3`.
  - **V0 (Exit Status: PASSED / Tagged `v0.1.0`)**: Proved external-agent authoring, ingestion, reconciliation, and safe action.
  - **V1 / Gate G1 (Exit Status: PASSED)**: Proved Action Inbox, exact approval, durable execution, and honest outcomes in real production environments.
  - **V2 / Gate G2 (Exit Status: PASSED)**: Proved post-V0 missions, agent runtime with four authority tiers, bounded planning DAGs, disposable generated application surfaces, and the recipes/skills/module ecosystem.
  - **V3 / Gate G3 (Current Target)**: Proves federated authority, contracted connectors, sovereign deployment profiles, regional failover with fenced writer authority, independent factory evidence with adversarial mutation defense, and formal assurance with Gate I/II verification.
- **Governing ADRs & Specifications**:
  - `ADR-01`: Retain TypeScript and Effect without framework rewrite.
  - `ADR-02`: Node/PostgreSQL reference operational deployment; local SQLite durable profile.
  - `ADR-08`: Local atomic commit contains state, decision, approval, deduplication, reservation, and outbox.
  - `ADR-D-CONS-06`: Sequential gate progression; Gate G3 cannot be claimed without passing G2 on the same pinned candidate with independent evidence.
  - `S00-PROGRAM.md`: Gate G3 exit criterion: "V3/G3 exits only when federated authority, regional recovery, supply-chain provenance and formal checks pass in an isolated enterprise profile."
  - `S15`: Connectors and portable authority contract.
  - `S16`: Deployment and sovereign operations contract.
  - `S17`: Independent evidence and factory contract.
  - `S19`: Formal assurance and optimization contract.

---

## 2. V3 Critical Path Matrix

| Ticket | Gate / WS | Title | Target Paths | Monorepo Status | Gap to Close |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **`V3-01`** | **G3 / WS09** | Contracted Inbound & Outbound Connectors | `packages/runtime/src/connectors/`<br>`packages/schema/src/connectors.ts` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-043`, `OPR-FULL-044`, `S15`. | Contracted connector declarations: conditional write support, source freshness, CDC order/outage handling, broker credential boundary, compensation support. Explicit rejection when source lacks required guarantees (`FULL-ACC-043`). Verified with 9/9 unit tests. |
| **`V3-02`** | **G3 / WS09** | Federated Authority & Multi-Cell Compensation | `packages/runtime/src/federation/`<br>`packages/schema/src/federation.ts` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-044`, `OPR-FULL-046`, `S15`. | Contracted views and actions between independent cells; link traversal outside contract is denied (`FULL-ACC-044`); remote claims remain attributed with uncertainty; partial multi-cell failure handled via compensation without fictional global transactions (`FULL-ACC-046`). Verified with 8/8 unit tests. |
| **`V3-03`** | **G3 / WS09** | Sovereign Export, Import & Clean Replay-Free Restore | `packages/runtime/src/federation/`<br>`packages/runtime/src/export/` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-045`, `S15`. | Clean export/import preserving identities and authorized history without secrets; clean restore into new cell yields matching queries/dossiers with zero historical side-effects or re-sent notifications (`FULL-ACC-045`). Verified with 5/5 unit tests. |
| **`V3-04`** | **G3 / WS10** | Sovereign Deployment Profiles & Fenced Dual-Writer Resolution | `packages/runtime/src/cluster/`<br>`packages/runtime/src/deployment/` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-047`, `S16`. | Multi-process failover; split-brain fencing: when two processes claim same tenant, only current fence holder dispatches new effects (`FULL-ACC-047`). Prohibits in-memory authority in production (`S16`). Verified with 6/6 unit tests. |
| **`V3-05`** | **G3 / WS10** | Audited Backup, Qualified Restore & Key Rotation | `packages/runtime/src/backup/`<br>`packages/runtime/src/security/` | 🟡 **In Progress**<br>Derived from `OPR-FULL-048`, `OPR-FULL-049`, `S16`. | Backup audit and restore qualification verifying hash chain integrity, decisions, approvals, and receipts (`FULL-ACC-048`); zero-downtime key rotation and process confinement (`OPR-FULL-049`). |
| **`V3-06`** | **G3 / WS10** | Tenant Resource Quotas & Operational Economics | `packages/runtime/src/economics/`<br>`packages/schema/src/economics.ts` | ⚪ **Not Started**<br>Derived from `OPR-FULL-050`, `OPR-OPS-*`, `S16`. | Multi-tenant resource quotas, model/tool spend metering, queue backlog contention measurement, finite mission aggregate bounds. |
| **`V3-07`** | **G3 / WS11** | Independent Evidence, Dual Ledgers & Adversarial Factory Verification | `packages/assurance/src/factory/`<br>`validation/` | ⚪ **Not Started**<br>Derived from `OPR-FULL-051..054`, `S17`. | Two ledgers (immutable normative requirements vs candidate observations); strict implementer/verifier separation; adversarial mutation defense: dropped/duplicate cases, zero-assertion pass, forged runner, and tampered receipts fail evidence gate. |
| **`V3-08`** | **G3 / WS13** | Formal Assurance (Gate I & II), AssuranceCase Reports & Optimization | `packages/assurance/src/formal/`<br>`packages/schema/src/formal.ts` | ⚪ **Not Started**<br>Derived from `OPR-FULL-026..030`, `S19`. | Typed executable fragment with specified semantics; Gate I (declared rule respect without over-restriction); Gate II (knowledge admission against policy); AssuranceCase reports (`proven-in-model`, `counterexample`, `bounded-no-counterexample`); scenario optimization under fixed containment baseline. |

---

## 3. Active Execution: `V3-05` (Audited Backup, Qualified Restore & Key Rotation)

With `V3-04` complete and verified, execution continues on Workstream `WS10 - Deployment and sovereign operations` with ticket `V3-05`:

1. **Audited Backup & Qualified Restore (`S16`, `OPR-FULL-048`, `FULL-ACC-048`)**:
   - A restore is qualified by verifying hash chain integrity, decisions, approvals, and receipts — not merely opening a database file.
   - Corrupt or broken hash chain / audit state cannot be silently ignored and must fail restore qualification with structured `BackupAuditIntegrityError`.
2. **Zero-Downtime Key Rotation & Confinement (`S16`, `OPR-FULL-049`)**:
   - Multi-key verification window during key rotation: old receipts signed with key `v1` remain verifiable while new receipts are signed with key `v2`.
   - Process confinement ensures cleanup acts strictly on recorded owned resources; unauthorized global process kills are prohibited.
