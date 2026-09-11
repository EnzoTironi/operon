import type {
  CitationResolutionResult,
  CompletenessCheckResult,
  EvidenceCitation,
  FactualAssertion,
  L2VerificationVerdict,
  MustAnswerTemplate,
  ObjectInstance,
} from "@operon/schema";
import { Context, Effect, Layer } from "effect";

import {
  CitationResolutionError,
  CompletenessCheckFailedError,
  L2ContextMismatchError,
} from "../actions-errors.js";

export interface RegisteredEvidenceSource {
  readonly accessible: boolean;
  readonly content: string;
  readonly evidenceId: string;
  readonly version: string | number;
}

/**
 * Service providing L2 ground truth verification, completeness checking, and citation resolution (OPR-L2-001, 002, 003)
 */
export class L2ContextVerifierService extends Context.Service<
  L2ContextVerifierService,
  {
    readonly assertCitationsResolved: (
      citations: readonly EvidenceCitation[],
      registeredEvidence: Record<string, RegisteredEvidenceSource>
    ) => Effect.Effect<
      readonly CitationResolutionResult[],
      CitationResolutionError
    >;

    readonly assertCompleteness: (
      outputPayload: Record<string, unknown>,
      template: MustAnswerTemplate
    ) => Effect.Effect<CompletenessCheckResult, CompletenessCheckFailedError>;

    readonly assertFactualCorrectness: (
      assertions: readonly FactualAssertion[],
      registeredContext: Record<string, ObjectInstance>
    ) => Effect.Effect<
      readonly L2VerificationVerdict[],
      L2ContextMismatchError
    >;

    readonly resolveCitations: (
      citations: readonly EvidenceCitation[],
      registeredEvidence: Record<string, RegisteredEvidenceSource>
    ) => Effect.Effect<readonly CitationResolutionResult[], never>;

    readonly verifyCompleteness: (
      outputPayload: Record<string, unknown>,
      template: MustAnswerTemplate
    ) => Effect.Effect<CompletenessCheckResult, never>;

    readonly verifyFactualAssertions: (
      assertions: readonly FactualAssertion[],
      registeredContext: Record<string, ObjectInstance>
    ) => Effect.Effect<readonly L2VerificationVerdict[], never>;
  }
>()("operon/runtime/L2ContextVerifierService") {}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Live layer for L2ContextVerifierService
 */
