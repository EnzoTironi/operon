import {
  CommonValueTypes,
  defineActionType,
  defineLinkType,
  defineObjectType,
} from "@operon/schema";
import type {
  MultiDatasetObjectMapping,
  ObjectInstance,
  ObjectTypeId,
  RestrictedView,
  Subject,
} from "@operon/schema";
import { Effect, Schema } from "effect";

// ---------------------------------------------------------
// 1. SOMPO Care (Nursing Care Domain)
// ---------------------------------------------------------

export const NursingFacilityType = defineObjectType({
  id: "NursingFacility",
  name: "Nursing Facility",
  description: "Senior care home or assisted living facility",
  typology: "master",
  primaryKey: "facilityId",
  properties: {
    facilityId: {
      schema: Schema.String,
      description: "Unique facility identifier",
    },
    facilityName: {
      schema: Schema.String,
      description: "Name of the elder care residence",
    },
    region: {
      schema: Schema.String,
      description: "Prefecture or administrative region (e.g. Tokyo, Kanagawa)",
    },
    activeStaffCount: {
      schema: Schema.Number,
      description: "Current on-duty caregivers and certified nurses",
    },
  },
});

export const CareResidentType = defineObjectType({
  id: "CareResident",
  name: "Care Resident",
  description: "Elderly resident receiving personalized nursing support",
  typology: "master",
  primaryKey: "residentId",
  properties: {
    residentId: {
      schema: Schema.String,
      description: "Unique resident ID",
    },
    name: {
      schema: Schema.String,
      description: "Full name",
      classification: "restricted",
    },
    roomNumber: {
      schema: Schema.String,
      description: "Assigned room",
    },
    mobilityScore: {
      schema: Schema.Number,
      description: "Care need level index (1 to 5)",
    },
    alertStatus: {
      schema: Schema.String,
      description: "Current status: stable | monitoring | emergency",
    },
  },
});

export const CareRecordType = defineObjectType({
  id: "CareRecord",
  name: "Care Record",
  description:
    "Point-in-time observation of resident vital signs and well-being",
  typology: "observation",
  primaryKey: "recordId",
  properties: {
    recordId: {
      schema: Schema.String,
      description: "Record timestamp ID",
    },
    residentId: {
      schema: Schema.String,
      description: "Target resident ID",
    },
    systolicBP: {
      schema: Schema.Number,
      description: "Systolic blood pressure (mmHg)",
    },
    diastolicBP: {
      schema: Schema.Number,
      description: "Diastolic blood pressure (mmHg)",
    },
    heartRateBpm: {
      schema: Schema.Number,
      description: "Heart rate (bpm)",
    },
    fallDetected: {
      schema: Schema.Boolean,
      description: "IoT floor mat / wearable fall alert",
    },
    recordedAt: {
      schema: CommonValueTypes.ISO8601String.schema,
      description: "Timestamp of observation",
    },
  },
});

export const ResidentOfFacilityLink = defineLinkType({
  id: "residentOfFacility",
  description: "Link between resident and nursing facility",
  sourceTypeId: "CareResident",
  targetTypeId: "NursingFacility",
  sourceToTargetName: "facility",
  targetToSourceName: "residents",
  cardinality: "one-to-many",
});

export const ResidentCareRecordLink = defineLinkType({
  id: "residentCareRecord",
  description: "Link between observation care records and resident",
  sourceTypeId: "CareRecord",
  targetTypeId: "CareResident",
  sourceToTargetName: "resident",
  targetToSourceName: "records",
  cardinality: "one-to-many",
});

// ---------------------------------------------------------
// 2. SOMPO Japan (Insurance Claims Triage Domain)
// ---------------------------------------------------------

export const ClaimantType = defineObjectType({
  id: "Claimant",
  name: "Claimant",
  description: "Policyholder or insured entity filing a claim",
  typology: "master",
  primaryKey: "claimantId",
  properties: {
    claimantId: {
      schema: Schema.String,
      description: "Claimant identifier",
    },
    name: {
      schema: Schema.String,
      description: "Legal name",
      classification: "restricted",
    },
    phone: {
      schema: Schema.String,
      description: "Contact phone number",
      classification: "restricted",
    },
    priorClaimCount: {
      schema: Schema.Number,
      description: "Historical count of filed claims",
    },
    fraudRiskScore: {
      schema: Schema.Number,
      description: "AI-calculated fraud risk index (0.00 to 1.00)",
    },
  },
});

export const InsuranceClaimType = defineObjectType({
  id: "InsuranceClaim",
  name: "Insurance Claim",
  description: "Submitted property, casualty, or automobile insurance claim",
  typology: "transaction",
  primaryKey: "claimId",
  properties: {
    claimId: {
      schema: Schema.String,
      description: "Unique claim number",
    },
    claimantId: {
      schema: Schema.String,
      description: "Foreign key to Claimant",
    },
    branchRegion: {
      schema: Schema.String,
      description: "Servicing branch region",
    },
    lossAmountJpy: {
      schema: Schema.Number,
      description: "Claimed loss amount in JPY",
    },
    claimStatus: {
      schema: Schema.String,
      description:
        "submitted | fast_tracked | under_investigation | approved | rejected",
    },
    triageCategory: {
      schema: Schema.String,
      description: "standard | complex | fraud_alert",
    },
  },
});

