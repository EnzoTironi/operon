# Operon V1 Release Gate Gap Analysis & Execution Plan

This document establishes the authoritative mapping between the **Operon V1 Release Specification** (Gate `G1`, Workstreams `WS01` through `WS12`, tickets `V1-01` through `V1-08`) and the current state of the monorepo.

---

## 1. Executive Program Frame

- **Architecture Principle**: Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence, and the result algebra (`ALLOW`, `DENY`, `REVIEW_REQUIRED`, `EVIDENCE_INSUFFICIENT`).
- **Release Order**: `V0 -> V1 -> V2 -> V3`.
  - **V0 (Exit Status: PASSED / Tagged `v0.1.0`)**: Proved external-agent authoring, ingestion, reconciliation, and safe action.
  - **V1 (Current Target: G1)**: Proves Action Inbox, exact approval, durable execution, and honest outcomes in real production environments (Node/PostgreSQL reference profile).
- **Governing ADRs**:
  - `ADR-01`: Retain TypeScript and Effect without framework rewrite.
  - `ADR-02`: Qualify Node/PostgreSQL as the reference operational deployment; preserve separate local SQLite and Cloudflare profiles.
  - `ADR-08`: Local atomic commit contains state, decision, approval, deduplication, reservation, and outbox.
  - `ADR-D-CONS-06`: Sequential gate progression; later releases cannot be claimed before the preceding gate passes on the same pinned candidate with independent evidence.

---

## 2. V1 Critical Path Matrix

| Ticket | Gate / WS | Title | Target Paths | Monorepo Status | Gap to Close |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **`V1-01`** | **G1 / WS01** | Reproducible contract candidate | `packages/schema/src/candidate.ts`<br>`packages/schema/src/compiler.ts`<br>`packages/schema/src/compiler.test.ts` | 🟢 **100% Done**<br>Pure compiler with typed diagnostics; canonical source precedence enforcement; byte-for-byte deterministic hashing; unknown schema version rejection. | None. All 15 tests pass. |
| **`V1-02`** | **G1 / WS02** | Canonical evidence and bitemporal state | `packages/schema/src/evidence.ts`<br>`packages/runtime/src/canonical-evidence.ts`<br>`packages/runtime/src/canonical-evidence.test.ts` | 🟢 **100% Done**<br>Attributed claim lifecycle; contradictory evidence preservation without silent overwrite; valid-time correction preserves transaction history; independent SQL oracle parity. | None. All 5 tests pass. |
| **`V1-03`** | **G1 / WS03** | Principal, grant and authority evaluator | `packages/schema/src/authority-types.ts`<br>`packages/runtime/src/policy/authority-evaluator.ts`<br>`packages/runtime/src/policy/authority-evaluator.test.ts` | 🟢 **100% Done**<br>Server-bound principal context preventing client role/tenant elevation; aggregate-use budget exhaustion; audience/purpose attenuation; canonical 4-valued verdict algebra (ALLOW, DENY, REVIEW_REQUIRED, EVIDENCE_INSUFFICIENT). | None. All 10 tests pass. |
| **`V1-04`** | **G1 / WS04** | Action Inbox and exact approval | `packages/schema/src/actions.ts`<br>`packages/runtime/src/inbox.ts`<br>`packages/runtime/src/approvals.ts`<br>`packages/runtime/src/inbox.test.ts` | 🟢 **100% Done**<br>ActionProposal and ApprovalReceipt schemas; RFC 8785 effectDigest calculation; exact normalized proposal/release/evidence/effect digest binding; stale/changed/expired proposal rejection; deterministic inbox filtering, sorting & tie-breaking; durable snapshot export/import across restarts. | None. All 15 tests pass. |
| **`V1-05`** | **G1 / WS04** | Atomic execution, delivery and reconciliation | `packages/runtime/src/transactions/atomic-commit-service.ts` | 🟡 **75% Done**<br>In-memory atomic commit service with outbox and reconciliation. | Back atomic commit service with native SQL/PostgreSQL transaction boundary and crash-recovery tests. |
| **`V1-06`** | **G1 / WS05** | Independent review and scenario containment | `packages/runtime/src/oms.ts`<br>`packages/assurance/` | 🟢 **90% Done**<br>F1 and F2 evaluators; scenario sandboxing. | Verify containment across multi-tenant scenario boundaries and ensure scenario commands never reach live dispatcher. |
| **`V1-07`** | **G1 / WS05** | Promotion, rollout and rollback ledger | `packages/runtime/src/audit.ts`<br>`packages/assurance/` | 🟢 **90% Done**<br>Continuous SHA-256 Merkle audit chain; publication receipts. | Add rollback ledger and migration-trial verification. |
| **`V1-08`** | **G1 / WS12** | Agent protocol parity and diagnostics | `packages/cli/`<br>`packages/mcp/` | 🟢 **95% Done**<br>Full 1:1 CLI and MCP parity across all governance and runtime operations. | Expose V1 candidate compilation and durable recovery diagnostics via CLI & MCP. |

---

## 3. Immediate Next Execution: `V1-05` (Atomic execution, delivery and reconciliation)

With `V1-01`, `V1-02`, `V1-03`, and `V1-04` resolved, the next dependent ticket on the critical path is `V1-05` (WS04 - Safe action and durable execution).
