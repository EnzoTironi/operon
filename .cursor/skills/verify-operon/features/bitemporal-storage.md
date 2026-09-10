# Bitemporal Storage & Cryptographic Audit Specification

Operon provides a bitemporal object store and an append-only, tamper-evident audit ledger that guarantees point-in-time reproducibility and mathematical proof of chain-of-custody.

---

## Sub-features

1. **Bitemporal Dimensions**:
   - **Valid Time**: The real-world timeframe during which an assertion was true.
   - **System / Transaction Time**: The exact timestamp when the assertion was committed to the database.
2. **Point-in-Time Historical Queries**:
   - Reconstructs the exact state of any ontology object or collection as it existed at any historical timestamp `t`.
3. **Dual-Mode Storage Architecture**:
   - **In-Memory Store (`InMemoryObjectStore`)**: Pure fiber-compatible store for sub-millisecond unit tests and ephemeral agents.
   - **SQL Bitemporal Store (`SqlBitemporalStore`)**: Production-grade SQLite (with WAL mode) or PostgreSQL engine with full SQL DDL generation.
4. **Cryptographic SHA-256 Audit Hash Chain**:
   - Every `DecisionRecord` computes a canonical SHA-256 hash incorporating its ID, action type, parameters, security subject, and the hash of the preceding record (`previousRecordHash`).
   - `verifyAuditChain` recalculates every link in sequence from the genesis block; tampering with even a single byte breaks subsequent hashes.

---

## How to get to it (user POV)

- **CLI**:
  - `operon object get <typeId> <id> [--json]`
  - `operon object query <typeId> [--valid-at <ms>] [--system-at <ms>] [--json]`
  - `operon audit list [--limit <n>] [--json]`
  - `operon audit verify [--json]`
- **OSDK**: `client.objects.<type>.get(id)` and `.asOf({ validAt, systemAt })`

---

## Driving it with operon CLI

### 1. Get Object Snapshot

```bash
node packages/cli/dist/bin.js object get Patient P001 --json
```

**Expected Output:**

```json
{
  "id": "P001",
  "typeId": "Patient",
  "version": 1,
  "lastModifiedAt": 1789043815144,
  "properties": {
    "name": "Zhang Minghua",
    "room": "302-A",
    "egfr": 52,
    "currentDose": 14
  }
}
```

### 2. Point-in-Time Historical Query

Query objects valid at a specific timestamp:

```bash
node packages/cli/dist/bin.js object query Patient --valid-at 1789043815000 --json
```

### 3. Inspect Audit Ledger

```bash
node packages/cli/dist/bin.js audit list --json
```

### 4. Cryptographically Verify Audit Chain

```bash
node packages/cli/dist/bin.js audit verify --json
```

**Expected Output:**

```json
{
  "status": "VERIFIED",
  "chainValid": true,
  "ledgerLength": 4,
  "timestamp": 1789043815147
}
```

---

## Gotchas

1. **Immutable Historical Versions**: Updates (`object put` or `action submit`) never overwrite historical slices; they create a new version slice with new system and valid time horizons.
2. **Audit Tamper Detection**: If any row in the audit table is mutated out-of-band, `operon audit verify` immediately fails with `chainValid: false` and identifies the broken link.
3. **SQLite Concurrency**: When using `--db <path>`, SQLite WAL mode is activated automatically to prevent write lock contention between agent threads.
