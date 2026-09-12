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
| **`V2-02`** | **G2 / WS06** | Key Separation & Untrusted Model Candidates | `packages/schema/src/missions.ts`<br>`packages/runtime/src/missions/model-boundary.ts`<br>`packages/runtime/src/missions/model-boundary.test.ts` | 🟢 **100% Done**<br>Derived from `OPR-AGT-003` & `OPR-AGT-004`. | None. Key scope separation (consumer runtime vs builder dev), prompt injection immunity, reserved authority field rejection, and typed admission/quarantine verified with 14/14 tests passing. |
| **`V2-03`** | **G2 / WS06** | Verifiable Mission Objectives & Planning DAGs | `packages/schema/src/missions.ts`<br>`packages/runtime/src/missions/mission-runner.ts`<br>`packages/runtime/src/missions/mission-runner.test.ts` | 🟢 **100% Done**<br>Derived from `OPR-FULL-021` & `OPR-FULL-023`. | None. Mission lifecycle with observable success predicates, cycle-free planning DAGs, envelope/budget/risk validation, mandatory constraint enforcement regardless of score, and prevention of fictional success verified with 14/14 tests passing. |
| **`V2-04`** | **G2 / WS06** | Active Evidence Acquisition & Governed Memory | `packages/runtime/src/missions/evidence-acquisition.ts`<br>`packages/runtime/src/missions/agent-memory.ts`<br>`packages/runtime/src/missions/agent-memory.test.ts` | 🟢 **100% Done**<br>Derived from `OPR-FULL-022` & `OPR-AGT-005`. | None. Governed evidence acquisition within envelope/budget without fact fabrication on missing sources, strict cross-tenant memory isolation, TTL expiration, authority injection defense, and reconstructable task execution traces verified with 9/9 tests passing. |
| **`V2-05`** | **G2 / WS06** | Replaceable Model Gateway & 4C Readiness | `packages/runtime/src/missions/model-gateway.ts`<br>`packages/runtime/src/missions/model-gateway.test.ts` | 🟢 **100% Done**<br>Derived from `OPR-FULL-024`, `OPR-FULL-025`, `OPR-CTX-001`. | None. Provider-neutral model gateway with evaluation suites, benchmark-gated promotion to production routing, 4C state readiness verification over linguistic context fidelity, and graceful outage fallback with telemetry verified with 5/5 tests passing. |
| **`V2-06`** | **G2 / WS06** | Typed Read Functions & L2 Context Verification | `packages/schema/src/functions.ts`<br>`packages/schema/src/context-verification.ts`<br>`packages/runtime/src/functions/`<br>`packages/runtime/src/context/` | 🟢 **100% Done**<br>Derived from `OPR-FUN-001..006` & `OPR-L2-001..006`. | None. Pure typed query functions, staged edit discipline, materialized cache invalidation, model applicability envelopes, six-part predictions, rule precedence over model scores, L2 ground truth verification, Must-Answer completeness templates, citation resolution, communication compliance, and human extraction admission verified with 26/26 tests passing. |
| **`V2-07`** | **G2 / WS07** | Generated Application Surfaces | `packages/generated-ui/`<br>`packages/runtime/src/views/` | 🟢 **100% Done**<br>Derived from `S13`, `OPR-UX-*`, `OPR-ORG-*`. | None. State distinction (accepted vs proposed), channel equivalence (Button, API, Agent Tool all denied on closed object), accessible keyboard navigation, room audience revocation with instant cache purging, Decision Canvas 8-stage deliverables, hostile script sanitization, shadow evaluation, and operational telemetry verified with 17/17 tests passing. |
| **`V2-08`** | **G2 / WS08** | Recipes, Skills & Enterprise Composition | `packages/recipes/`<br>`packages/skills/`<br>`examples/` | 🟢 **100% Done**<br>Derived from `S14`, `OPR-HC-*`, `OPR-WW-*`, `S00-PROGRAM`. | None. Two unrelated builtin recipes (`HealthcareClinicalPack` and `WaterWastewaterPack`), 7 domain skills, Order-to-Cash journey J1 (`OPR-FULL-039`), specialized inventory concurrency invariant (`OPR-FULL-040`), package qualification evaluator (`OPR-FULL-041`), legacy writer cutover fencing (`OPR-FULL-042`), clinical extraction with human confirmation (`OPR-HC-001`), plant recirculation loop traversal (`OPR-WW-001`), and multi-recipe/generated-app migration survival (`G2-EXIT-001`) verified with 15/15 tests passing. |

---

## 3. Gate G2 Completion & Verification Summary

All eight critical path tickets for **Gate G2 (Operon V2)** have been implemented, verified, and closed:

1. **`V2-01` (WS06)**: Authority Tiers and Bounded Autonomy (15/15 tests).
2. **`V2-02` (WS06)**: Key Separation & Untrusted Model Candidates (14/14 tests).
3. **`V2-03` (WS06)**: Verifiable Mission Objectives & Planning DAGs (14/14 tests).
4. **`V2-04` (WS06)**: Active Evidence Acquisition & Governed Memory (9/9 tests).
5. **`V2-05` (WS06)**: Replaceable Model Gateway & 4C Readiness (5/5 tests).
6. **`V2-06` (WS06)**: Typed Read Functions & L2 Context Verification (26/26 tests).
7. **`V2-07` (WS07)**: Generated Application Surfaces & Channel Equivalence (17/17 tests).
8. **`V2-08` (WS08)**: Recipes, Skills & Enterprise Composition (15/15 tests).

**S00-PROGRAM Gate G2 Exit Criterion Satisfied**:

> _"V2/G2 exits only when two unrelated recipes and one generated application use public kernel contracts and survive regeneration and migration."_

- **Recipe 1**: `HealthcareClinicalPack` (`healthcare.Patient`, `healthcare.DosageOrder`, `healthcare.ClinicalObservation`, `healthcare.TriageRecord`, with `DosageVerificationSkill` and `ClinicalHandoffExtractionSkill`).
- **Recipe 2**: `WaterWastewaterPack` (`water.TreatmentPlant`, `water.AerationTank`, `water.ChemicalDoser`, `water.TelemetrySensor`, `water.EffluentSample`, with `ChemicalDosingDossierSkill` and `TelemetryLoopInspectionSkill`).
- **Generated Application**: Disposable state-distinct application surface (`renderStateDistinctCard`, `renderAccessibleTable`, `renderDecisionCanvas`) running over public kernel contracts.
- **Migration & Regeneration Survival**: Pinned RFC 8785 canonical manifests, deterministic digests, and legacy writer cutover fencing verified.

**Next Milestone**: Gate **G3 (Operon V3: Federation, Factory, Sovereign Operations & Formal Assurance)**.
