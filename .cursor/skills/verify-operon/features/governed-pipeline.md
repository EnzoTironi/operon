# Governed Write Pipeline Specification

The Governed Write Pipeline is Operon's core transactional engine for state mutations. It enforces strict boundary checks before any state alteration or ledger commit can take place.

---

## Sub-features

1. **7-Step Transaction Lifecycle**:
   - **Step 1 - Authentication & Subject Context**: Verifies caller identity, security roles, and autonomy tier.
   - **Step 2 - Parameter Schema Decoding**: Uses Effect Schema to validate and type-check inputs strictly.
   - **Step 3 - Precondition Verification**: Evaluates domain guards against current point-in-time ontology state.
   - **Step 4 - Dry-Run Simulation**: Optionally projects prospective changes without modifying storage or ledger.
   - **Step 5 - Pure Mutation Generation**: Produces new immutable object snapshots with incremented version numbers.
   - **Step 6 - Atomic State Commit**: Persists updated objects in bitemporal storage (in-memory or SQLite).
   - **Step 7 - Cryptographic Decision Recording**: Computes SHA-256 canonical digest and commits an immutable `DecisionRecord` to the tamper-evident audit ledger.
2. **4-Tier Bounded Autonomy Model**:
   - **Tier 1 (Informational)**: Read-only access; action submissions are automatically rejected.
   - **Tier 2 (Advisory / Human-in-the-Loop)**: High-risk or clinical actions are routed into the Action Inbox as pending proposals.
   - **Tier 3 (Conditional Autonomy)**: Automated execution allowed only if safety bounds and pre-approval conditions hold.
   - **Tier 4 (Bounded Autonomous Execution)**: Direct execution within strictly defined operational boundaries.
3. **Safe Dry-Run Previews**:
   - Allows agents and humans to simulate an action execution without side effects via `--dry-run`.
4. **Pipeline and Stdin Compatibility**:
   - Accepts parameter payloads from shell pipes (`--stdin`) for headless CI/CD integration.

---

## How to get to it (user POV)

- **CLI**: `operon action list` and `operon action submit <actionId> [flags]`
- **OSDK**: `client.actions.<actionName>.execute(params)` or `.dryRun(params)`
- **MCP Server**: Autonomous agents invoke tool `execute_action` or `preview_action`

---

## Driving it with operon CLI

### 1. List Registered Actions

```bash
node packages/cli/dist/bin.js action list --json
```

**Expected Output:**

```json
[
  {
    "id": "update_vitals",
    "name": "Update Vitals",
    "riskTier": "low",
    "minimumAgentTier": 1,
    "defaultExecutionMode": "automated",
    "targetObjectTypeId": "Patient"
  },
  {
    "id": "adjust_dose",
    "name": "Adjust Dose",
    "riskTier": "high",
    "minimumAgentTier": 2,
    "defaultExecutionMode": "proposal",
    "targetObjectTypeId": "Patient"
  }
]
```

### 2. Preview Action with `--dry-run`

Simulates parameter validation and route determination without mutating state:

```bash
node packages/cli/dist/bin.js action submit update_vitals \
  --params '{"patientId":"P001","heartRate":78}' \
  --dry-run \
  --json
```

**Expected Output:**

```json
{
  "actionId": "update_vitals",
  "riskTier": "low",
  "agentTier": 2,
  "subject": "cli_agent",
  "parametersValid": true,
  "mode": "automated",
  "dryRun": true
}
```

### 3. Execute Action under Tier 4 Autonomy

```bash
node packages/cli/dist/bin.js action submit update_vitals \
  --params '{"patientId":"P001","heartRate":82}' \
  --agent-tier 4 \
  --json
```

**Expected Output:**

```json
{
  "status": "EXECUTED",
  "decisionRecordId": "decision_1789043815146_kxe2k",
  "recordHash": "f4bb11ed38168f051631238f6dc43f15be8e2bd75fe3e134eca4dea2ffadcc2a",
  "updatedObjectsCount": 1
}
```

### 4. High-Risk Action Proposal Route (Tier 2)

```bash
node packages/cli/dist/bin.js action submit adjust_dose \
  --params '{"patientId":"P001","recommendedDose":18}' \
  --agent-tier 2 \
  --json
```

**Expected Output:**

```json
{
  "status": "PROPOSAL_CREATED",
  "decisionRecordId": "proposal_1789043815146_x6vwb",
  "proposalId": "proposal_1789043815146_x6vwb",
  "recordHash": "33d84e621f6086a80c0e9ce9adf97e6cde01b71f18c29531e795664d45b3088b"
}
```

### 5. Stdin / Pipeline Ingestion

```bash
echo '{"patientId":"P001","heartRate":76}' | \
  node packages/cli/dist/bin.js action submit update_vitals --stdin --agent-tier 4 --json
```

---

## Gotchas

1. **Parameter Type Rigidity**: Parameters must strictly match the action's Effect Schema (e.g. numbers cannot be passed as strings).
2. **Autonomy Elevation**: An agent with `--agent-tier 2` cannot force execution of a high-risk action. It will unconditionally route to `PROPOSAL_CREATED`.
3. **Audit Ledger Hash Commitment**: Every executed action appends to the audit ledger. Reverting state requires submitting a compensating action, preserving full audit history.
