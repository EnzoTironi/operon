import type {
  EvidenceCitation,
  FactualAssertion,
  MustAnswerTemplate,
  ObjectInstance,
} from "@operon/schema";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  CitationResolutionError,
  CommunicationComplianceViolationError,
  CompletenessCheckFailedError,
  FunctionPermissionDeniedError,
  L2ContextMismatchError,
  UnadmittedCandidateError,
} from "../actions-errors.js";
import {
  ExtractionAdmissionService,
  ExtractionAdmissionServiceLive,
} from "./extraction-admission.js";
import {
  L2ContextVerifierService,
  L2ContextVerifierServiceLive,
} from "./l2-context-verifier.js";
import type { RegisteredEvidenceSource } from "./l2-context-verifier.js";
import { QualityGateService, QualityGateServiceLive } from "./quality-gate.js";

describe("L2 Context Verification & Quality Gates (S12 / OPR-L2-001..006)", () => {
  const samplePatient: ObjectInstance = {
    id: "patient-101",
    lastModifiedAt: 1700000000,
    properties: {
      activeMedications: ["METFORMIN", "LISINOPRIL"],
      allergies: ["PENICILLIN"],
      heartRate: 72,
      serumPotassium: 4.8,
    },
    schemaVersion: "1.0.0",
    typeId: "Patient",
    version: 1,
  };

  const registeredContext: Record<string, ObjectInstance> = {
    "patient-101": samplePatient,
  };

  const sampleEvidence: Record<string, RegisteredEvidenceSource> = {
    "ev-chart-001": {
      accessible: true,
      content:
        "Patient P-101 admitted at 08:30. Serum potassium level measured at 4.8 mEq/L. No acute distress observed.",
      evidenceId: "ev-chart-001",
      version: "v1.0",
    },
    "ev-restricted-002": {
      accessible: false, // Inaccessible to current tenant
      content: "Classified enterprise financial risk forecast data.",
      evidenceId: "ev-restricted-002",
      version: "v1.0",
    },
  };

  describe("OPR-L2-001: Correct output against registered context", () => {
    it("does verify factual assertion when property and value match ground truth", async () => {
      const assertion: FactualAssertion = {
        assertionId: "as-01",
        assertedValue: 4.8,
        entityId: "patient-101",
        property: "serumPotassium",
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertFactualCorrectness(
          [assertion],
          registeredContext
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const verdicts = await Effect.runPromise(program);
      expect(verdicts.length).toBe(1);
      expect(verdicts[0]?.status).toBe("VERIFIED");
    });

    it("does reject assertion with value mismatch (L2-001.T01)", async () => {
      const assertion: FactualAssertion = {
        assertionId: "as-02",
        assertedValue: 6.2, // Wrong number!
        entityId: "patient-101",
        property: "serumPotassium",
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertFactualCorrectness(
          [assertion],
          registeredContext
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(L2ContextMismatchError.name);
        expect(causeStr).toContain("VALUE_MISMATCH");
      }
    });

    it("does reject assertion when property is absent from source (absent property does not count as agreement) (L2-001.T01)", async () => {
      const assertion: FactualAssertion = {
        assertionId: "as-03",
        assertedValue: "NORMAL",
        entityId: "patient-101",
        property: "cardiacTroponin", // Absent from properties
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertFactualCorrectness(
          [assertion],
          registeredContext
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(L2ContextMismatchError.name);
        expect(causeStr).toContain("PROPERTY_ABSENT");
        expect(causeStr).toContain(
          "absent property does not count as agreement"
        );
      }
    });
  });

  describe("OPR-L2-002: Complete output for declared question", () => {
    const dischargeTemplate: MustAnswerTemplate = {
      questionScope: "PATIENT_DISCHARGE",
      requireContraindicationCheck: true,
      requiredFacts: ["dischargeDiagnosis", "followupAppointment"],
      requireMissingEvidenceWarning: true,
      requireUncertaintyDeclaration: true,
      templateId: "tpl-discharge-v1",
      version: "1.0.0",
    };

    it("does pass completeness when all required facts and declarations are present", async () => {
      const validPayload = {
        contraindications: ["Avoid NSAIDs due to renal status"],
        dischargeDiagnosis: "Acute viral bronchitis resolved",
        followupAppointment: "2026-09-25T10:00:00Z",
        uncertainty: { confidence: 0.95 },
        warnings: ["No lab results older than 48 hours available"],
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertCompleteness(
          validPayload,
          dischargeTemplate
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const result = await Effect.runPromise(program);
      expect(result.passed).toBe(true);
      expect(result.omittedFacts.length).toBe(0);
    });

    it("does fail completeness when required fact or contraindication is omitted (L2-002.T01)", async () => {
      const incompletePayload = {
        dischargeDiagnosis: "Acute viral bronchitis resolved",
        uncertainty: { confidence: 0.95 },
        // Omitted: followupAppointment and contraindications
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertCompleteness(
          incompletePayload,
          dischargeTemplate
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(CompletenessCheckFailedError.name);
        expect(causeStr).toContain("followupAppointment");
        expect(causeStr).toContain("contraindication_check");
      }
    });
  });

  describe("OPR-L2-003: Cited claims with resolvable support", () => {
    it("does resolve valid citation to exact evidence character span", async () => {
      const citation: EvidenceCitation = {
        charSpan: { end: 76, start: 33 },
        citationId: "cit-01",
        claimId: "clm-potassium-normal",
        evidenceId: "ev-chart-001",
        expectedTextSnippet: "Serum potassium level measured at 4.8 mEq/L",
        sourceVersion: "v1.0",
        targetEntityId: "patient-101",
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertCitationsResolved(
          [citation],
          sampleEvidence
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const results = await Effect.runPromise(program);
      expect(results.length).toBe(1);
      expect(results[0]?.status).toBe("RESOLVED_SUPPORTED");
    });

    it("does fail citation resolution when evidence is inaccessible (L2-003.T01)", async () => {
      const citation: EvidenceCitation = {
        charSpan: { end: 20, start: 0 },
        citationId: "cit-02",
        claimId: "clm-restricted",
        evidenceId: "ev-restricted-002",
        expectedTextSnippet: "Classified enterprise",
        sourceVersion: "v1.0",
        targetEntityId: "patient-101",
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertCitationsResolved(
          [citation],
          sampleEvidence
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(CitationResolutionError.name);
        expect(causeStr).toContain("EVIDENCE_INACCESSIBLE");
      }
    });

    it("does fail citation resolution when text snippet does not match span (L2-003.T02)", async () => {
      const citation: EvidenceCitation = {
        charSpan: { end: 77, start: 33 },
        citationId: "cit-03",
        claimId: "clm-potassium",
        evidenceId: "ev-chart-001",
        expectedTextSnippet: "Serum potassium level measured at 7.5 mEq/L", // Mismatched text!
        sourceVersion: "v1.0",
        targetEntityId: "patient-101",
      };

      const program = Effect.gen(function* () {
        const verifier = yield* L2ContextVerifierService;
        return yield* verifier.assertCitationsResolved(
          [citation],
          sampleEvidence
        );
      }).pipe(Effect.provide(L2ContextVerifierServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(CitationResolutionError.name);
        expect(causeStr).toContain("SEMANTIC_MISMATCH");
      }
    });
  });

  describe("OPR-L2-004: Compliant communication", () => {
    it("does block observe-tier agent making unauthorized execution claims (L2-004.T01)", async () => {
      const contextLayer = Layer.merge(
        L2ContextVerifierServiceLive,
        QualityGateServiceLive
      );

      const program = Effect.gen(function* () {
        const qualityGate = yield* QualityGateService;
        return yield* qualityGate.evaluateOutputQuality({
          actorId: "agent-watcher-007",
          actorTier: "TIER_1_OBSERVE",
          outputText:
            "I reviewed the patient chart and I executed the dose escalation directly.",
        });
      }).pipe(Effect.provide(contextLayer));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(CommunicationComplianceViolationError.name);
        expect(causeStr).toContain("UNAUTHORIZED_EXECUTION_CLAIM");
      }
    });
  });

  describe("OPR-L2-005: Separate extraction and human admission", () => {
    it("does treat unconfirmed extraction candidate as non-authoritative evidence (L2-005.T01)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ExtractionAdmissionService;

        // Model extracts candidate fact from unstructured PDF note
        yield* service.createExtractionCandidate({
          candidateId: "cand-ejection-fraction-01",
          extractedByActorId: "agent-doc-extractor-v2",
          extractedValue: 45,
          sourceEvidenceId: "ev-echo-report-2026",
          sourceSpan: { end: 55, start: 30 },
          sourceVersion: "1.0",
        });

        // Attempt to use unadmitted candidate as authoritative evidence
        return yield* service.getAuthoritativeEvidence(
          "cand-ejection-fraction-01"
        );
      }).pipe(Effect.provide(ExtractionAdmissionServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(UnadmittedCandidateError.name);
        expect(causeStr).toContain("PENDING");
      }
    });

    it("does reject candidate admission when attempted by automated agent without human role", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ExtractionAdmissionService;

        yield* service.createExtractionCandidate({
          candidateId: "cand-ef-02",
          extractedByActorId: "agent-extractor",
          extractedValue: 50,
          sourceEvidenceId: "ev-echo",
          sourceSpan: { end: 40, start: 20 },
          sourceVersion: "1.0",
        });

        // Automated subagent tries to self-admit!
        return yield* service.admitCandidate({
          admittedByActorId: "subagent-bot",
          admittedByActorRole: "UNTRUSTED_AGENT",
          admittedValue: 50,
          candidateId: "cand-ef-02",
        });
      }).pipe(Effect.provide(ExtractionAdmissionServiceLive));

      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(FunctionPermissionDeniedError.name);
        expect(causeStr).toContain("human admission role required");
      }
    });

    it("does admit candidate upon human clinician confirmation and retain full lineage (L2-005.T02)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* ExtractionAdmissionService;

        yield* service.createExtractionCandidate({
          candidateId: "cand-ef-03",
          extractedByActorId: "agent-extractor",
          extractedValue: 40,
          sourceEvidenceId: "ev-echo-report",
          sourceSpan: { end: 50, start: 25 },
          sourceVersion: "1.0",
        });

        // Authorized human clinician reviews, modifies, and admits
        const admitted = yield* service.admitCandidate({
          admittedByActorId: "dr-smith-md",
          admittedByActorRole: "CLINICIAN",
          admittedValue: 42, // Clinician adjusted based on visual check
          candidateId: "cand-ef-03",
        });

        const authoritative =
          yield* service.getAuthoritativeEvidence("cand-ef-03");

        return { admitted, authoritative };
      }).pipe(Effect.provide(ExtractionAdmissionServiceLive));

      const { admitted, authoritative } = await Effect.runPromise(program);

      expect(admitted.admittedValue).toBe(42);
      expect(admitted.originalExtractedValue).toBe(40);
      expect(admitted.extractedByActorId).toBe("agent-extractor");
      expect(admitted.admittedByActorId).toBe("dr-smith-md");
      expect(authoritative.admittedFactId).toBe(admitted.admittedFactId);
    });
  });

  describe("OPR-L2-006: Runtime integration of quality gates", () => {
    it("does route uncited clinical findings to review in runtime quality gate (L2-006.T01)", async () => {
      const contextLayer = Layer.merge(
        L2ContextVerifierServiceLive,
        QualityGateServiceLive
      );

      const program = Effect.gen(function* () {
        const qualityGate = yield* QualityGateService;

        // Output makes clinical claims without citations
        return yield* qualityGate.evaluateOutputQuality({
          actorId: "assistant-summarizer",
          actorTier: "TIER_2_PROPOSE",
          outputText:
            "Clinical findings: Patient shows persistent hypokalemia despite potassium supplementation.",
        });
      }).pipe(Effect.provide(contextLayer));

      const evalResult = await Effect.runPromise(program);
      expect(evalResult.passed).toBe(false);
      expect(evalResult.routing).toBe("ROUTE_TO_REVIEW");
      expect(evalResult.citationsResolved).toBe(false);
    });

    it("does route to block and never emit verified badge when must-answer template fails (L2-006.T02)", async () => {
      const dischargeTemplate: MustAnswerTemplate = {
        questionScope: "DISCHARGE",
        requireContraindicationCheck: true,
        requiredFacts: ["medicationPlan"],
        requireMissingEvidenceWarning: false,
        requireUncertaintyDeclaration: false,
        templateId: "tpl-disc-short",
        version: "1.0",
      };

      const contextLayer = Layer.merge(
        L2ContextVerifierServiceLive,
        QualityGateServiceLive
      );

      const program = Effect.gen(function* () {
        const qualityGate = yield* QualityGateService;

        return yield* qualityGate.evaluateOutputQuality({
          actorId: "assistant-discharge",
          actorTier: "TIER_2_PROPOSE",
          outputText: "Discharge instructions prepared.",
          structuredPayload: { patientId: "P001" }, // Missing medicationPlan and contraindications!
          template: dischargeTemplate,
        });
      }).pipe(Effect.provide(contextLayer));

      const evalResult = await Effect.runPromise(program);
      expect(evalResult.passed).toBe(false);
      expect(evalResult.routing).toBe("BLOCK");
      expect(evalResult.completenessPassed).toBe(false);
    });
  });
});
