# @operon/runtime

The core execution engine for **Operon**, powering governed pipelines, 4C decision readiness, bitemporal point-in-time state, action inboxes, cryptographic audit ledgers, and formal verification.

---

## Key Modules

- **The 7-Step Governed Write Pipeline (`write-pipeline.ts`)**: Enforces 7 sequential safety gates before any operational mutation is committed to persistent state:
  1. Parameter Schema Validation.
  2. Subject & Agent Tier Verification.
  3. Submission Criteria & Freshness Budget Verification.
  4. Pure Staged Logic Execution.
  5. Funnel Merge (optimistic concurrency & CDC stream reconciliation).
  6. Cryptographic `DecisionRecord` Dossier Generation.
  7. Side Effects with Saga Compensation Rollback.
- **Two-Level 4C Decision Readiness (`readiness.ts`)**: Evaluates whether operational state is qualified for an autonomous decision: $$\text{Ready} = \text{Correct} \land \text{Complete} \land \text{Current} \land \text{Consistent}$$
- **Action Inbox & Structured Veto (`inbox.ts`)**: Routes high-risk actions to human reviewers, records structured veto overrides, and powers frontline organizational learning.
- **Immutable Cryptographic Audit Store (`audit.ts`)**: SHA-256 continuous hash chain capturing full decision lineage, input parameters, agent identity, and state deltas.
- **Bitemporal Point-in-Time Engine (`bitemporal-store.ts`, `sql-store.ts`)**: Maintains dual time axes—**Valid Time** (when the fact was true in the real world) and **Transaction Time** (when the system recorded it).
- **Ontology Metadata Service (`oms.ts`)**: Git-like branching, schema change proposals, multi-stakeholder approval policies, and non-destructive migrations.
- **Sandboxed Model Runner (`sandbox.ts`)**: Executes analytical and predictive models in isolated, deterministic fibers with automated determinism and replay proofs.
- **Dynamic Security Engine (`security-views.ts`)**: Row-level Restricted Views (RV) and Column-level Multi-Dataset Objects (MDO) evaluating access per subject role and data classification.
- **Operational Resilience (`resilience.ts`)**: Circuit breakers, degraded execution modes (`normal`, `veto_only`, `read_only`), and composite system health maps.

---

## Testing & Quality Assurance

All runtime components are tested using **aggressive declarative specifications** with 100% pass rates across unit, property-based (`fast-check`), chaos, and adversarial stress tests.
