# Operon Verification Feature Map

This index maps all primary capability surfaces of Operon to their respective verification specs, CLI commands, and automated test harnesses.

## Feature Index

| Feature ID | Feature Name | Primary CLI Command | Key Invariant / Guarantee | Verification Spec |
| --- | --- | --- | --- | --- |
| **F-01** | **Governed Write Pipeline** | `operon action submit` | 7-step atomic transaction, parameter decoding, precondition evaluation, cryptographic `DecisionRecord` | [governed-pipeline.md](governed-pipeline.md) |
| **F-02** | **Action Inbox & Human Review** | `operon inbox approve` / `reject` | Human-only review, independent approver checks, evidence hash integrity, atomic claim lock, safety veto | [action-inbox.md](action-inbox.md) |
| **F-03** | **4C Decision Readiness** | `operon readiness check` | Completeness, Correctness, Currentness, Consistency gates prevent acting on stale/contradictory data | [decision-readiness.md](decision-readiness.md) |
| **F-04** | **Bitemporal Storage & Audit** | `operon object query` / `operon audit verify` | Valid time vs system time separation, point-in-time state reconstruction, tamper-evident SHA-256 chain | [bitemporal-storage.md](bitemporal-storage.md) |
| **F-05** | **Model Execution Sandbox** | `operon sandbox verify` | Pure Effect fiber isolation, execution timeouts, deterministic replayability proofs | [model-sandbox.md](model-sandbox.md) |
| **F-06** | **Stdio MCP Server** | `operon mcp start` | Dynamic schema & tool projection over JSON-RPC stdio, governance guard enforcement | [mcp-server.md](mcp-server.md) |
| **F-07** | **OMS Ontology Governance** | `operon oms branch` / `proposal` | Multi-branch schema evolution, proposal lifecycle, specialist multi-signature reviews, safe merge | [oms-governance.md](oms-governance.md) |

## Verification Conventions

Every feature document adheres to a standard 4-part structure:

1. `## Sub-features`: Specific capabilities and edge cases under verification.
2. `## How to get to it (user POV)`: How human users, applications, or LLM agents interact with this capability.
3. `## Driving it with operon CLI`: Copy-pasteable non-interactive CLI commands with real parameters and expected structured output.
4. `## Gotchas`: Real-world operational edge cases, common misconfigurations, and failure modes.
