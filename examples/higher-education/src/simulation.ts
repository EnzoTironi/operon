import {
  ActionInbox,
  BitemporalObjectStore,
  InMemoryAuditStore,
  executeWritePipeline,
} from "@operon/runtime";
import { Effect } from "effect";

import {
  CourseType,
  CurriculumVersionType,
  EvidenceType,
  StudentType,
  SubmitWaiverRequestAction,
  WaiverRequestType,
} from "./ontology.js";

export async function runHigherEducationSimulation() {
  console.log(
    "=== OPERON HIGHER EDUCATION PREREQUISITE WAIVER SIMULATION (CHAPTER 13) ==="
  );
  console.log(
    "Reference Architecture: Curriculum Version Governance & Institutional Rules\n"
  );

  const store = new BitemporalObjectStore();
  const audit = new InMemoryAuditStore();
  const inbox = new ActionInbox(audit, store);

  // 1. Initialize Curriculum Version & Student
  await Effect.runPromise(
    store.putObject({
      id: "CURR-2024",
      lastModifiedAt: Date.now(),
      properties: {
        effectiveYear: 2024,
        maxAllowedWaivers: 2,
        minEquivalentGrade: 60,
        programId: "CS-BSC",
        versionCode: "CURR-2024",
      },
      typeId: CurriculumVersionType.id,
      version: 0,
    })
  );

  const studentId = "std_alice_2024";
  await Effect.runPromise(
    store.putObject({
      id: studentId,
      lastModifiedAt: Date.now(),
      properties: {
        admissionYear: 2024,
        approvedWaiverCount: 0,
        enrolledProgramId: "CS-BSC",
        fullName: "Alice Chen",
        studentId,
      },
      typeId: StudentType.id,
      version: 0,
    })
  );
  console.log(
    "1. Student 'Alice Chen' enrolled under 'CURR-2024' (0 prior waivers, Cap: 2)."
  );

  // 2. Initialize Courses: Standard CS301 and Capstone CS499
  await Effect.runPromise(
    store.putObject({
      id: "CS301",
      lastModifiedAt: Date.now(),
      properties: {
        courseCode: "CS301",
        credits: 6,
        isCapstone: false,
        title: "Advanced Algorithms",
      },
      typeId: CourseType.id,
      version: 0,
    })
  );

  await Effect.runPromise(
    store.putObject({
      id: "CS499",
      lastModifiedAt: Date.now(),
      properties: {
        courseCode: "CS499",
        credits: 12,
        isCapstone: true, // Rule R1 Target!
        title: "Senior Capstone Project",
      },
      typeId: CourseType.id,
      version: 0,
    })
  );
  console.log(
    "2. Courses initialized: 'CS301' (Standard) and 'CS499' (Capstone Project)."
  );

  // 3. Initialize Evidence Items
  // EV-1: Valid transcript from external university (Grade: 78 >= 60)
  await Effect.runPromise(
    store.putObject({
      id: "EV-01",
      lastModifiedAt: Date.now(),
      properties: {
        evidenceId: "EV-01",
        evidenceType: "equivalent_course",
        gradeScore: 78,
        institutionName: "National Polytechnic",
        verifiedByRegistry: true,
      },
      typeId: EvidenceType.id,
      version: 0,
    })
  );

  // EV-2: Industry Work Experience (Triggers Rule R4 routing)
  await Effect.runPromise(
    store.putObject({
      id: "EV-02",
      lastModifiedAt: Date.now(),
      properties: {
        evidenceId: "EV-02",
        evidenceType: "work_experience",
        gradeScore: 0,
        institutionName: "Cyberdyne Systems (Software Engineer 2 yrs)",
        verifiedByRegistry: true,
      },
      typeId: EvidenceType.id,
      version: 0,
    })
  );
  console.log(
    "3. Evidence dossiers registered in OSv2: EV-01 (Grade 78), EV-02 (Work Experience)."
  );

  // 4. Scenario 1: Attempt to waive Capstone Course CS499 -> Intercepted by Rule R1
  console.log(
    "\n4. Scenario 1: Alice attempts to waive Senior Capstone CS499..."
  );
  const capstoneSubmission = {
    actionType: SubmitWaiverRequestAction,
    rawParameters: {
      evidenceId: "EV-01",
      requestId: "req_capstone_fail",
      studentId,
      targetCourseCode: "CS499",
    },
    security: {
      correlationId: "corr-he-capstone-01",
      subject: {
        id: studentId,
        name: "Alice Chen",
        roles: ["student"],
        type: "user" as const,
      },
      timestamp: Date.now(),
    },
  };

  const capstoneResult = await Effect.runPromise(
    executeWritePipeline(capstoneSubmission, store, audit).pipe(Effect.flip)
  );
  console.log(
    `   --> [INTERCEPTED BY OPERON RULE R1]: ${capstoneResult.message}`
  );

  // 5. Scenario 2: Waive standard course CS301 with EV-01 (Grade 78 >= 60) -> Executed
  console.log(
    "\n5. Scenario 2: Alice applies to waive CS301 with EV-01 (Grade 78)..."
  );
  const standardSubmission = {
    actionType: SubmitWaiverRequestAction,
    rawParameters: {
      evidenceId: "EV-01",
      requestId: "req_cs301_pass",
      studentId,
      targetCourseCode: "CS301",
    },
    security: {
      correlationId: "corr-he-valid-01",
      subject: {
        id: studentId,
        name: "Alice Chen",
        roles: ["student"],
        type: "user" as const,
      },
      timestamp: Date.now(),
    },
    stagedLogic: (params: any) =>
      Effect.succeed([
        {
          id: params.requestId,
          lastModifiedAt: Date.now(),
          properties: {
            requestId: params.requestId,
            status: "approved",
            studentId: params.studentId,
            submittedAt: new Date().toISOString(),
            targetCourseCode: params.targetCourseCode,
          },
          typeId: WaiverRequestType.id,
          version: 0,
        },
      ]),
  };

  const standardResult = await Effect.runPromise(
    executeWritePipeline(standardSubmission, store, audit)
  );
  console.log(
    `   --> Pipeline Status: ${standardResult.status} (Fast-path automatic approval)`
  );

  // 6. Scenario 3: Waive CS301 with EV-02 (Work Experience) -> Rule R4 routes to Director Inbox
  console.log(
    "\n6. Scenario 3: Alice submits waiver backed by Work Experience (EV-02)..."
  );
  const workExpSubmission = {
    actionType: SubmitWaiverRequestAction,
    rawParameters: {
      evidenceId: "EV-02",
      requestId: "req_workexp_review",
      studentId,
      targetCourseCode: "CS301",
    },
    security: {
      correlationId: "corr-he-workexp-01",
      subject: {
        id: studentId,
        name: "Alice Chen",
        roles: ["student"],
        type: "user" as const,
      },
      timestamp: Date.now(),
    },
    stagedLogic: (params: any) =>
      Effect.succeed([
        {
          id: params.requestId,
          lastModifiedAt: Date.now(),
          properties: {
            requestId: params.requestId,
            status: "approved",
            studentId: params.studentId,
            submittedAt: new Date().toISOString(),
            targetCourseCode: params.targetCourseCode,
          },
          typeId: WaiverRequestType.id,
          version: 0,
        },
      ]),
  };

  const workExpResult = await Effect.runPromise(
    executeWritePipeline(workExpSubmission, store, audit)
  );
  console.log(`   --> Pipeline Status: ${workExpResult.status}`);
  if (workExpResult.status === "proposed") {
    console.log(
      `   --> Routed to Department Director Action Inbox (Proposal ID: ${workExpResult.proposalId})`
    );
    inbox.addProposal(workExpSubmission, workExpResult.decisionRecord);

    // Department Director reviews and approves
    console.log(
      "7. Department Director (Prof. Turing) reviews work experience in Action Inbox..."
    );
    const directorApproval = await Effect.runPromise(
      inbox.approveProposal(workExpResult.proposalId, {
        agentTier: 4 as const,
        id: "dir_turing",
        name: "Prof. Turing (Department Director)",
        roles: ["department_director", "academic_adviser"],
        type: "user" as const,
      })
    );
    console.log(
      `   --> Confirmed & Approved by: ${directorApproval.subject.name}`
    );
  }

  const decisions = await audit.listDecisions({ limit: 10 });
  console.log(`\n8. Traceability & Version Justice Summary:`);
  console.log(`   - Total Immutable Decision Records: ${decisions.length}`);
  console.log(`   - Evaluated under Curriculum: CURR-2024`);
  console.log("=== HIGHER EDUCATION SIMULATION COMPLETED SUCCESSFULLY ===\n");
}
