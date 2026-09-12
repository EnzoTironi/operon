# Operon (Operational Ontology & Decision Runtime)

> **The Type-Safe Operational Ontology and Decision Runtime for AI Agents and Enterprise Systems.**  
> Built natively with [Effect TypeScript](https://effect.website/) (`effect@4.0.0-rc.112`) and deployed via [Alchemy](https://alchemy.run).

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

## Monorepo Architecture

The workspace is organized into a modular pnpm monorepo of core packages under `packages/`:

### Core Packages (`packages/`)

| Package | Description |
| :-- | :-- |
| [`@operon/schema`](file:///Users/enzotironi/operationalonto/packages/schema/README.md) | Declarative domain modeling language (Objects, Properties, Links, ValueTypes, Actions, Freshness Budgets). |
| [`@operon/runtime`](file:///Users/enzotironi/operationalonto/packages/runtime/README.md) | The 7-step write pipeline, 4C readiness engine, Action Inbox, Bitemporal storage, OMS, and Model Sandbox. |
| [`@operon/cli`](file:///Users/enzotironi/operationalonto/packages/cli/README.md) | Official command-line interface built on pure Effect fibers (`doctor`, `object`, `readiness`, `action`, etc.). |
| [`@operon/telemetry`](file:///Users/enzotironi/operationalonto/packages/telemetry/README.md) | Production observability (Sentry + PostHog), PII/secret scrubbing, Effect log layers, and distributed tracing. |
| [`@operon/osdk`](file:///Users/enzotironi/operationalonto/packages/osdk/README.md) | Type-safe client SDK and TypeScript code generator for frontend and service integration. |
| [`@operon/mcp`](file:///Users/enzotironi/operationalonto/packages/mcp/README.md) | Model Context Protocol server, dual-key isolation (Consumer vs Builder), and AI-FDE autonomous agents. |
| [`@operon/cell-auth`](./packages/cell-auth) | Better Auth on the cell Postgres: approver sessions and the `SessionVerifier` the kernel trusts. |
| [`@operon/alchemy`](./packages/alchemy/README.md) | The cell's PostgreSQL 17 in Docker, provisioned by [Alchemy](https://alchemy.run) (`pnpm cell:up`). |

### Frozen code (`frozen/`)

The five industry example simulations and the S17/publication validation scripts are frozen out of the build, test, lint, and knip graphs. See [`frozen/README.md`](./frozen/README.md) for the index and rationale.

---

## Key Pillars & Operational Guarantees

### 1. Two-Level 4C Decision Readiness

State must pass mathematical criteria before an action can be decided: $$\text{DecisionReadiness} = \text{Correct} \land \text{Complete} \land \text{Current} \land \text{Consistent}$$

- **Level 1 (Object Readiness)**: Required fields populated, schema-valid data types, properties within freshness budgets, and intra-object invariants verified.
- **Level 2 (Structural Readiness)**: Graph referential integrity (zero dangling links) and relationship validity verified.

### 2. The 7-Step Governed Write Pipeline

Every mutation passes through 7 deterministic safety gates:

1. **Parameter Schema Validation**: Runtime Effect Schema parsing.
2. **Subject & Agent Tier Verification**: Bounded agent autonomy checks (Tiers 1–4).
3. **Submission Criteria & Freshness Budget**: Pre-conditions and maximum staleness verification.
4. **Staged Logic Execution**: Pure Effect computation with zero side effects.
5. **Funnel Merge**: Optimistic concurrency version checks and CDC stream reconciliation.
6. **Cryptographic `DecisionRecord` Generation**: Continuous SHA-256 hash-chaining of inputs, outputs, and agent identities.
7. **Side Effects with Saga Compensation**: Forward side-effects executed with automatic reverse rollback on downstream failure.

### 3. Frontline Safety Veto & Action Inbox

When high-risk actions are proposed by Tier 2 agents or boundary criteria trigger reviews:

- Actions route to the **Action Inbox** as pending proposals.
- Human specialists can approve or exercise structured safety veto overrides with category attribution (`clinical_discretion`, `regulatory_override`, etc.).
- Overrides are permanently recorded in the audit ledger to power organizational continuous learning.

### 4. Bitemporal Point-in-Time State Engine

Maintains two independent time dimensions across all entities:

- **Valid Time ($T_v$)**: When the fact was true in the real world.
- **Transaction Time ($T_x$)**: When the fact was recorded in the database. Enables instant time-travel queries (`asOfValidTime`, `asOfTransactionTime`) and retroactive corrections without mutating historical records.

---

## Running a cell

A cell is one Operon runtime with its own PostgreSQL 17. With Docker running:

```bash
pnpm install --frozen-lockfile
pnpm cell:up                 # writes the cell keys to .env and starts Postgres via Alchemy
pnpm operon doctor           # opens the cell database through OPERON_DATABASE_URL

# bind a human approver to the cell and start the MCP server as that human
pnpm operon approver session --email ana@example.com --name "Ana"
OPERON_APPROVER_SESSION_TOKEN=<token> pnpm operon mcp start

pnpm cell:down               # removes the container and, except for prod, the volume
```

`OPERON_DATABASE_URL` may also point at a SQLite file for local experiments; without it the CLI runs in memory. See [`packages/alchemy/README.md`](./packages/alchemy/README.md) for stages, ports and state.

---

## Operon CLI Reference

The CLI provides full operator and agent control over the platform:

```bash
# Preflight health checks
operon doctor [--json] [--db <path|postgres-url>]

# Bitemporal object inspection and mutation
operon object get <typeId> <id> [--json]
operon object put --type <typeId> --id <id> --properties '<json>'
operon object query <typeId> <id> --valid-time <ms> --tx-time <ms>

# 4C decision readiness evaluation
operon readiness check <typeId> <id> [--json]

# Governed action submission
operon action list [--json]
operon action submit <actionId> --params '<json>' [--agent-tier <1|2|3|4>] [--dry-run]

# Action Inbox & Human Veto
operon inbox list [--json]
operon inbox approve <id> --reviewer <id> --comments <text>
operon inbox reject <id> --reviewer <id> --reason <text>

# Cryptographic Audit Ledger Verification
operon audit list [--limit <n>] [--json]
operon audit verify [--json]

# OMS Branching Governance
operon oms branch create <branch> --author <id>
operon oms proposal create --branch <branch> --title <title> --author <id>
operon oms proposal review <id> --reviewer <id> --verdict <approve|reject>
operon oms proposal merge <id> --author <id>

# Model Sandbox Replay Proofs
operon sandbox verify <modelId> [--inputs '<json>'] [--iterations <n>]

# Launch MCP Stdio Server
operon mcp start [--agent-tier <1|2|3|4>]   # approver bound from OPERON_APPROVER_SESSION_TOKEN

# Cell approver sessions (Better Auth on the cell Postgres)
operon approver session --email <email> --name <name> [--json]

# Production Telemetry & Diagnostics
operon telemetry status [--ping] [--json]
```

---

## Enterprise Observability (Sentry & PostHog)

Operon features built-in production telemetry and dogfooding instrumentation via `@operon/telemetry`:

- **Zero-Leak Privacy**: `TelemetryDataScrubber` automatically masks secrets, passwords, tokens, SSNs, and medical record numbers, while pseudonymizing identifiers with SHA-256 hashes.
- **Sentry Integration**: Distributed tracing spans (`operon.pipeline.execute`, `operon.cli.command`), automated error capture with breadcrumb timelines.
- **PostHog Analytics**: Product telemetry tracking action submissions, execution rates, agent tier distributions, and inbox review cycles.
- **Native Effect Logging**: Custom Effect `Logger` layer captures all `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError` emissions directly into Sentry and PostHog.
- **Diagnostic Mode**: In the absence of external API keys, telemetry safely operates in no-op mode with an internal diagnostic event buffer.

---

## Aggressive Declarative Testing

Operon uses an **aggressive declarative testing** philosophy:

- Test descriptions define the formal behavior of the system as an unambiguous specification (`"does X"`, `"does X if Y"`).
- Tests act as the executable blueprint rather than passive regression catchers.
- 100% of test suites across all packages enforce this standard.

---

## Quality Gates & Verification

```bash
# Format check and auto-fix (Ultracite)
pnpm check
pnpm fix

# High-speed static analysis (Oxlint with Effect plugin)
pnpm lint

# Compile all 12 workspace packages (TypeScript Project References)
pnpm build

# Execute 100% of test suites
pnpm test

# Run End-to-End System Verification Harness (All 7 Pillars)
node --experimental-strip-types .cursor/skills/verify-operon/helpers/verify-all.ts
```

---

## Citation & Intellectual Foundations

This product implements the concepts formulated in:

> Zhang, Bailing. _Operational Ontology: From Business Mirror to Decision Runtime_. First Public Edition, Zenodo, 2026. DOI: [10.5281/zenodo.21896938](https://doi.org/10.5281/zenodo.21896938).
