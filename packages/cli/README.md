# @operon/cli

The official command-line interface for **Operon**, built natively on **Effect 4.0.0-rc.112**.

`@operon/cli` exposes complete operational controls over the Operon runtime—evaluating 4C decision readiness, executing governed write pipelines under bounded agent autonomy tiers, managing human-in-the-loop Action Inboxes, verifying cryptographic audit chains, executing model sandbox replays, and running MCP stdio servers.

---

## Installation & Execution

```bash
# Build package
pnpm --filter @operon/cli build

# Direct execution via Node (ESM)
node packages/cli/dist/bin.js <command> [options]

# Or via package manager alias
pnpm operon <command> [options]
```

---

## Core Commands

### 1. `doctor`

Runs preflight system integrity checks across Node.js runtime, Effect fibers, storage context, audit hash chain, and Action Inbox.

```bash
operon doctor
operon doctor --json
operon doctor --db ./operon.db
```

### 2. `object`

Reads, commits, or inspects bitemporal point-in-time snapshots of ontology objects.

```bash
# Get object
operon object get Patient P001 --json

# Put / mutate object
operon object put --type Patient --id P002 --properties '{"name":"Alice","egfr":70}'

# Bitemporal query plan inspection
operon object query Patient P001 --valid-time 1789000000000 --tx-time 1789000000000 --json
```

### 3. `readiness`

Evaluates Two-Level 4C Decision Readiness ($$\text{Ready} = \text{Correct} \land \text{Complete} \land \text{Current} \land \text{Consistent}$$).

```bash
operon readiness check Patient P001
operon readiness check Patient P001 --json
```

### 4. `action`

Submits governed actions into the 7-step write pipeline with support for dry-run validation, parameter payloads, and agent autonomy tiers (1–4).

```bash
# List registered action types
operon action list --json

# Dry-run action without mutating state
operon action submit update_vitals --params '{"patientId":"P001","heartRate":72}' --agent-tier 4 --dry-run

# Execute under Tier 4 bounded autonomy
operon action submit update_vitals --params '{"patientId":"P001","heartRate":75}' --agent-tier 4

# Submit action under Tier 2 (automatically routes to Action Inbox as a proposal)
operon action submit set_valve_position --params '{"tankId":"tank-alpha","openingPercent":45}' --agent-tier 2
```

### 5. `inbox`

Manages human-in-the-loop proposal reviews, approvals, and structured safety veto overrides.

```bash
# List pending proposals
operon inbox list --json

# Approve proposal
operon inbox approve <proposalId> --reviewer dr_chen --comments "Approved after vitals stabilization"

# Exercise safety veto override
operon inbox reject <proposalId> --reviewer dr_chen --reason "Clinical judgment: acute renal trend"
```

### 6. `audit`

Inspects and cryptographically verifies the SHA-256 continuous hash chain of the immutable `DecisionRecord` ledger.

```bash
# List recent audit ledger entries
operon audit list --limit 10 --json

# Cryptographically verify hash-chain integrity
operon audit verify --json
```

### 7. `oms`

Manages branches and multi-stakeholder proposals in the Ontology Metadata Service (OMS).

```bash
# Create feature branch
operon oms branch create feature/high-rate-sensors --author lead_arch --json

# Create schema change proposal
operon oms proposal create --branch feature/high-rate-sensors --title "Add Sensor schema" --author lead_arch

# Review proposal
operon oms proposal review <proposalId> --reviewer compliance_officer --verdict approve --comments "GDPR compliant"

# Merge proposal into branch
operon oms proposal merge <proposalId> --author lead_arch
```

### 8. `sandbox`

Executes determinism and replay proofs for analytical and predictive models.

```bash
operon sandbox verify predictive_vibration_model --inputs '{"value":14.2}' --iterations 3 --json
```

### 9. `mcp`

Launches the Model Context Protocol (MCP) server over standard input/output (`stdio`) for integration with Claude Desktop, Cursor, and AI agents.

```bash
operon mcp start --agent-tier 4
operon mcp start --agent-tier 2 --db ./operon.db
```

### 10. `telemetry`

Inspects production observability status, Sentry & PostHog connectivity, and sends diagnostic pings.

```bash
operon telemetry status
operon telemetry status --ping --json
```

---

## Architecture

The CLI is structured as a pure Effect application:

- `dispatchCommand(command, args)` returns `Effect.Effect<number, unknown, never>`.
- `runCli(argv)` wraps command execution with `Effect.annotateLogs({ cliCommand })`, captures command telemetry duration, exit codes, and errors, flushes telemetry safely, and returns `Effect.Effect<number, never, never>`.
- Integrated with `OperonTelemetryService.getInstance().getLoggerLayer()` so that all `Effect.logInfo`, `Effect.logWarning`, and `Effect.logError` emissions stream directly to Sentry breadcrumbs/errors and PostHog.