export const L2ContextVerifierServiceLive = Layer.sync(
  L2ContextVerifierService,
  () =>
    L2ContextVerifierService.of({
      assertCitationsResolved: Effect.fn(
        "L2ContextVerifierService.assertCitationsResolved"
      )(function* (citations, registeredEvidence) {
        const verifier = yield* L2ContextVerifierService;
        const results = yield* verifier.resolveCitations(
          citations,
          registeredEvidence
        );

        for (const res of results) {
          if (res.status !== "RESOLVED_SUPPORTED") {
            const cit = citations.find((c) => c.citationId === res.citationId);
            const claimId = cit?.claimId ?? "unknown";
            return yield* Effect.fail(
              new CitationResolutionError({
                citationId: res.citationId,
                claimId,
                message: `Citation resolution failed: ${res.details}`,
                reason:
                  res.status === "NOT_FOUND"
                    ? "EVIDENCE_NOT_FOUND"
                    : res.status === "INACCESSIBLE"
                      ? "EVIDENCE_INACCESSIBLE"
                      : res.status === "VERSION_MISMATCH"
                        ? "VERSION_MISMATCH"
                        : res.status === "SPAN_OUT_OF_BOUNDS"
                          ? "SPAN_OUT_OF_BOUNDS"
                          : "SEMANTIC_MISMATCH",
              })
            );
          }
        }

        return results;
      }),

      assertCompleteness: Effect.fn(
        "L2ContextVerifierService.assertCompleteness"
      )(function* (outputPayload, template) {
        const verifier = yield* L2ContextVerifierService;
        const result = yield* verifier.verifyCompleteness(
          outputPayload,
          template
        );

        if (!result.passed) {
          const omitted = [...result.omittedFacts];
          if (result.missingContraindications) {
            omitted.push("contraindication_check");
          }
          if (result.missingUncertainty) {
            omitted.push("uncertainty_declaration");
          }
          if (result.missingEvidenceWarningOmitted) {
            omitted.push("missing_evidence_warnings");
          }

          return yield* Effect.fail(
            new CompletenessCheckFailedError({
              message: `Output failed completeness check for template '${template.templateId}': omitted [${omitted.join(", ")}]`,
              omittedRequirements: omitted,
              templateId: template.templateId,
            })
          );
        }

        return result;
      }),

      assertFactualCorrectness: Effect.fn(
        "L2ContextVerifierService.assertFactualCorrectness"
      )(function* (assertions, registeredContext) {
        const verifier = yield* L2ContextVerifierService;
        const verdicts = yield* verifier.verifyFactualAssertions(
          assertions,
          registeredContext
        );

        for (const v of verdicts) {
          if (v.status !== "VERIFIED") {
            const assertion = assertions.find(
              (a) => a.assertionId === v.assertionId
            );
            const entityId = assertion?.entityId ?? "unknown";
            const property = assertion?.property ?? "unknown";

            return yield* Effect.fail(
              new L2ContextMismatchError({
                assertionId: v.assertionId,
                details: v.details,
                entityId,
                message: `L2 Context verification failed for entity '${entityId}', property '${property}': ${v.details}`,
                property,
                reason:
                  v.status === "OBJECT_NOT_FOUND"
                    ? "OBJECT_NOT_FOUND"
                    : v.status === "PROPERTY_ABSENT"
                      ? "PROPERTY_ABSENT"
                      : v.status === "VERSION_MISMATCH"
                        ? "VERSION_MISMATCH"
                        : "VALUE_MISMATCH",
              })
            );
          }
        }

        return verdicts;
      }),

      resolveCitations: Effect.fn("L2ContextVerifierService.resolveCitations")(
        (citations, registeredEvidence) =>
          Effect.sync(() => {
            const results: CitationResolutionResult[] = [];

            for (const citation of citations) {
              const evidence = registeredEvidence[citation.evidenceId];
              if (!evidence) {
                results.push({
                  citationId: citation.citationId,
                  details: `Evidence ID '${citation.evidenceId}' not found in registered evidence`,
                  status: "NOT_FOUND",
                });
                continue;
              }

              if (!evidence.accessible) {
                results.push({
                  citationId: citation.citationId,
                  details: `Evidence ID '${citation.evidenceId}' is inaccessible to current tenant/caller`,
                  status: "INACCESSIBLE",
                });
                continue;
              }

              if (String(evidence.version) !== String(citation.sourceVersion)) {
                results.push({
                  citationId: citation.citationId,
                  details: `Version mismatch: evidence version is '${evidence.version}', citation cited '${citation.sourceVersion}'`,
                  status: "VERSION_MISMATCH",
                });
                continue;
              }

              const { end, start } = citation.charSpan;
              if (start < 0 || end > evidence.content.length || start >= end) {
                results.push({
                  citationId: citation.citationId,
                  details: `Span [${start}, ${end}] is out of bounds for content length ${evidence.content.length}`,
                  status: "SPAN_OUT_OF_BOUNDS",
                });
                continue;
              }

              const actualSnippet = evidence.content.slice(start, end);
              if (
                actualSnippet.trim() !== citation.expectedTextSnippet.trim()
              ) {
                results.push({
                  citationId: citation.citationId,
                  details: `Snippet mismatch: expected '${citation.expectedTextSnippet}', found '${actualSnippet}'`,
                  status: "SEMANTIC_MISMATCH",
                });
                continue;
              }

              results.push({
                citationId: citation.citationId,
                details:
                  "Citation resolved and supported by ground evidence span",
                status: "RESOLVED_SUPPORTED",
              });
            }

            return results;
          })
      ),

      verifyCompleteness: Effect.fn(
        "L2ContextVerifierService.verifyCompleteness"
      )((outputPayload, template) =>
        Effect.sync(() => {
          const omittedFacts: string[] = [];

          for (const fact of template.requiredFacts) {
            const val = outputPayload[fact];
            if (val === undefined || val === null) {
              omittedFacts.push(fact);
            }
          }

          let missingUncertainty = false;
          if (
            template.requireUncertaintyDeclaration &&
            outputPayload.uncertainty === undefined &&
            outputPayload.confidence === undefined
          ) {
            missingUncertainty = true;
          }

          let missingContraindications = false;
          if (
            template.requireContraindicationCheck &&
            outputPayload.contraindications === undefined
          ) {
            missingContraindications = true;
          }

          let missingEvidenceWarningOmitted = false;
          if (
            template.requireMissingEvidenceWarning &&
            outputPayload.missingEvidenceWarnings === undefined &&
            outputPayload.warnings === undefined
          ) {
            missingEvidenceWarningOmitted = true;
          }

          const passed =
            omittedFacts.length === 0 &&
            !missingUncertainty &&
            !missingContraindications &&
            !missingEvidenceWarningOmitted;

          return {
            missingContraindications,
            missingEvidenceWarningOmitted,
            missingUncertainty,
            omittedFacts,
            passed,
            templateId: template.templateId,
          };
        })
      ),

      verifyFactualAssertions: Effect.fn(
        "L2ContextVerifierService.verifyFactualAssertions"
      )((assertions, registeredContext) =>
        Effect.sync(() => {
          const verdicts: L2VerificationVerdict[] = [];

          for (const assertion of assertions) {
            const entity = registeredContext[assertion.entityId];
            if (!entity) {
              verdicts.push({
                assertionId: assertion.assertionId,
                details: `Entity '${assertion.entityId}' not found in registered evidence context`,
                status: "OBJECT_NOT_FOUND",
              });
              continue;
            }

            if (
              assertion.expectedVersion !== undefined &&
              String(entity.version ?? entity.lastModifiedAt) !==
                String(assertion.expectedVersion)
            ) {
              verdicts.push({
                assertionId: assertion.assertionId,
                details: `Entity '${assertion.entityId}' version mismatch`,
                status: "VERSION_MISMATCH",
              });
              continue;
            }

            // In Operon, properties is a record on entity
            const properties = (entity.properties ?? {}) as Record<
              string,
              unknown
            >;
            if (!(assertion.property in properties)) {
              // Absent property does NOT count as agreement! (OPR-L2-001)
              verdicts.push({
                assertionId: assertion.assertionId,
                details: `Property '${assertion.property}' is absent in entity '${assertion.entityId}' (absent property does not count as agreement)`,
                status: "PROPERTY_ABSENT",
              });
              continue;
            }

            const evidenceValue = properties[assertion.property];
            if (!valuesEqual(evidenceValue, assertion.assertedValue)) {
              verdicts.push({
                assertionId: assertion.assertionId,
                details: `Value mismatch for '${assertion.property}': asserted '${JSON.stringify(assertion.assertedValue)}', evidence has '${JSON.stringify(evidenceValue)}'`,
                evidenceValue,
                status: "MISMATCH_VALUE",
              });
              continue;
            }

            verdicts.push({
              assertionId: assertion.assertionId,
              details: `Factual assertion verified against ground evidence`,
              evidenceValue,
              status: "VERIFIED",
            });
          }

          return verdicts;
        })
      ),
    })
);
