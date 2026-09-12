# MCP hosted by Zoen

Zoen launches Operon over private stdio for one authenticated workspace and one operation. The host chooses `--workspace`, `--role consumer|builder`, and the database. Model-facing tool arguments do not select these values.

```sh
OPERON_DATABASE_URL=postgresql://localhost/operon \
  operon mcp start --workspace personal:example --role builder --agent-tier 2 --host-approver
```

`--workspace` starts an empty runtime. It saves every runtime service, including objects, ingestion receipts, proposals and approvals, in one database snapshot. PostgreSQL holds a connection-level advisory lock for the workspace; local SQLite holds a writer lease for the database file. A second process reads the latest snapshot after obtaining the lease. A tool result is acknowledged only after its checkpoint succeeds. Process death releases the lease. The existing unscoped demo CLI continues to use its object database and state file.

The snapshot implementation rewrites the workspace state at a checkpoint. It is an initial persistence model, not a normalized database for large installations. It guarantees recovery of acknowledged results; it does not make arbitrary external side effects transactional.

## Human approval

Plain Consumer and Builder processes are not human approvers. Companion is the session host: bind its Better Auth `session.token` as Bearer (`OPERON_SESSION`, or the `OPERON_APPROVER_SESSION_TOKEN` alias) and `SessionVerifier` parses the `HumanPrincipal`. `--host-approver` stays for the private host-approval callback. Model-supplied `reviewerId`, `reviewerRoles`, or a name in tool input cannot grant.

A trusted stdio host can instead opt into `--host-approver`, with a Builder role and workspace. It must advertise `experimental["operon/approval"]` and handle:

```json
{
  "method": "operon/verify-approval",
  "params": {
    "tool": "operon_review_mapping_proposal",
    "arguments": {
      "proposalId": "…",
      "viewedDigest": "…",
      "verdict": "approve"
    }
  }
}
```

The response is `{ "principal": HumanPrincipal }`. For each request, Zoen checks the live channel or web session, workspace membership, conversation ownership, the pending proposal and digest, and the human's actual role. The callback is installed only during Eve's approved tool execution. An ordinary agent cannot gain approval by supplying `reviewerId`, `reviewerRoles`, or a name in tool input. The server refuses missing host support, failed authorization, malformed principals and expired attestations. This extension trusts the authenticated application at the other end of stdio; do not expose it to an untrusted host.

## Verification

`packages/cli/src/mcp-process.test.ts` drives the built CLI through the real SDK, kills it after acknowledged ingestion, reopens its state, and checks role denial. Build the CLI and its dependencies before running that suite. The pinned Zoen integration additionally exercises real PostgreSQL, native identity revocation, proposal replay, admission, and concurrent processes for the same account.
