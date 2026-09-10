# OMS Ontology Governance Specification

The Ontology Metadata Service (OMS) provides Git-like distributed versioning, branching, multi-specialist review pipelines, and merge governance for enterprise ontology schemas.

---

## Sub-features

1. **Branching Model**:
   - Isolates schema changes from the production `main` branch.
   - Enables teams and autonomous agents to test schema modifications in safe sandbox branches.
2. **Change Proposal Lifecycle**:
   - Tracks proposed modifications to object types, property definitions, link types, or action contracts.
   - States: `draft` → `under_review` → `approved` / `rejected` → `merged`.
3. **Multi-Specialist Reviews**:
   - Requires independent specialist reviews (e.g. clinical director, safety engineer, ontology architect) before proposals can be merged.
4. **Deterministic Merge & Conflict Detection**:
   - Validates that proposed schema mutations do not break existing invariants or introduce type collisions before merging into the target branch.

---

## How to get to it (user POV)

- **CLI**:
  - `operon oms branch create <name> [--parent <parent>] [--author <id>] [--json]`
  - `operon oms proposal create <branchId> [--author <id>] [--desc <description>] [--json]`
  - `operon oms proposal review <proposalId> --reviewer <id> --verdict <approve|reject> [--json]`
  - `operon oms proposal merge <proposalId> [--json]`
- **Runtime**: `OntologyMetadataService` in `@operon/runtime`

---

## Driving it with operon CLI

### 1. Create a Schema Evolution Branch

```bash
node packages/cli/dist/bin.js oms branch create feature/cardiology-sensors \
  --author lead_arch \
  --json
```

**Expected Output:**

```json
{
  "id": "feature/cardiology-sensors",
  "name": "feature/cardiology-sensors",
  "parentBranchId": "main",
  "isMain": false,
  "createdAt": 1789043815147,
  "createdBy": {
    "id": "lead_arch",
    "name": "LEAD_ARCH",
    "roles": ["ontology_architect"],
    "type": "user"
  }
}
```

### 2. Human-Readable Branch Creation

```bash
node packages/cli/dist/bin.js oms branch create feature/cardiology-sensors --author lead_arch
```

**Output:**

```text
=== OMS ONTOLOGY BRANCH CREATED ===
Branch ID: feature/cardiology-sensors
Parent Branch: main
Author: lead_arch
```

---

## Gotchas

1. **Root Branch Protection**: The `main` branch is immutable to direct unreviewed pushes; all modifications must originate from proposals.
2. **Reviewer Role Requirements**: Merging requires approvals from subjects possessing required specialist roles.
3. **Branch Isolation**: Changes committed to a feature branch are invisible to queries targeting the `main` branch until merged.
