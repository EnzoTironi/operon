import type {
  AuthorityTier,
  EvidenceCitation,
  MustAnswerTemplate,
  QualityGateEvaluation,
} from "@operon/schema";
import { Clock, Context, Effect, Layer } from "effect";

import { CommunicationComplianceViolationError } from "../actions-errors.js";
import {
  resolveCitationsInternal,
  verifyCompletenessInternal,
} from "./l2-context-verifier.js";
import type { RegisteredEvidenceSource } from "./l2-context-verifier.js";

/**
 * Service enforcing communication compliance and runtime output quality gates (OPR-L2-004, 006)
 */
export class QualityGateService extends Context.Service<
  QualityGateService,
  {
    readonly evaluateOutputQuality: (params: {
      readonly actorId: string;
      readonly actorTier: AuthorityTier;
      readonly citations?: readonly EvidenceCitation[];
      readonly outputText: string;
      readonly registeredEvidence?: Record<string, RegisteredEvidenceSource>;
      readonly structuredPayload?: Record<string, unknown>;
      readonly template?: MustAnswerTemplate;
    }) => Effect.Effect<
      QualityGateEvaluation,
      CommunicationComplianceViolationError
    >;
  }
>()("operon/runtime/QualityGateService") {}

function checkCommunicationCompliance(
  actorId: string,
  actorTier?: AuthorityTier,
  lowerText?: string
): Effect.Effect<void, CommunicationComplianceViolationError> {
  if (
    actorTier === "TIER_1_OBSERVE" &&
    lowerText &&
    (lowerText.includes("i executed") ||
      lowerText.includes("i have approved") ||
      lowerText.includes("action executed") ||
      lowerText.includes("guarantee this action is safe"))
  ) {
    return new CommunicationComplianceViolationError({
      actorId,
      actorTier,
      message: `Observe-tier agent '${actorId}' made unauthorized execution/approval claim in communication`,
      violationType: "UNAUTHORIZED_EXECUTION_CLAIM",
    });
  }
  return Effect.void;
}

function checkCitationsResolution(
  citations: readonly EvidenceCitation[] | undefined,
  registeredEvidence: Record<string, RegisteredEvidenceSource> | undefined,
  lowerText: string
): boolean {
  if (citations && citations.length > 0) {
    const resolutionResults = resolveCitationsInternal(
      citations,
      registeredEvidence ?? {}
    );
    return resolutionResults.every(
      (res) => res.status === "RESOLVED_SUPPORTED"
    );
  }
  if (
    lowerText.includes("factual finding") ||
    lowerText.includes("clinical finding") ||
    lowerText.includes("diagnosis")
  ) {
    return false;
  }
  return true;
}

function determineRouting(
  passed: boolean,
  citationsResolved: boolean
): {
  reason: string;
  routing: "ALLOW" | "ROUTE_TO_REVIEW" | "BLOCK";
} {
  if (passed) {
    return {
      reason:
        "Quality gate verified: citations resolved and completeness satisfied",
      routing: "ALLOW",
    };
  }
  if (citationsResolved) {
    return {
      reason: "Quality gate failed: mandatory must-answer items omitted",
      routing: "BLOCK",
    };
  }
  return {
    reason:
      "Quality gate failed: uncited or unresolvable claims route to review",
    routing: "ROUTE_TO_REVIEW",
  };
}

/**
 * Live layer for QualityGateService
 */
export const QualityGateServiceLive = Layer.sync(QualityGateService, () =>
  QualityGateService.of({
    evaluateOutputQuality: Effect.fn(
      "QualityGateService.evaluateOutputQuality"
    )(function* (params) {
      const {
        actorId,
        actorTier,
        citations = [],
        outputText,
        registeredEvidence = {},
        structuredPayload = {},
        template,
      } = params;

      const lowerText = outputText.toLowerCase();

      yield* checkCommunicationCompliance(actorId, actorTier, lowerText);

      const citationsResolved = checkCitationsResolution(
        citations,
        registeredEvidence,
        lowerText
      );

      const completenessPassed = template
        ? verifyCompletenessInternal(structuredPayload, template).passed
        : true;

      const passed = citationsResolved && completenessPassed;
      const { reason, routing } = determineRouting(passed, citationsResolved);
      const now = yield* Clock.currentTimeMillis;

      return {
        actorId,
        actorTier,
        citationsResolved,
        completenessPassed,
        compliancePassed: true,
        gateId: `gate-${now}`,
        passed,
        reason,
        routing,
      };
    }),
  })
);
