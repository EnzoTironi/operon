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

export const BUILTIN_SKILLS: readonly SkillManifest[] = [
  AuditInvestigationSkill,
  ActionReviewProposalSkill,
  OntologySchemaProposalSkill,
];
