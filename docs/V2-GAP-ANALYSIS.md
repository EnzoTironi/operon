# Operon V2 Release Gate Gap Analysis & Execution Plan

This document establishes the authoritative mapping between the **Operon V2 Release Specification** (Gate `G2`, Workstreams `WS06`, `WS07`, `WS08`, tickets `V2-01` through `V2-08`) and the current state of the monorepo.

---

## 1. Executive Program Frame

- **Architecture Principle**: Operon is a zero-permanent-UI, agent-agnostic operating kernel. One kernel owns versioned contracts, identity and authority, canonical state, proposals, execution receipts, evidence, and the result algebra (`ALLOW`, `DENY`, `REVIEW_REQUIRED`, `EVIDENCE_INSUFFICIENT`).
- **Release Order**: `V0 -> V1 -> V2 -> V3`.
  - **V0 (Exit Status: PASSED / Tagged `v0.1.0`)**: Proved external-agent authoring, ingestion, reconciliation, and safe action.
  - **V1 / Gate G1 (Exit Status: PASSED)**: Proved Action Inbox, exact approval, durable execution, and honest outcomes in real production environments.
  - **V2 / Gate G2 (Current Target)**: Proves post-V0 missions, agent runtime with four authority tiers, bounded planning, disposable generated application surfaces, and the recipes/skills/module ecosystem.
- **Governing ADRs & Specifications**:
  - `ADR-01`: Retain TypeScript and Effect without framework rewrite.
  - `ADR-02`: Node/PostgreSQL reference operational deployment; local SQLite durable profile.
  - `ADR-08`: Local atomic commit contains state, decision, approval, deduplication, reservation, and outbox.
  - `ADR-D-CONS-06`: Sequential gate progression; Gate G2 cannot be claimed without passing G1 on the same pinned candidate with independent evidence.
  - `S00-PROGRAM.md`: Gate G2 exit criterion: "V2/G2 exits only when two unrelated recipes and one generated application use public kernel contracts and survive regeneration and migration."
  - `S12`: Missions and agent runtime contract.
  - `S13`: Generated application surfaces contract.
  - `S14`: Recipes, skills and generated modules contract.

---

## 2. V2 Critical Path Matrix

| Ticket | Gate / WS | Title | Target Paths | Monorepo Status | Gap to Close |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **`V2-01`** | **G2 / WS06** | Authority Tiers and Bounded Autonomy | `packages/schema/src/missions.ts`<br>`packages/runtime/src/missions/authority-tiers.ts`<br>`packages/runtime/src/missions/authority-tiers.test.ts` | 🟢 **100% Done**<br>Derived from `OPR-AGT-001` & `OPR-AGT-002`. | None. 4 interaction modes, authority tiers, envelope validation, earned promotion and demotion triggers verified with 15/15 tests passing. |
| **`V2-02`** | **G2 / WS06** | Key Separation & Untrusted Model Candidates | `packages/schema/src/missions.ts`<br>`packages/runtime/src/missions/model-boundary.ts`<br>`packages/runtime/src/missions/model-boundary.test.ts` | ⚪ **Not Started**<br>Derived from `OPR-AGT-003` & `OPR-AGT-004`. | Separate consumer keys (runtime read/propose) from builder keys (development without prod authority). Treat LLM outputs as untrusted candidates with prompt injection immunity and typed registry checks. |
| **`V2-03`** | **G2 / WS06** | Verifiable Mission Objectives & Planning DAGs | `packages/schema/src/missions.ts`<br>`packages/runtime/src/missions/mission-runner.ts`<br>`packages/runtime/src/missions/mission-runner.test.ts` | ⚪ **Not Started**<br>Derived from `OPR-FULL-021` & `OPR-FULL-023`. | Implement TaskMandate and Mission lifecycle with observable success predicates, time horizons, budgets, and stop conditions. Enforce that planners cannot self-certify success and all plan steps conform to published grants. |
| **`V2-04`** | **G2 / WS06** | Active Evidence Acquisition & Governed Memory | `packages/runtime/src/missions/evidence-acquisition.ts`<br>`packages/runtime/src/missions/agent-memory.ts`<br>`packages/runtime/src/missions/agent-memory.test.ts` | ⚪ **Not Started**<br>Derived from `OPR-FULL-022` & `OPR-AGT-005`. | Register evidence acquisition as governed actions within grants. Provide reconstructable tool/evidence telemetry traces without private unverified state. Enforce cross-tenant isolation in agent memory. |
| **`V2-05`** | **G2 / WS06** | Replaceable Model Gateway & 4C Readiness | `packages/runtime/src/missions/model-gateway.ts`<br>`packages/runtime/src/missions/model-gateway.test.ts` | ⚪ **Not Started**<br>Derived from `OPR-FULL-024`, `OPR-FULL-025`, `OPR-CTX-001`. | Provider-neutral model gateway with evaluation suites, input classification, token budgeting. Enforce that context fidelity does not bypass canonical 4C-L1 state correctness. |
| **`V2-06`** | **G2 / WS06** | Typed Read Functions & L2 Context Verification | `packages/schema/src/functions.ts`<br>`packages/runtime/src/functions/`<br>`packages/runtime/src/functions/functions.test.ts` | ⚪ **Not Started**<br>Derived from `OPR-FUN-001..006` & `OPR-L2-001..006`. | Pure typed query functions with versioned logic and cache invalidation. L2 factual contradiction detection against bitemporal evidence. |
| **`V2-07`** | **G2 / WS07** | Generated Application Surfaces | `packages/generated-ui/`<br>`packages/runtime/src/views/` | ⚪ **Not Started**<br>Derived from `S13`, `OPR-UX-*`, `OPR-ORG-*`. | Dynamic/disposable generated UI surfaces over kernel contracts. Strict state distinction (accepted, proposed, running, confirmed, hypothetical). Audience and tenant isolation. Zero UI expansion of authority. |
| **`V2-08`** | **G2 / WS08** | Recipes, Skills & Enterprise Composition | `packages/recipes/`<br>`packages/skills/`<br>`examples/` | ⚪ **Not Started**<br>Derived from `S14`, `OPR-HC-*`, `OPR-WW-*`. | Package contracts for multi-domain capabilities. Execute composition journeys (J1-J4) across two unrelated recipes and one generated app with survival across regeneration and migration. |

---

## 3. Immediate Next Execution: `V2-02` (Key Separation & Untrusted Model Candidates)

With `V2-01` resolved, the next ticket is `V2-02` (Workstream `WS06 - Missions and agent runtime`), addressing:

1. **Consumer vs Builder Key Separation (`OPR-AGT-003`)**:
   - Consumer keys: allow read and propose against authorized models; cannot alter definition releases, schemas, or security policies.
   - Builder keys: allow authoring in isolated dev workspaces/sandboxes; cannot read/write production business data or approve own proposals.
2. **Deterministic Authority over Model Candidates (`OPR-AGT-004`)**:
   - LLM outputs are treated as untrusted candidates, never authorizations or admitted facts.
   - Immune to prompt injection: model cannot mint authority, approve proposals, or bypass type/schema validations.
   - Typed registry/schema/policy checks reject or quarantine unsupported outputs.
