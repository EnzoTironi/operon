import type { AccessKey, ModelCandidateEvaluation } from "@operon/schema";
import { Context, Effect, Layer } from "effect";

import {
  KeyScopeViolationError,
  UntrustedCandidateQuarantinedError,
} from "../actions-errors.js";

export type KeyOperationType =
  | "definition_change"
  | "production_read"
  | "production_write"
  | "self_approval"
  | "proposal_submission"
  | "sandbox_read"
  | "sandbox_write";

export interface KeyOperationCheck {
  readonly operation: KeyOperationType;
  readonly targetId: string;
}

export interface ModelCandidateInput {
  readonly candidateId: string;
  readonly modelId: string;
  readonly payload: Record<string, unknown>;
  readonly declaredActionId?: string;
  readonly targetObjectType?: string;
}

export interface RegistryContext {
  readonly knownActionIds: readonly string[];
  readonly knownObjectTypes: readonly string[];
  readonly restrictedFields?: readonly string[];
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:previous\s+)?(?:instructions|rules|guards|policies)/iu,
  /bypass\s+(?:security|policy|guard|approval|envelope)/iu,
  /grant\s+(?:all|admin|root|superuser)\s+access/iu,
  /approve\s+(?:own\s+)?proposal/iu,
  /leak\s+(?:secret|key|token|credential)/iu,
  /system\s*:\s*(?:override|escalate|elevate)/iu,
  /overridePolicy\s*:\s*true/iu,
  /securityBypass\s*:\s*true/iu,
];

const FORBIDDEN_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  "approved",
  "approvalReceipt",
  "verdict",
  "authorityElevated",
  "bypassReview",
  "skipReview",
  "isSystemAuthorized",
]);

const DEFAULT_RESTRICTED_FIELDS: readonly string[] = [
  "password",
  "passwordHash",
  "secret",
  "apiKey",
  "token",
  "ssn",
  "creditCard",
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * Service governing key separation (consumer vs builder) and deterministic model candidate admission (S12 / OPR-AGT-003, OPR-AGT-004)
 */
export class ModelBoundaryService extends Context.Service<
  ModelBoundaryService,
  {
    readonly validateKeyOperation: (
      key: AccessKey,
      check: KeyOperationCheck
    ) => Effect.Effect<void, KeyScopeViolationError>;

    readonly evaluateModelCandidate: (
      input: ModelCandidateInput,
      registry: RegistryContext
    ) => Effect.Effect<ModelCandidateEvaluation, never>;

    readonly admitCandidate: (
      input: ModelCandidateInput,
      registry: RegistryContext
    ) => Effect.Effect<
      Record<string, unknown>,
      UntrustedCandidateQuarantinedError
    >;
  }
>()("operon/runtime/ModelBoundaryService") {}

function checkRegistry(
  input: ModelCandidateInput,
  registry: RegistryContext
): { violations: string[]; isRejected: boolean } {
  const violations: string[] = [];
  let isRejected = false;
  if (
    input.declaredActionId !== undefined &&
    !registry.knownActionIds.includes(input.declaredActionId)
  ) {
    violations.push(
      `Nonexistent action '${input.declaredActionId}': not registered in catalog`
    );
    isRejected = true;
  }
  if (
    input.targetObjectType !== undefined &&
    !registry.knownObjectTypes.includes(input.targetObjectType)
  ) {
    violations.push(
      `Nonexistent object type '${input.targetObjectType}': not defined in ontology`
    );
    isRejected = true;
  }
  return { isRejected, violations };
}

function extractStrings(obj: unknown, acc: string[]): void {
  if (typeof obj === "string") {
    acc.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStrings(item, acc);
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      extractStrings(val, acc);
    }
  }
}

function checkInjections(payload: Record<string, unknown>): {
  violations: string[];
  isQuarantined: boolean;
} {
  const violations: string[] = [];
  let isQuarantined = false;
  const strings: string[] = [];
  extractStrings(payload, strings);

  for (const str of strings) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(str)) {
        violations.push(
          `Prompt injection or safety bypass pattern detected in candidate output: "${str.slice(0, 80)}"`
        );
        isQuarantined = true;
        break;
      }
    }
  }
  return { isQuarantined, violations };
}

function checkAuthorityAndRestricted(
  payload: Record<string, unknown>,
  registry: RegistryContext
): { violations: string[]; isQuarantined: boolean } {
  const violations: string[] = [];
  let isQuarantined = false;

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      violations.push(
        `Model candidate attempted to self-certify authority using reserved field '${key}'`
      );
      isQuarantined = true;
    }
  }

  const restricted = new Set([
    ...DEFAULT_RESTRICTED_FIELDS,
    ...(registry.restrictedFields ?? []),
  ]);
  for (const key of Object.keys(payload)) {
    if (restricted.has(key)) {
      violations.push(
        `Model candidate contains restricted or hidden field '${key}'`
      );
      isQuarantined = true;
    }
  }

  return { isQuarantined, violations };
}

