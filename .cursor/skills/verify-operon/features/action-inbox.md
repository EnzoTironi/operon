# Action Inbox & Human Governance Specification

The Action Inbox is Operon's human-in-the-loop (HITL) gatekeeper for high-risk actions, AI proposals, and policy-restricted mutations.

---

## Sub-features

1. **Human-Only Review Enforcement**:
   - Approvals and rejections strictly require an authenticated human subject (`type: "user"`).
   - Agent subjects (`type: "agent"`) are rejected immediately with `AuthorizationError`.
2. **Two-Person Rule / Independent Reviewer**:
   - The proposer cannot approve their own proposal (`proposerId !== approverSubject.id`).
3. **Role & Capability Check**:
   - Exact-match validation against allowed governance roles (e.g. `physician`, `chief_engineer`, `operator`, `admin`, `specialist`). Substring matching (e.g. `not-an-admin`) is rejected.
4. **Evidence Hash Binding**:
   - Every proposal binds an SHA-256 evidence digest of the submission parameters and original `DecisionRecord`.
   - Approvals verify the digest to guarantee that proposal parameters have not drifted or been tampered with.
5. **Atomic Claim Lock**:
   - Once an approval begins, the proposal is locked to `claimed` status to eliminate race conditions and double executions.
6. **First-Class Safety Veto & Overrides**:
   - Rejections create an immutable `OverrideRecord` containing the human operator's identity, structured category (`safety_veto`, `clinical_discretion`), and detailed rationale.

---

## How to get to it (user POV)

- **CLI**: `operon inbox list`, `operon inbox approve <id> [flags]`, `operon inbox reject <id> [flags]`
- **Web Console / Portal**: Dedicated inbox queue for physicians, process engineers, and operators.

---

## Driving it with operon CLI

### 1. Inspect Pending Proposals

```bash
node packages/cli/dist/bin.js inbox list --json
```

**Expected Output:**

```json
[
  {
    "id": "proposal_1789043815146_x6vwb",
    "actionTypeId": "adjust_dose",
    "proposerId": "cli_agent",
    "createdAt": "2026-09-10T12:36:55.146Z",
    "evidenceHash": "5a41df12...c902",
    "status": "pending"
  }
]
```

### 2. Approve Proposal as an Authorized Human

```bash
node packages/cli/dist/bin.js inbox approve proposal_1789043815146_x6vwb \
  --reviewer dr_li \
  --role physician \
  --json
```

**Expected Output:**

```json
{
  "status": "APPROVED_AND_COMMITTED",
  "proposalId": "proposal_1789043815146_x6vwb",
  "approver": "dr_li",
  "decisionRecordHash": "a1c4...8821"
}
```

### 3. Exercise Human Safety Veto with Structured Reason

```bash
node packages/cli/dist/bin.js inbox reject proposal_1789043815146_x6vwb \
  --reviewer dr_li \
  --role physician \
  --reason "Reduced oral intake (50%) and impaired renal clearance warrants 10U ceiling" \
  --json
```

**Expected Output:**

```json
{
  "status": "REJECTED",
  "proposalId": "proposal_1789043815146_x6vwb",
  "rejector": "dr_li",
  "reason": "Reduced oral intake (50%) and impaired renal clearance warrants 10U ceiling",
  "overrideId": "override_1789043820000_abcde"
}
```

---

## Gotchas

1. **Self-Approval Trap**: Running `operon inbox approve` with `--reviewer cli_agent` will fail because the proposer was `cli_agent` and AI agents cannot approve actions.
2. **Expired Proposals**: Proposals older than their TTL (default: 24h) cannot be approved and automatically transition to expired state.
3. **Evidence Hash Mismatch**: If `--evidence-hash` is supplied and does not match the proposal's canonical SHA-256 digest, the approval aborts.
