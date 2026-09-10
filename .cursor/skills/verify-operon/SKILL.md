---
name: verify-operon
description: "End-to-end verification harness and workflow for the Operon runtime, governance pipeline, bitemporal storage, action inbox, decision readiness, OMS, model sandbox, and MCP server."
---

# Verify Operon

`verify-operon` provides an end-to-end, automated, and repeatable verification workflow for the entire Operon codebase. It tests the system exactly as a real user or autonomous coding agent would—using the official `@operon/cli` interface and runtime harnesses to validate all operational, governance, and safety guarantees.

---

## 1. Launch

The Operon runtime runs headlessly in standard Node.js environments (v20+), requiring zero external daemons for in-memory operation, with optional SQLite bitemporal persistence.

### Prerequisites Check

```bash
node -v # Must be >= 20.0.0
pnpm --version # Package manager
```

### Building the CLI

Before driving verifications, ensure packages are built:

```bash
pnpm --filter @operon/cli build
```

### Executable Binary

The binary can be invoked directly from the workspace:

```bash
# Direct node execution:
node packages/cli/dist/bin.js --help

# Or via pnpm binary link:
pnpm --filter @operon/cli run operon --help
```

### Launching the Stdio MCP Server

For agent or Claude Desktop integration:

```bash
node packages/cli/dist/bin.js mcp start
```

Readiness is signaled when the process listens on `stdin` and writes JSON-RPC 2.0 messages to `stdout`.

---

## 2. Doctor

The `doctor` command executes instant preflight sanity checks against Node.js version, Effect runtime fibers, storage engines, cryptographic audit hash chains, and the Action Inbox.

### Human-Readable Doctor

```bash
node packages/cli/dist/bin.js doctor
```

### Machine-Parsable Doctor (Structured JSON)

```bash
node packages/cli/dist/bin.js doctor --json
```

**Expected Result:**

```json
{
  "checks": [
    {
      "name": "Runtime Engine",
      "status": "PASS",
      "details": "Node.js v24.21.0 (requires >= 20.0.0)"
    },
    {
      "name": "Effect Runtime",
      "status": "PASS",
      "details": "Effect 4.0.0-rc.112 initialized and executing pure fibers"
    },
    {
      "name": "Storage Engine",
      "status": "PASS",
      "details": "Initialized in-memory object store with pre-seeded ontologies"
    },
    {
      "name": "Audit Store Hash Chain",
      "status": "PASS",
      "details": "Audit store cryptographic hash chain verified (holds=true)"
    },
    {
      "name": "Action Inbox",
      "status": "PASS",
      "details": "Action Inbox online with 0 pending proposals"
    }
  ],
  "overallStatus": "HEALTHY",
  "timestamp": 1789043804484
}
```

If any check reports `FAIL`, halt execution and resolve the environment failure before running feature verifications.

---

## 3. Drive

Operon features are driven using the `@operon/cli` command suite. Every command adheres to the `/cli-for-agents` standard: non-interactive flags, layered `--help` with examples, fast failure, and `--json` outputs.

### Quick Command Matrix

| Target Feature | CLI Invocation | Verification Goal |
| --- | --- | --- |
| **Decision Readiness** | `operon readiness check Patient P001 --json` | Evaluates 4C gates (Completeness, Correctness, Currentness, Consistency) |
| **Dry-Run Action** | `operon action submit update_vitals --params '{"patientId":"P001","heartRate":78}' --dry-run --json` | Validates schema without committing state |
| **Tier 4 Autonomy** | `operon action submit update_vitals --params '{"patientId":"P001","heartRate":78}' --agent-tier 4 --json` | Executes mutation directly through 7-step pipeline |
| **Tier 2 Proposal** | `operon action submit adjust_dose --params '{"patientId":"P001","recommendedDose":18}' --agent-tier 2 --json` | Intercepts high-risk action into Action Inbox proposal |
| **Inbox Review & Veto** | `operon inbox reject <id> --reviewer dr_li --role physician --reason "Hypoglycemia risk" --json` | Exercises human safety veto and appends override record |
| **Audit Verification** | `operon audit verify --json` | Cryptographically verifies SHA-256 chain of custody |
| **Sandbox Proof** | `operon sandbox verify predictive_vibration_model --input '{"value":12}' --iterations 3 --json` | Proves fiber determinism across repeated executions |
| **OMS Branching** | `operon oms branch create feature/clinician-ai --author lead_arch --json` | Creates isolated ontology branch for schema evolution |

See [features/README.md](features/README.md) for detailed step-by-step feature drives.

---

## 4. Evidence

Verification must produce falsifiable, permanent evidence records. Evidence artifacts are written to `.evidence/verify-operon/` under unique ISO timestamps.

### Evidence Directory Layout

```text
.evidence/verify-operon/
├── <timestamp>/
│   ├── doctor.json
│   ├── readiness-check.json
│   ├── dry-run-preview.json
│   ├── executed-action.json
│   ├── inbox-proposal.json
│   ├── safety-veto.json
│   ├── audit-hash-proof.json
│   ├── sandbox-determinism.json
│   └── oms-branch.json
└── latest -> <timestamp>
```

### Capturing Verification Evidence

To capture evidence for a feature drive:

```bash
mkdir -p .evidence/verify-operon/$(date +%Y%m%d_%H%M%S)
# Pipe structured JSON outputs directly:
node packages/cli/dist/bin.js doctor --json > .evidence/verify-operon/doctor.json
```

Or run the automated helper:

```bash
pnpm --filter @operon/cli run verify:all
```

---

## 5. Cleanup

Operon runs cleanly without lingering state. The cleanup workflow tears down ephemeral SQLite databases, terminates test MCP servers, and resets transient processes without deleting `.evidence/verify-operon/`.

### Cleanup Commands

```bash
# 1. Kill any background MCP processes
pkill -f "operon mcp" 2>/dev/null || true

# 2. Clean temporary test databases
rm -f /tmp/operon-test-*.db* .tmp-test-*.db*

# 3. Verify evidence is preserved
ls -la .evidence/verify-operon/
```

---

## 6. Helpers

Ready-to-run verification scripts located in `helpers/`:

- `helpers/verify-all.ts`: Executes end-to-end verification across all 7 features, validates cryptographic chains, and writes complete evidence dossiers.
- `helpers/cleanup.ts`: Safe cleanup runner.