function evaluateCandidate(
  input: ModelCandidateInput,
  registry: RegistryContext
): ModelCandidateEvaluation {
  const reg = checkRegistry(input, registry);
  const inj = checkInjections(input.payload);
  const auth = checkAuthorityAndRestricted(input.payload, registry);

  const violations = [...reg.violations, ...inj.violations, ...auth.violations];
  const isRejected = reg.isRejected;
  const isQuarantined = inj.isQuarantined || auth.isQuarantined;

  const evaluatedAt = Date.now();

  if (isRejected) {
    const evaluation: ModelCandidateEvaluation = {
      candidateId: input.candidateId,
      evaluatedAt,
      modelId: input.modelId,
      quarantineReason: "Registry check failed: unlisted action or object type",
      verdict: "REJECTED",
      violations,
    };
    return evaluation;
  }

  if (isQuarantined) {
    const evaluation: ModelCandidateEvaluation = {
      candidateId: input.candidateId,
      evaluatedAt,
      modelId: input.modelId,
      quarantineReason: violations.join("; "),
      verdict: "QUARANTINED",
      violations,
    };
    return evaluation;
  }

  // Clean candidate sanitized payload
  const sanitizedPayload: Record<string, unknown> = { ...input.payload };

  const evaluation: ModelCandidateEvaluation = {
    candidateId: input.candidateId,
    evaluatedAt,
    modelId: input.modelId,
    sanitizedPayload,
    verdict: "ADMITTED",
    violations: [],
  };
  return evaluation;
}

export const ModelBoundaryServiceLive = Layer.succeed(
  ModelBoundaryService,
  ModelBoundaryService.of({
    validateKeyOperation: Effect.fn(
      "ModelBoundaryService.validateKeyOperation"
    )(function* (key: AccessKey, check: KeyOperationCheck) {
      switch (key.scope) {
        case "CONSUMER": {
          if (check.operation === "definition_change") {
            return yield* new KeyScopeViolationError({
              attemptedAction: check.operation,
              keyId: key.keyId,
              keyScope: "CONSUMER",
              message: `Consumer key '${key.keyId}' cannot change governing definitions or guard policies (targetDomain: definition)`,
              targetDomain: "definition",
            });
          }
          if (check.operation === "self_approval") {
            return yield* new KeyScopeViolationError({
              attemptedAction: check.operation,
              keyId: key.keyId,
              keyScope: "CONSUMER",
              message: `Consumer key '${key.keyId}' cannot approve proposals directly without independent review (targetDomain: self_approval)`,
              targetDomain: "self_approval",
            });
          }
          break;
        }
        case "BUILDER": {
          if (
            check.operation === "production_read" ||
            check.operation === "production_write"
          ) {
            return yield* new KeyScopeViolationError({
              attemptedAction: check.operation,
              keyId: key.keyId,
              keyScope: "BUILDER",
              message: `Builder key '${key.keyId}' cannot directly access production business data (targetDomain: production_data); use isolated sandbox resources`,
              targetDomain: "production_data",
            });
          }
          if (check.operation === "self_approval") {
            return yield* new KeyScopeViolationError({
              attemptedAction: check.operation,
              keyId: key.keyId,
              keyScope: "BUILDER",
              message: `Builder key '${key.keyId}' cannot self-approve or merge its own proposal into production (targetDomain: self_approval)`,
              targetDomain: "self_approval",
            });
          }
          break;
        }
        default: {
          break;
        }
      }
    }),

    evaluateModelCandidate: Effect.fn(
      "ModelBoundaryService.evaluateModelCandidate"
    )((input: ModelCandidateInput, registry: RegistryContext) =>
      Effect.sync(() => evaluateCandidate(input, registry))
    ),

    admitCandidate: Effect.fn("ModelBoundaryService.admitCandidate")(function* (
      input: ModelCandidateInput,
      registry: RegistryContext
    ) {
      const evalResult = evaluateCandidate(input, registry);

      if (evalResult.verdict !== "ADMITTED" || !evalResult.sanitizedPayload) {
        return yield* new UntrustedCandidateQuarantinedError({
          candidateId: input.candidateId,
          message: `Model candidate '${input.candidateId}' was not admitted: ${evalResult.quarantineReason ?? "Validation failed"}`,
          modelId: input.modelId,
          reason: evalResult.quarantineReason ?? "validation_failed",
          violations: evalResult.violations,
        });
      }

      return evalResult.sanitizedPayload;
    }),
  })
);