export const ClaimClaimantLink = defineLinkType({
  id: "claimClaimant",
  description: "Link between insurance claim and filing claimant",
  sourceTypeId: "InsuranceClaim",
  targetTypeId: "Claimant",
  sourceToTargetName: "claimant",
  targetToSourceName: "claims",
  cardinality: "one-to-many",
});

// ---------------------------------------------------------
// 3. Kinetic Elements (Action Types)
// ---------------------------------------------------------

export const DispatchEmergencyCareAction = defineActionType({
  id: "dispatch_emergency_care",
  name: "Dispatch Emergency Care",
  description:
    "Dispatches emergency nurse intervention for distressed resident",
  targetObjectTypeId: "CareResident",
  riskTier: "high",
  minimumAgentTier: 2,
  defaultExecutionMode: "automated",
  parametersSchema: Schema.Struct({
    residentId: Schema.String,
    emergencyReason: Schema.String,
    assignedNurseId: Schema.String,
  }),
  submissionCriteria: [
    {
      id: "resident-exists",
      description: "Resident must exist in the ontology",
      evaluate: Effect.fn("evaluateResidentExists")(
        function* (params, context) {
          const resident = yield* context.getObject(
            "CareResident" as ObjectTypeId,
            params.residentId
          );
          if (!resident) {
            return {
              passed: false,
              verdict: "deny",
              failureReason: `Resident '${params.residentId}' not found`,
            };
          }
          return { passed: true, verdict: "allow" };
        }
      ),
    },
  ],
  sideEffects: [
    {
      id: "update-resident-status",
      description: "Set resident alertStatus to emergency",
      execute: () => Effect.void,
    },
  ],
});

export const TriageClaimAction = defineActionType({
  id: "triage_insurance_claim",
  name: "Triage Insurance Claim",
  description: "AI-driven fraud detection and claim workflow triage",
  targetObjectTypeId: "InsuranceClaim",
  riskTier: "medium",
  minimumAgentTier: 2,
  defaultExecutionMode: "automated",
  parametersSchema: Schema.Struct({
    claimId: Schema.String,
    fraudRiskScore: Schema.Number,
    lossAmountJpy: Schema.Number,
  }),
  submissionCriteria: [
    {
      id: "positive-amount",
      description: "Loss amount must be positive",
      evaluate: (params) =>
        Effect.succeed(
          params.lossAmountJpy > 0
            ? { passed: true, verdict: "allow" }
            : {
                passed: false,
                verdict: "deny",
                failureReason: "Loss amount must be > 0",
              }
        ),
    },
  ],
});

export const ApproveClaimPayoutAction = defineActionType({
  id: "approve_claim_payout",
  name: "Approve Claim Payout",
  description:
    "Governed approval of payout for verified claim (requires proposal review for large amounts)",
  targetObjectTypeId: "InsuranceClaim",
  riskTier: "critical",
  minimumAgentTier: 3,
  defaultExecutionMode: "automated",
  parametersSchema: Schema.Struct({
    claimId: Schema.String,
    approvedAmountJpy: Schema.Number,
    adjusterId: Schema.String,
  }),
  submissionCriteria: [
    {
      id: "siu-audit-guard",
      description:
        "Claims > ¥5,000,000 require Special Investigation Unit (SIU) committee sign-off",
      evaluate: (params) =>
        Effect.succeed(
          params.approvedAmountJpy > 5_000_000
            ? {
                passed: false,
                verdict: "review", // Escalate to Action Inbox / Approvals App!
                failureReason: `Payout ¥${params.approvedAmountJpy.toLocaleString()} exceeds automatic ceiling of ¥5,000,000. Routed to Approvals App.`,
              }
            : { passed: true, verdict: "allow" }
        ),
    },
  ],
});

// ---------------------------------------------------------
// 4. Security Views (Restricted Views & MDO Mappings)
// ---------------------------------------------------------

export const RegionRestrictedView: RestrictedView = {
  id: "rv_regional_claims",
  name: "Regional Claims RV",
  description: "Adjusters can only see claims within their region",
  objectTypeId: "InsuranceClaim",
  predicate: (instance: ObjectInstance, subject: Subject) => {
    if (subject.roles.includes("admin")) {
      return true;
    }
    const userRegion = subject.metadata?.assignedRegion;
    return instance.properties.branchRegion === userRegion;
  },
};

export const ClaimantMdoMapping: MultiDatasetObjectMapping = {
  objectTypeId: "Claimant",
  propertyClassifications: {
    claimantId: "internal",
    priorClaimCount: "internal",
    fraudRiskScore: "internal",
    name: "pii",
    phone: "pii",
  },
  datasetSources: {
    claimantId: "ds_claimants",
    priorClaimCount: "ds_claims_history",
    fraudRiskScore: "ds_ai_risk",
    name: "ds_crm_pii",
    phone: "ds_crm_pii",
  },
  authorizedRolesPerClassification: {
    public: ["*"],
    internal: ["analytics", "claims_adjuster", "admin"],
    confidential: ["claims_adjuster", "admin"],
    restricted: ["claims_adjuster", "admin"],
    pii: ["claims_adjuster", "admin"],
  },
};
