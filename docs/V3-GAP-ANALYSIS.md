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
| **`V3-05`** | **G3 / WS10** | Audited Backup, Qualified Restore & Key Rotation | `packages/runtime/src/backup/`<br>`packages/schema/src/backup.ts` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-049`, `S16`. | Backup audit and restore qualification verifying hash chain integrity, decisions, approvals, and receipts (`FULL-ACC-049`); zero-downtime key rotation, multi-key verification, and confined resource cleanup. Verified with 5/5 unit tests. |
| **`V3-06`** | **G3 / WS10** | Tenant Resource Quotas & Operational Economics | `packages/runtime/src/economics/`<br>`packages/schema/src/economics.ts` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-048`, `OPR-FULL-050`, `S16`. | Multi-tenant resource quotas, noisy-neighbor burst isolation preserving co-tenant guaranteed capacity (`FULL-ACC-048`), finite mission budgets, and sovereign regional locality fences blocking external egress before data transmission (`FULL-ACC-050`). Verified with 5/5 unit tests. |
| **`V3-07`** | **G3 / WS11** | Independent Evidence, Dual Ledgers & Adversarial Factory Verification | `packages/assurance/src/factory/`<br>`packages/schema/src/factory.ts` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-051..054`, `S17`. | Dual ledgers (normative requirements vs candidate observations); task contract enforcement (`FULL-ACC-051`); adversarial scenario removal rejection (`FULL-ACC-052`); parallel contract version conflict detection (`FULL-ACC-053`); controlled self-hosting requiring external publication gate (`FULL-ACC-054`); adversarial mutation defense. Verified with 5/5 unit tests. |
| **`V3-08`** | **G3 / WS13** | Formal Assurance (Gate I & II), AssuranceCase Reports & Optimization | `packages/assurance/src/formal/`<br>`packages/schema/src/formal.ts` | 🟢 **RESOLVED_PASSED**<br>Derived from `OPR-FULL-026..030`, `S19`. | Typed executable fragment with specified semantics; bounded search results published as `BOUNDED_NO_COUNTEREXAMPLE` (`FULL-ACC-026`); differential equivalence blocking publication on translation divergence (`FULL-ACC-027`); scenario sandbox containment (`FULL-ACC-028`); inconclusive/timeout evidence rejection (`FULL-ACC-029`); incremental vs full baseline consistency (`FULL-ACC-030`); Gate I and Gate II verification. Verified with 6/6 unit tests. |

---

## 3. Milestone Achievement: Gate G3 Fully Verified & Passed

All 8 foundational workstream tickets comprising Gate G3 (`V3-01` through `V3-08`) and the Unified Gate G3 Isolated Enterprise Profile Acceptance Suite (`packages/runtime/src/g3-enterprise-profile.test.ts`) have been implemented in accordance with `S15`, `S16`, `S17`, `S19`, `ADR-D-CONS-06`, and `S00-PROGRAM.md`.

- **Enterprise Profile Suite (`packages/runtime/src/g3-enterprise-profile.test.ts`)**:
  - **Pillar 1: Federated Authority & Multi-Cell Compensation**: Enforces view contract, filters uncontracted properties, denies uncontracted link traversal (`FULL-ACC-044`), executes multi-cell saga with partial compensation without global transaction fantasy (`FULL-ACC-046`).
  - **Pillar 2: Regional Recovery, Fencing & Sovereign Locality**: Strictly validates sovereign deployment profile, rejects in-memory authority in production, fences stale split-brain processes (`FULL-ACC-047`), qualifies restore with hash chain verification, executes clean replay-free restore (`FULL-ACC-045`, `FULL-ACC-049`), throttles bursting tenants while protecting co-tenant guarantees (`FULL-ACC-048`), and enforces regional locality fences on model invocations (`FULL-ACC-050`).
  - **Pillar 3: Supply-Chain Provenance, Dual Ledgers & Adversarial Defense**: Enforces approved task contracts (`FULL-ACC-051`), protects adversarial test scenarios against deletion (`FULL-ACC-052`), detects and blocks parallel contract revision conflicts (`FULL-ACC-053`), enforces external gate for self-modifying runtime (`FULL-ACC-054`), and defends normative requirements against dropped/mutated candidate observations.
  - **Pillar 4: Formal Checks (Gate I & II, AssuranceCase Reports)**: Rejects unbounded claims from bounded searches (`FULL-ACC-026`), catches differential translation divergences (`FULL-ACC-027`), traps scenario sandbox escapes (`FULL-ACC-028`), rejects inconclusive/timeout release qualifications (`FULL-ACC-029`), enforces incremental vs full consistency (`FULL-ACC-030`), and executes Gate I and Gate II evaluations.
- **Total Tests**: 51 dedicated V3/G3 acceptance tests passing with 100% success across `@operon/runtime`, `@operon/schema`, and `@operon/assurance`.
- **Zero Regressions**: All 17 workspace packages pass continuous verification (`pnpm run fix`, `pnpm run check`, `pnpm run lint:knip`, `tsc -b`, and full test suite).
- **Gate G3 Exit Criteria Satisfied**: Federated authority, regional recovery, supply-chain provenance, and formal checks all pass in an isolated enterprise profile. Gate G3 is officially closed and verified.
