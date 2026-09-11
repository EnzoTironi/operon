import { defineSkill } from "./manifest.js";
import type { SkillManifest } from "./manifest.js";

export const AuditInvestigationSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["auditor", "compliance_officer"],
  description:
    "Investigate cryptographic audit ledger records and verify hash integrity",
  id: "operon.skill.audit-investigation",
  inputSchema: {
    ledgerVerification: "boolean",
    subjectFilter: "string?",
  },
  minContract: "operon.kernel/v0",
  name: "Audit Investigation",
  outputSchema: {
    chainValid: "boolean",
    recordsExamined: "number",
  },
  requiredTools: ["operon_verify_audit_ledger", "operon_get_audit_records"],
  version: "1.0.0",
});

export const ActionReviewProposalSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["approver", "operator"],
  description:
    "Review, approve, or reject human-in-the-loop proposals in the Action Inbox",
  id: "operon.skill.action-review-proposal",
  inputSchema: {
    action: "approve | reject",
    proposalId: "string",
    rationale: "string?",
  },
  minContract: "operon.kernel/v0",
  name: "Action Review Proposal",
  outputSchema: {
    proposalId: "string",
    status: "string",
  },
  requiredTools: [
    "operon_list_inbox_proposals",
    "operon_approve_proposal",
    "operon_reject_proposal",
  ],
  version: "1.0.0",
});

export const OntologySchemaProposalSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["fde_agent", "ontology_architect"],
  description:
    "Draft and submit ontology type changes to a staging branch via OMS",
  id: "operon.skill.ontology-schema-proposal",
  inputSchema: {
    branchName: "string",
    changeType: "create_type | modify_type",
  },
  minContract: "operon.kernel/v0",
  name: "Ontology Schema Proposal",
  outputSchema: {
    branchId: "string",
    proposalId: "string",
  },
  requiredTools: ["operon_create_branch", "operon_submit_branch_change"],
  version: "1.0.0",
});

export const DosageVerificationSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["clinician", "pharmacist"],
  description:
    "Verify patient medication dosage against organ function (eGFR) and clinical safety protocols",
  id: "operon.skill.dosage-verification",
  inputSchema: {
    calculatedEgfr: "number",
    candidateDoseMg: "number",
    drugName: "string",
    patientId: "string",
  },
  minContract: "operon.kernel/v0",
  name: "Dosage Verification",
  outputSchema: {
    adjustedDoseMg: "number",
    approved: "boolean",
    rationale: "string",
  },
  requiredTools: [
    "operon_query_vitals",
    "operon_calculate_egfr",
    "operon_submit_dosage_order",
  ],
  version: "1.0.0",
});

export const ClinicalHandoffExtractionSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["nurse", "physician"],
  description:
    "Extract patient shift handoff notes with span linking, nurse confirmation requirement, and prompt injection defense",
  id: "operon.skill.clinical-handoff-extraction",
  inputSchema: {
    noteText: "string",
    patientId: "string",
    shiftId: "string",
  },
  minContract: "operon.kernel/v0",
  name: "Clinical Handoff Extraction",
  outputSchema: {
    admittedFacts: "array",
    candidateCount: "number",
    requiresConfirmation: "boolean",
  },
  requiredTools: ["operon_extract_candidate_facts", "operon_admit_observation"],
  version: "1.0.0",
});

export const ChemicalDosingDossierSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["water_operator", "environmental_engineer"],
  description:
    "Prepare coagulant / disinfectant dosing recommendations with bounded loop simulation and regulatory permit limits",
  id: "operon.skill.chemical-dosing-dossier",
  inputSchema: {
    effluentTurbidityNtu: "number",
    influentFlowM3h: "number",
    permitLimitNtu: "number",
    plantId: "string",
  },
  minContract: "operon.kernel/v0",
  name: "Chemical Dosing Dossier",
  outputSchema: {
    dosingRatePpm: "number",
    predictedTurbidityNtu: "number",
    withinPermitLimits: "boolean",
  },
  requiredTools: [
    "operon_query_telemetry",
    "operon_simulate_dosing",
    "operon_submit_dosing_dossier",
  ],
  version: "1.0.0",
});

export const TelemetryLoopInspectionSkill: SkillManifest = defineSkill({
  authorityPrerequisites: ["scada_engineer", "plant_supervisor"],
  description:
    "Inspect industrial water treatment plants with recirculation loops without infinite traversal loops",
  id: "operon.skill.telemetry-loop-inspection",
  inputSchema: {
    maxDepth: "number?",
    plantId: "string",
    startNodeId: "string",
  },
  minContract: "operon.kernel/v0",
  name: "Telemetry Loop Inspection",
  outputSchema: {
    cycleDetected: "boolean",
    nodesVisited: "array",
    telemetryHealth: "string",
  },
  requiredTools: [
    "operon_traverse_plant_topology",
    "operon_read_sensor_telemetry",
  ],
  version: "1.0.0",
});

export const BUILTIN_SKILLS: readonly SkillManifest[] = [
  AuditInvestigationSkill,
  ActionReviewProposalSkill,
  OntologySchemaProposalSkill,
  DosageVerificationSkill,
  ClinicalHandoffExtractionSkill,
  ChemicalDosingDossierSkill,
  TelemetryLoopInspectionSkill,
];
