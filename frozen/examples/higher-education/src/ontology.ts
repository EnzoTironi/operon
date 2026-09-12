import {
  CommonValueTypes,
  defineActionType,
  defineLinkType,
  defineObjectType,
} from "@operon/schema";
import type { ObjectTypeId } from "@operon/schema";
import { Effect, Schema } from "effect";

// ---------------------------------------------------------
// 1. Entities & Nouns (Higher Education Domain - Chapter 13)
// ---------------------------------------------------------

export const StudentType = defineObjectType({
  id: "Student",
  name: "Student",
  description: "Matriculated university student",
  typology: "master",
  primaryKey: "studentId",
  properties: {
    studentId: {
      schema: Schema.String,
      description: "Student identity ID",
    },
    fullName: {
      schema: Schema.String,
      description: "Legal name",
    },
    admissionYear: {
      schema: Schema.Number,
      description: "Matriculation year (e.g. 2024)",
    },
    enrolledProgramId: {
      schema: Schema.String,
      description: "Degree program code (e.g. CS-BSC)",
    },
    approvedWaiverCount: {
      schema: Schema.Number,
      description: "Count of previously approved course waivers",
    },
  },
});

export const CourseType = defineObjectType({
  id: "Course",
  name: "Course",
  description: "Academic course module",
  typology: "master",
  primaryKey: "courseCode",
  properties: {
    courseCode: {
      schema: Schema.String,
      description: "Course catalogue code (e.g. CS301, CS499)",
    },
    title: {
      schema: Schema.String,
      description: "Descriptive title",
    },
    credits: {
      schema: Schema.Number,
      description: "Credit point value",
    },
    isCapstone: {
      schema: Schema.Boolean,
      description:
        "Flag indicating whether course is a non-waivable capstone project",
    },
  },
});

export const CurriculumVersionType = defineObjectType({
  id: "CurriculumVersion",
  name: "Curriculum Version",
  description:
    "Versioned academic regulation policy governing admission cohorts",
  typology: "reference",
  primaryKey: "versionCode",
  properties: {
    versionCode: {
      schema: Schema.String,
      description: "Cohort version tag (e.g. CURR-2024)",
    },
    programId: {
      schema: Schema.String,
      description: "Degree program identifier",
    },
    effectiveYear: {
      schema: Schema.Number,
      description: "Year of promulgation",
    },
    maxAllowedWaivers: {
      schema: Schema.Number,
      description: "Ceiling on prerequisite waivers allowed per student",
    },
    minEquivalentGrade: {
      schema: Schema.Number,
      description: "Minimum grade required on external equivalent transcript",
    },
  },
});

export const EvidenceType = defineObjectType({
  id: "Evidence",
  name: "Evidence",
  description:
    "Dossier artifact supporting waiver (transcript or professional employment letter)",
  typology: "observation",
  primaryKey: "evidenceId",
  properties: {
    evidenceId: {
      schema: Schema.String,
      description: "Unique evidence ID",
    },
    evidenceType: {
      schema: Schema.String,
      description: "equivalent_course | work_experience | certification",
    },
    institutionName: {
      schema: Schema.String,
      description: "Issuing institution or employer",
    },
    gradeScore: {
      schema: Schema.Number,
      description: "Numerical grade score (0-100 scale)",
    },
    verifiedByRegistry: {
      schema: Schema.Boolean,
      description: "Registrar office verification flag",
    },
  },
});

export const WaiverRequestType = defineObjectType({
  id: "WaiverRequest",
  name: "Waiver Request",
  description: "Formal prerequisite exception application",
  typology: "transaction",
  primaryKey: "requestId",
  properties: {
    requestId: {
      schema: Schema.String,
      description: "Waiver application ID",
    },
    studentId: {
      schema: Schema.String,
      description: "Applicant student ID",
    },
    targetCourseCode: {
      schema: Schema.String,
      description: "Course to waive prerequisite for",
    },
    status: {
      schema: Schema.String,
      description: "pending | approved | rejected",
    },
    submittedAt: {
      schema: CommonValueTypes.ISO8601String.schema,
      description: "Submission timestamp",
    },
  },
});

// ---------------------------------------------------------
// 2. Links & Relationships
// ---------------------------------------------------------

/**
 * Strict Acyclic DAG prerequisite relation: Course -> Prerequisite Course
 */
export const PrerequisiteOfLink = defineLinkType({
  id: "prerequisiteOf",
  description: "Academic prerequisite hierarchy (strictly acyclic DAG)",
  sourceTypeId: "Course",
  targetTypeId: "Course",
  sourceToTargetName: "prerequisiteFor",
  targetToSourceName: "requiredPrerequisite",
  cardinality: "one-to-many",
});

