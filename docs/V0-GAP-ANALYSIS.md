# Operon V0 Release Gate Gap Analysis & Execution Plan

This document establishes the authoritative mapping between the **Operon V0 Release Specification** (Gates `V0-A` through `V0-F`, tickets `V0-CH-01` through `V0-CH-12`) and the current state of the monorepo.

---

## 1. Executive Program Frame

- **Architecture Principle**: Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence, and the result algebra (`ALLOW`, `DENY`, `REVIEW_REQUIRED`, `EVIDENCE_INSUFFICIENT`).
- **Release Order**: `V0 -> V1 -> V2 -> V3`.
- **Governing ADRs**:
  - `ADR-01`: Retain TypeScript and Effect without framework rewrite.
  - `ADR-02`: SQLite is the durable local/benchmark profile; Node/PostgreSQL is the real-company reference profile.
  - `ADR-05`: Better Auth supplies identity/protocol integration; Operon supplies operational authority.
  - `ADR-16` / `V0-PROFILE`: V0 is CLI/MCP-first, agent-agnostic, and has no permanent UI.
  - `ADR-D-CONS-06`: Execute critical path `V0-A` through `V0-F` before any post-V0 work.

---

## 2. V0 Critical Path Gap Analysis Matrix

| Ticket | Gate | Title | Target Paths | Current Monorepo Status | Gap to Close |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`V0-CH-01`** | **V0-A** | External-agent identity, discovery and durable profile | `packages/runtime/src/auth.ts`<br>`packages/cli/src/state.ts`<br>`packages/mcp/src/` | 🟡 **80% Done**<br>`OidcTokenVerifier` implemented with RSA/HMAC, clock tolerance, and claim validation; state persistence implemented. | Implement `AgentContext` and `resolveContext` in `auth.ts`; enforce tenant isolation (non-disclosure of mismatched tenants); verify two-process SQLite state round-trip test. |
| **`V0-CH-02`** | **V0-B** | Definition artifact, branch and atomic ChangeSet | `packages/schema/src/`<br>`packages/runtime/src/oms.ts`<br>`packages/cli/src/commands/oms.ts` | 🟢 **90% Done**<br>OMS supports branch creation, commit history, and schema validation. | Add canonical JSON byte digest calculation for `DefinitionArtifact` and validate atomic ChangeSet apply with revision check. |
| **`V0-CH-03`** | **V0-B** | Validate, inspect, diff, review and publish | `packages/runtime/src/oms.ts`<br>`packages/cli/src/commands/oms.ts` | 🟢 **95% Done**<br>Multi-stakeholder merge proposals, safety reviews, and branch comparison complete. | Ensure release tags freeze immutable DefinitionReleases. |
| **`V0-CH-04`** | **V0-C** | Versioned skills and recipes as public artifacts | `.agents/skills/`<br>`examples/`<br>`packages/mcp/src/resources/` | 🟡 **75% Done**<br>4 enterprise examples and verify-operon skill active; MCP resources exist. | Expose versioned skill & recipe catalogs directly through MCP resources. |
| **`V0-CH-05`** | **V0-C** | Raw source inventory, mapping proposals and ingestion | `packages/runtime/src/` | 🟡 **70% Done**<br>Schema validations and data ingestion active in examples. | Formalize `SourceAdmission` & `QuarantineContract` for uncertain external data. |
| **`V0-CH-06`** | **V0-D** | Reconciliation, temporal mirror, exact query and evidence | `packages/runtime/src/bitemporal.ts`<br>`packages/runtime/src/readiness.ts` | 🟢 **95% Done**<br>`SqlBitemporalStore` and 4C Decision Readiness fully implemented and verified. | Verify AS-OF bitemporal point-in-time reconstruction under concurrency. |
| **`V0-CH-07`** | **V0-E** | Prepare and exact approval with no side effects | `packages/runtime/src/write-pipeline.ts`<br>`packages/runtime/src/inbox.ts` | 🟢 **100% Done**<br>7-step write pipeline with `--dry-run` and Action Inbox proposal routing passes all checks. | None. Meets all binary acceptance criteria. |
| **`V0-CH-08`** | **V0-E** | Atomic commit, durable delivery and recovery | `packages/runtime/src/audit.ts`<br>`packages/runtime/src/write-pipeline.ts` | 🟢 **100% Done**<br>Continuous SHA-256 hash chain and DecisionRecord commit verification pass all tests. | None. Fully verified. |
| **`V0-CH-09`** | **V0-E** | CLI/MCP parity, text-only journey, optional views | `packages/cli/src/commands/`<br>`packages/mcp/src/` | 🟢 **100% Done**<br>All 11 CLI commands and MCP tools provide 1:1 parity and JSON text mode. | None. Fully verified. |
| **`V0-CH-10`** | **V0-F** | Protected Company-in-a-Box evaluator and score (F1) | `.evidence/`<br>Verification harness | 🟢 **90% Done**<br>Full 8-pillar verification harness (`verify-all.ts`) runs and generates cryptographic evidence. | Ensure gold private benchmarks remain segregated from public repo. |
| **`V0-CH-11`** | **V0-F** | Consented real-company mirror evaluation (F2) | Reference deployments | 🟡 **70% Done**<br>Healthcare CDSS, Sompo RDP, Wastewater, and Skywise examples present. | Run live pilot against PostgreSQL reference profile. |
| **`V0-CH-12`** | **V0-F** | Publication boundary and evidence leak prevention | `packages/telemetry/src/scrubber.ts`<br>CI scripts | 🟢 **95% Done**<br>`TelemetryDataScrubber` masks secrets, PII, and pseudonymizes IDs with SHA-256. | Add pre-publish check ensuring no protected evaluation weights or gold files are packaged. |

---

## 3. Immediate Execution Roadmap: Gate V0-A (`V0-CH-01`)

The first ticket on the critical path is **`V0-CH-01`**:

1. **Define `AgentContext` & Environment Contract**:
   - `actorId`, `sponsorId`, `tenantId`, `environmentId`, `grants`, `profile`.
   - `resolveContext(token)` server-side resolution function in `packages/runtime/src/auth.ts`.
2. **Implement Non-Disclosure Security Boundary**:
   - Mismatched or non-existent tenant queries return unified `NOT_FOUND` / `DENY` without revealing resource or tenant existence.
3. **Two-Process SQLite State Round-Trip Test**:
   - Verify that process A mutations persist into SQLite and process B reads identical state without memory leakage.
4. **Declarative Test Suite**:
   - Add test cases in `packages/runtime/src/auth.test.ts` and `packages/cli/src/state.test.ts` with aggressive declarative titles (`ACT-001.T*`, `AUTHINT-*.T*`).
