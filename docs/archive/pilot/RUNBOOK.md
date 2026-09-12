# Operon Consented Real-Company Mirror Evaluation Runbook (Gate F2)

This runbook outlines the operational protocol for conducting a consented real-company mirror evaluation in accordance with **Specification S17** and **Ticket V0-CH-11**.

---

## 1. Governance and Consent Boundary

Before any mirror evaluation begins:

1. **Consent Grant Scope**: A legally binding `ConsentScope` must be generated and signed by the participant organization:
   - `participantId`: Qualified identifier of the participating institution.
   - `dataScope`: Explicit list of authorized ontology object types and observation streams (e.g., `["patient_records", "vitals", "medications"]`).
   - `purpose`: Bounded evaluation statement.
   - `expiresAt`: Definite epoch timestamp after which evaluation authority expires immediately.
2. **Profile Segregation**: Real-company mirror runs must use the reference profile (`Node/PostgreSQL` or isolated reference profile), distinct from local benchmarks (`SQLite`). Evidence never transfers between profiles.

---

## 2. External Agent Path Protocol

1. **No Internal Kernel Bypass**:
   - All external agents (autonomous coders, diagnostic agents, LLM clinical helpers) must interface exclusively via public contracts:
     - `@operon/cli`
     - Operon Stdio/HTTP MCP Server
     - `@operon/osdk` typed client
   - Direct database mutations or internal store access trigger an immediate `F2InternalBypassError`.

---

## 3. Real Mirror and Traceable Correction Flow

1. **Mirror Observation**: External agent queries the bitemporal mirror state using public contracts (`readiness check`, `action prepare`).
2. **Recognition & Useful Insight**: Record time-to-first-useful-insight.
3. **Human-in-the-Loop Audit & Correction**:
   - Every mirror evaluation requires at least one recognized useful mirror observation and at least one traceable correction (`TraceableCorrection`):
     - `observedTarget`: URI of target entity property.
     - `priorValue`: Initial uncorrected or raw external value.
     - `correctedValue`: Physician or operator confirmed value.
     - `correctedBy`: Authorized reviewer identity.
     - `reason`: Documented clinical or operational rationale.
4. **Receipt Generation**:
   - The kernel generates an immutable, Ed25519-signed `F2Receipt` binding candidate digest, profile digest, rubric digest, company evidence reference, and correction references.
