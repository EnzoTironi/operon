# 4C Decision Readiness Specification

The 4C Decision Readiness engine prevents AI agents and human operators from executing decisions on incomplete, stale, erroneous, or contradictory state.

---

## Sub-features

1. **[C1] Completeness**:
   - Asserts that all mandatory properties defined on the target `ObjectType` exist and are non-null.
   - Detects partial ingestion, dropped sensor fields, or truncated ingestion records.
2. **[C2] Correctness**:
   - Validates property values against domain invariants, physical range constraints (e.g. non-negative dosages, physical bounds), and Effect Schema typings.
3. **[C3] Currentness**:
   - Enforces freshness time-to-live (TTL) on telemetry. Flags stale data where elapsed time since telemetry timestamp exceeds acceptable operational thresholds.
4. **[C4] Consistency**:
   - Checks for contradictory statuses (e.g., equipment marked both `offline` and `running`, or contradictory sensor values across redundant probes).
5. **Atomic Readiness Verdict (`isReady`)**:
   - A single boolean flag representing the strict logical conjunction: `C1 ∧ C2 ∧ C3 ∧ C4`.

---

## How to get to it (user POV)

- **CLI**: `operon readiness check <typeId> <id> [--json] [--db <path>]`
- **OSDK**: `evaluateDecisionReadiness(instance, objectType)`
- **MCP Server**: Autonomous agents invoke tool `check_decision_readiness` before suggesting interventions.

---

## Driving it with operon CLI

### 1. Evaluate Ready Patient Object

```bash
node packages/cli/dist/bin.js readiness check Patient P001 --json
```

**Expected Output:**

```json
{
  "typeId": "Patient",
  "id": "P001",
  "status": "READY",
  "readiness": {
    "isReady": true,
    "complete": { "passed": true, "missingProperties": [] },
    "correct": { "passed": true, "violations": [] },
    "current": { "passed": true, "staleProperties": [] },
    "consistent": { "passed": true, "contradictions": [] }
  }
}
```

### 2. Human-Readable Evaluation Output

```bash
node packages/cli/dist/bin.js readiness check Patient P001
```

**Output:**

```text
=== 4C DECISION READINESS EVALUATION: Patient#P001 ===
Decision Ready: YES (READY)
  [C1] Completeness: PASS
  [C2] Correctness:   PASS
  [C3] Currentness:   PASS
  [C4] Consistency:   PASS
```

### 3. Evaluate Industrial Clarifier Tank

```bash
node packages/cli/dist/bin.js readiness check ClarifierTank tank-alpha --json
```

---

## Gotchas

1. **Non-Existent ID**: Passing an unknown object ID returns exit code 1 with `Error: Object '<id>' of type '<typeId>' does not exist.`
2. **Unregistered Type**: If the `typeId` is not registered in the active ontology, the CLI fails fast with `Error: ObjectType '<typeId>' is not registered.`
3. **Telemetry Age**: If telemetry data has not been updated within the object type's TTL window, Currentness fails (`passed: false`), causing `isReady` to drop to `false`.
