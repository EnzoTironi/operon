# Model Execution Sandbox Specification

The Model Execution Sandbox isolates computational, predictive, and ML inference models within pure Effect fibers, enforcing strict timeout bounds, capability isolation, and deterministic replayability proofs.

---

## Sub-features

1. **Pure Effect Fiber Isolation**:
   - Models run inside isolated Effect fibers with zero ambient authority.
   - Resource lifecycle and memory usage are bound to the fiber lifetime.
2. **Timeout Boundaries**:
   - Every registered model specifies a strict `timeoutMs` threshold.
   - Runaway algorithms, deadlocks, or long-running inference tasks are aborted deterministically without hanging the host process.
3. **Deterministic Replayability Proofs**:
   - Verifies whether repeated executions of a model with identical inputs yield identical outputs.
   - Essential for regulatory compliance in clinical and aerospace domains where automated recommendations must be reproducible.
4. **Input Contract Validation**:
   - The sandbox verifies `requiredInputs` before invoking the model's compute function.

---

## How to get to it (user POV)

- **CLI**: `operon sandbox verify <modelId> --input <json> [--iterations <n>] [--json]`
- **Runtime**: `SandboxedModelRunner.registerModel()` and `SandboxedModelRunner.runModel()`

---

## Driving it with operon CLI

### 1. Verify Model Determinism (3 Iterations)

```bash
node packages/cli/dist/bin.js sandbox verify predictive_vibration_model \
  --input '{"value":12}' \
  --iterations 3 \
  --json
```

**Expected Output:**

```json
{
  "modelId": "predictive_vibration_model",
  "iterations": 3,
  "allOutputsMatch": true,
  "samples": [
    { "prediction": 18, "status": "computed" },
    { "prediction": 18, "status": "computed" },
    { "prediction": 18, "status": "computed" }
  ]
}
```

### 2. Human-Readable Output

```bash
node packages/cli/dist/bin.js sandbox verify predictive_vibration_model \
  --input '{"value":12}' \
  --iterations 3
```

**Output:**

```text
=== MODEL DETERMINISM & ISOLATION PROOF ===
Model: predictive_vibration_model
Iterations Tested: 3
Deterministic: YES (All outputs identical)
Sample Output: { "prediction": 18, "status": "computed" }
```

---

## Gotchas

1. **Missing Required Inputs**: If an input key specified in `requiredInputs` is absent, the sandbox rejects execution with an input validation error.
2. **Side-Effect Leaks**: Non-deterministic functions (e.g. unseeded random numbers or live clocks) will cause `allOutputsMatch` to be `false`.
3. **Execution Timeout**: Compute functions that exceed `timeoutMs` are interrupted by Effect's fiber cancellation.
