# Operon (Operational Ontology & Decision Runtime)

> **The Type-Safe Operational Ontology and Decision Runtime for AI Agents and Enterprise Systems.**  
> Built natively with [Effect TypeScript](https://effect.website/) and deployed via [Alchemy](https://alchemy.run).

Based on the architectural principles and formal verification frameworks from _Operational Ontology: From Business Mirror to Decision Runtime_ (Bailing Zhang, 2026).

---

## The Problem: Decision-Trust Collapse

Enterprises have spent a decade building data lakes, vector databases, and RAG systems to **know** things (the read path). However, business value is created only when systems **act** (the write path): adjusting an insulin dose, changing a chemical plant setpoint, or issuing a compliance waiver.

When autonomous LLM agents or AI decision systems attempt actions without an operational ontology, they suffer **Decision-Trust Collapse**:

1. **The Semantics Problem**: Crucial evidence remains unstructured in free text (e.g. nursing handover notes: _"ate half breakfast"_).
2. **The State Problem**: The system acts on stale, lagging projections rather than decision-ready real-time state.
3. **The Action Problem**: LLMs act without deterministic guards, transactional boundaries, or failure compensation.
4. **The Governance Problem**: Frontline human vetoes and overrides are lost, breaking the organizational learning loop.

**Operon fills this gap.** It turns enterprise databases, APIs, and telemetry into a **computable, governed mirror of the business world**, allowing AI agents (via MCP) and human experts (via Action Inboxes) to safely perceive state, check 4C invariants, execute actions through a strict 7-step write pipeline, and generate replayable audit dossiers.

---

## Key Features

- **Four Responsibility Planes**:
  - **Data Plane**: Bitemporal business objects, properties, relationships (Links), and freshness budgets.
  - **Logic Plane**: Derived properties and deterministic guard functions.
  - **Action Plane**: Governed state transitions with staged edits and Saga rollback compensation.
  - **Security Plane**: Cross-cutting property-level ABAC, hash-chained `DecisionRecord`s, and first-class human overrides.
- **Two-Level 4C Decision Readiness**: $$\text{DecisionReadiness} = \text{Correct} \land \text{Complete} \land \text{Current} \land \text{Consistent}$$
- **The 7-Step Governed Write Pipeline**:
  1. Parameter Schema Validation
  2. Subject & Agent Authorization Tier Verification
  3. Submission Criteria & Freshness Budget Verification
  4. Staged Logic Execution (pure Effect computation)
  5. Funnel Merge (optimistic concurrency & CDC stream reconciliation)
  6. Cryptographic `DecisionRecord` Dossier Generation
  7. Side Effects with Saga Compensation
- **Model Context Protocol (MCP) Server**:
  - **Dual Key Isolation**: Consumer Key (queries & bounded actions) vs. Builder Key (schema changes).
  - **Dynamic Tool Schema Projection**: Automatically converts `@operon/schema` Action cards into MCP tools.
  - **4-Tier Agent Authorization Ladder**:
    1. _Observe_ (Read-only)
    2. _Propose_ (Action Inbox proposal)
    3. _Execute with Approval_ (Human confirms)
    4. _Bounded Autonomy_ (Automatic execution within risk envelopes)
- **Edge-First Infrastructure as Effects via Alchemy (`alchemy.run`)**:
  - Serverless deployment to **Cloudflare** (Workers edge gateway, D1 database, R2 audit vault, Queues).

---

## Monorepo Architecture

```text
packages/
├── @operon/schema         # Declarative modeling language (Objects, Properties, Links, Actions)
├── @operon/runtime        # 4C readiness, 7-step write pipeline, Action Inbox, DecisionRecords
├── @operon/mcp            # Model Context Protocol server & tool projection for Claude / Cursor
└── @operon/alchemy        # Cloudflare serverless edge infrastructure (alchemy.run)
examples/
└── @operon/example-healthcare-cdss # Complete Chapter 1 Clinical CDSS simulation
```

---

## Quickstart

### 1. Installation

```bash
pnpm install
pnpm build
pnpm test
```

### 2. Defining an Object Type and Action

```typescript
import { Schema } from "effect";
import {
  defineObjectType,
  defineActionType,
  defineProperty,
} from "@operon/schema";

// Define a business object with freshness budget
export const Patient = defineObjectType({
  id: "Patient",
  name: "Patient",
  description: "Hospital Inpatient",
  typology: "master",
  primaryKey: "patientId",
  properties: {
    patientId: defineProperty({
      schema: Schema.String,
      description: "Patient ID",
      required: true,
    }),
    eGFR: defineProperty({
      schema: Schema.Number,
      description: "Renal eGFR",
      required: true,
      freshnessBudget: {
        maxStalenessMs: 24 * 60 * 60 * 1000,
        onStale: "escalate_to_human",
      },
    }),
  },
});

// Define a governed Action with Submission Criteria
export const AdjustDoseAction = defineActionType({
  id: "adjust_dose",
  name: "Adjust Insulin Dose",
  description: "Adjust bedtime basal insulin dosage",
  parametersSchema: Schema.Struct({
    patientId: Schema.String,
    proposedDose: Schema.Number.pipe(
      Schema.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
    ),
  }),
  riskTier: "high",
  defaultExecutionMode: "proposal",
  minimumAgentTier: 2, // Routes to Action Inbox for review
  submissionCriteria: [
    {
      id: "safe_ceiling_check",
      description: "Dose must not exceed 50U without specialist confirmation",
      evaluate: (params) =>
        Effect.succeed({
          passed: params.proposedDose <= 50,
          verdict: params.proposedDose <= 50 ? "allow" : "review",
          failureReason:
            params.proposedDose > 50 ? "Exceeds 50U threshold" : undefined,
        }),
    },
  ],
});
```

### 3. Running the Chapter 1 Clinical CDSS Demo

To run the anchoring case study simulation demonstrating how Operon intercepts ungrounded recommendations, structures observations, and tracks human physician overrides:

```bash
pnpm --filter @operon/example-healthcare-cdss run demo
```

---

## Commercial Licensing & Cloud Offering

- **Core Engine & MCP Gateway**: Open Source (Apache 2.0 / MIT).
- **Operon Cloud (Enterprise SaaS)**:
  - Managed Multi-Tenant Edge Gateway deployed with Alchemy.
  - Action Inbox Web Dashboard for human-in-the-loop approvals.
  - Cryptographic DecisionRecord Vault (FDA 21 CFR Part 11, SOC2, HIPAA).
  - Rejection Compass: Analytics dashboard tracking frontline override reasons to tune agent reliability.

---

## Citation & Intellectual Foundations

This product implements the concepts formulated in:

> Zhang, Bailing. _Operational Ontology: From Business Mirror to Decision Runtime_. First Public Edition, Zenodo, 2026. DOI: [10.5281/zenodo.21896938](https://doi.org/10.5281/zenodo.21896938).
