import type {
  AdmittedFactRecord,
  ExtractedCandidateFact,
  TextCharSpan,
} from "@operon/schema";
import { Clock, Context, Effect, Layer } from "effect";

import {
  FunctionPermissionDeniedError,
  UnadmittedCandidateError,
} from "../actions-errors.js";

/**
 * Service governing separate extraction and human admission of evidence facts (OPR-L2-005)
 */
export class ExtractionAdmissionService extends Context.Service<
  ExtractionAdmissionService,
  {
    readonly admitCandidate: (params: {
      readonly admittedByActorId: string;
      readonly admittedByActorRole: string;
      readonly admittedValue: unknown;
      readonly candidateId: string;
    }) => Effect.Effect<
      AdmittedFactRecord,
      FunctionPermissionDeniedError | UnadmittedCandidateError
    >;

    readonly createExtractionCandidate: (params: {
      readonly candidateId: string;
      readonly extractedByActorId: string;
      readonly extractedValue: unknown;
      readonly sourceEvidenceId: string;
      readonly sourceSpan: TextCharSpan;
      readonly sourceVersion: string | number;
    }) => Effect.Effect<ExtractedCandidateFact, never>;

    readonly getAuthoritativeEvidence: (
      candidateId: string
    ) => Effect.Effect<AdmittedFactRecord, UnadmittedCandidateError>;

    readonly getCandidate: (
      candidateId: string
    ) => Effect.Effect<ExtractedCandidateFact | undefined, never>;

    readonly rejectCandidate: (
      candidateId: string,
      rejectedByActorId: string
    ) => Effect.Effect<void, UnadmittedCandidateError>;
  }
>()("operon/runtime/ExtractionAdmissionService") {}

const PERMITTED_HUMAN_ROLES = new Set([
  "CLINICIAN",
  "HUMAN_OPERATOR",
  "SUPERVISOR",
  "ADMIN",
  "REVIEWER",
]);

/**
 * Live layer for ExtractionAdmissionService
 */
export const ExtractionAdmissionServiceLive = Layer.sync(
  ExtractionAdmissionService,
  () => {
    const candidates = new Map<string, ExtractedCandidateFact>();
    const admittedFacts = new Map<string, AdmittedFactRecord>();

    return ExtractionAdmissionService.of({
      admitCandidate: Effect.fn("ExtractionAdmissionService.admitCandidate")(
        function* (params) {
          const {
            admittedByActorId,
            admittedByActorRole,
            admittedValue,
            candidateId,
          } = params;

          const candidate = candidates.get(candidateId);
          if (!candidate) {
            return yield* new UnadmittedCandidateError({
              candidateId,
              message: `Candidate fact '${candidateId}' not found`,
              status: "NOT_FOUND",
            });
          }

          // Must be admitted by an authorized human role, not by automated agents (OPR-L2-005)
          if (!PERMITTED_HUMAN_ROLES.has(admittedByActorRole)) {
            return yield* new FunctionPermissionDeniedError({
              callerId: admittedByActorId,
              functionId: "admitCandidate",
              message: `Actor '${admittedByActorId}' with role '${admittedByActorRole}' is not authorized to admit evidence; human admission role required`,
              missingPermissions: ["HUMAN_ADMISSION_AUTHORITY"],
            });
          }

          // Update candidate status
          const updatedCandidate: ExtractedCandidateFact = {
            ...candidate,
            status: "ADMITTED",
          };
          candidates.set(candidateId, updatedCandidate);

          // Record admitted fact preserving extraction and edit lineage (OPR-L2-005.T02)
          const now = yield* Clock.currentTimeMillis;
          const admittedFact: AdmittedFactRecord = {
            admittedAt: now,
            admittedByActorId,
            admittedFactId: `adm-${candidateId}`,
            admittedValue,
            candidateId,
            extractedByActorId: candidate.extractedByActorId,
            originalExtractedValue: candidate.extractedValue,
            sourceEvidenceId: candidate.sourceEvidenceId,
            sourceSpan: candidate.sourceSpan,
            sourceVersion: candidate.sourceVersion,
          };

          admittedFacts.set(candidateId, admittedFact);
          return admittedFact;
        }
      ),

      createExtractionCandidate: Effect.fn(
        "ExtractionAdmissionService.createExtractionCandidate"
      )(function* (params) {
        const now = yield* Clock.currentTimeMillis;
        const candidate: ExtractedCandidateFact = {
          candidateId: params.candidateId,
          extractedAt: now,
          extractedByActorId: params.extractedByActorId,
          extractedValue: params.extractedValue,
          sourceEvidenceId: params.sourceEvidenceId,
          sourceSpan: params.sourceSpan,
          sourceVersion: params.sourceVersion,
          status: "PENDING", // Candidate starts in unconfirmed PENDING state (OPR-L2-005.T01)
        };

        candidates.set(params.candidateId, candidate);
        return candidate;
      }),

      getAuthoritativeEvidence: Effect.fn(
        "ExtractionAdmissionService.getAuthoritativeEvidence"
      )(function* (candidateId: string) {
        const candidate = candidates.get(candidateId);
        if (!candidate || candidate.status !== "ADMITTED") {
          return yield* new UnadmittedCandidateError({
            candidateId,
            message: `Candidate '${candidateId}' is in '${candidate?.status ?? "UNKNOWN"}' state and cannot be used as authoritative evidence without human admission`,
            status: candidate?.status ?? "UNKNOWN",
          });
        }

        const admitted = admittedFacts.get(candidateId);
        if (!admitted) {
          return yield* new UnadmittedCandidateError({
            candidateId,
            message: `Admitted record for candidate '${candidateId}' missing`,
            status: "CORRUPTED",
          });
        }

        return admitted;
      }),

      getCandidate: Effect.fn("ExtractionAdmissionService.getCandidate")(
        (candidateId: string) => Effect.sync(() => candidates.get(candidateId))
      ),

      rejectCandidate: Effect.fn("ExtractionAdmissionService.rejectCandidate")(
        function* (candidateId: string) {
          const candidate = candidates.get(candidateId);
          if (!candidate) {
            return yield* new UnadmittedCandidateError({
              candidateId,
              message: `Candidate '${candidateId}' not found`,
              status: "NOT_FOUND",
            });
          }

          candidates.set(candidateId, { ...candidate, status: "REJECTED" });
        }
      ),
    });
  }
);