export const StudentCurriculumLink = defineLinkType({
  id: "admittedUnder",
  description:
    "Binds student to CurriculumVersion effective at admission year (Version Justice)",
  sourceTypeId: "Student",
  targetTypeId: "CurriculumVersion",
  sourceToTargetName: "enrolledStudents",
  targetToSourceName: "governingCurriculum",
  cardinality: "one-to-many",
});

// ---------------------------------------------------------
// 3. Kinetic Elements (Action Types & 5 Core Rules)
// ---------------------------------------------------------

export const SubmitWaiverRequestAction = defineActionType({
  id: "submit_waiver_request",
  name: "Submit Prerequisite Waiver",
  description: "Student submits waiver backed by verified evidence dossier",
  targetObjectTypeId: "WaiverRequest",
  riskTier: "medium",
  minimumAgentTier: 1,
  defaultExecutionMode: "manual",
  parametersSchema: Schema.Struct({
    requestId: Schema.String,
    studentId: Schema.String,
    targetCourseCode: Schema.String,
    evidenceId: Schema.String,
  }),
  submissionCriteria: [
    {
      id: "r1-capstone-non-waivable",
      description: "Rule 1: Capstone prerequisite is strictly non-waivable",
      evaluate: Effect.fn("evaluateCapstoneNonWaivable")(
        function* (params, context) {
          const course = yield* context.getObject(
            "Course" as ObjectTypeId,
            params.targetCourseCode
          );
          if (course?.properties.isCapstone === true) {
            return {
              passed: false,
              verdict: "deny",
              failureReason: `Rule R1 Violation: Course '${params.targetCourseCode}' is a Capstone project. Prerequisites are strictly non-waivable.`,
            };
          }
          return { passed: true, verdict: "allow" };
        }
      ),
    },
    {
      id: "r2-waiver-quota-guard",
      description:
        "Rule 2: At most two approved waivers per student per program",
      evaluate: Effect.fn("evaluateWaiverQuotaGuard")(
        function* (params, context) {
          const student = yield* context.getObject(
            "Student" as ObjectTypeId,
            params.studentId
          );
          const count =
            (student?.properties.approvedWaiverCount as number) ?? 0;
          if (count >= 2) {
            return {
              passed: false,
              verdict: "deny",
              failureReason: `Rule R2 Violation: Student has already used ${count} approved waivers (Maximum allowed: 2).`,
            };
          }
          return { passed: true, verdict: "allow" };
        }
      ),
    },
    {
      id: "r3-r4-evidence-rules",
      description:
        "Rule 3 (Grade >= 60) & Rule 4 (Work experience routes to Director review)",
      evaluate: Effect.fn("evaluateEvidenceRules")(function* (params, context) {
        const evidence = yield* context.getObject(
          "Evidence" as ObjectTypeId,
          params.evidenceId
        );
        if (!evidence) {
          return {
            passed: false,
            verdict: "deny",
            failureReason: `Evidence '${params.evidenceId}' not found in registry`,
          };
        }

        // Rule 4: Work experience routes to Department Director
        if (evidence.properties.evidenceType === "work_experience") {
          return {
            passed: false,
            verdict: "review", // Escalate to Department Director inbox!
            failureReason:
              "Rule R4: Professional work experience evidence requires Department Director discretion.",
          };
        }

        // Rule 3: Equivalent course grade must be >= 60
        const grade = (evidence.properties.gradeScore as number) ?? 0;
        if (grade < 60) {
          return {
            passed: false,
            verdict: "deny",
            failureReason: `Rule R3 Violation: Equivalent course grade (${grade}) is below minimum threshold 60.`,
          };
        }

        return { passed: true, verdict: "allow" };
      }),
    },
  ],
});

export const ApproveWaiverAction = defineActionType({
  id: "approve_waiver",
  name: "Approve Prerequisite Waiver",
  description:
    "Department Director exercises discretion and signs off on waiver",
  targetObjectTypeId: "WaiverRequest",
  riskTier: "high",
  minimumAgentTier: 3,
  defaultExecutionMode: "manual",
  parametersSchema: Schema.Struct({
    requestId: Schema.String,
    directorId: Schema.String,
    academicRationale: Schema.String,
  }),
  submissionCriteria: [
    {
      id: "valid-request",
      description: "Request must be present",
      evaluate: (params) =>
        Effect.succeed(
          params.requestId.length > 0
            ? { passed: true, verdict: "allow" }
            : {
                passed: false,
                verdict: "deny",
                failureReason: "Missing requestId",
              }
        ),
    },
  ],
});
