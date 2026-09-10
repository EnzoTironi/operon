import { Data, Effect } from "effect";

import type {
  Candidate,
  Profile,
  RuntimeVersions,
  SourceSet,
} from "./candidate.js";
import {
  CANONICAL_SOURCE_PRECEDENCE,
  computeCandidateDigest,
} from "./candidate.js";
import { computeCanonicalDigest } from "./definition.js";

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "UNKNOWN_SCHEMA_VERSION"
  | "SOURCE_PRECEDENCE_VIOLATION"
  | "UNDEFINED_TYPE"
  | "DUPLICATE_TYPE_ID"
  | "INVALID_PRIMARY_KEY"
  | "INVALID_EFFECT_CLASS"
  | "INVALID_PROPERTY_TYPE"
  | "INVALID_IDENTIFIER"
  | "EMPTY_RULE_EXPRESSION"
  | "INVALID_FRESHNESS_BUDGET"
  | "MISSING_REQUIRED_ROLES";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
}

export class SourcePrecedenceViolationError extends Data.TaggedError(
  "SourcePrecedenceViolationError"
)<{
  readonly message: string;
  readonly declaredOrder: readonly string[];
  readonly expectedOrder: readonly string[];
}> {}

export class UnknownSchemaVersionError extends Data.TaggedError(
  "UnknownSchemaVersionError"
)<{
  readonly version: string;
  readonly supportedVersions: readonly string[];
}> {}

export class CompilationError extends Data.TaggedError("CompilationError")<{
  readonly message: string;
  readonly errors: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}> {}

export const SUPPORTED_SCHEMA_VERSIONS = [
  "operon.schema/v1",
  "1.0.0",
  "v1",
] as const;

export const DEFAULT_RUNTIME_VERSIONS: RuntimeVersions = {
  effect: "4.0.0-rc.112",
  node: "22.0.0",
  pnpm: "10.4.1",
};

const VALID_PROPERTY_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "json",
]);
const VALID_EFFECT_CLASSES = new Set([
  "read_only",
  "state_mutation",
  "external_side_effect",
]);

/**
 * Validates and compiles a SourceSet into an immutable, reproducible Candidate with diagnostics.
 */
export function validateAndCompile(source: SourceSet): {
  readonly candidate?: Candidate;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
} {
  const diagnostics: Diagnostic[] = [];

  // 1. Validate schema version
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(source.schemaVersion as any)) {
    diagnostics.push({
      code: "UNKNOWN_SCHEMA_VERSION",
      message: `Unknown schema version '${source.schemaVersion}'. Supported versions are: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
      path: "schemaVersion",
      severity: "error",
    });
  }

  // 2. Validate source precedence order
  if (source.precedence) {
    const isExact =
      source.precedence.length === CANONICAL_SOURCE_PRECEDENCE.length &&
      source.precedence.every(
        (val, idx) => val === CANONICAL_SOURCE_PRECEDENCE[idx]
      );
    if (!isExact) {
      diagnostics.push({
        code: "SOURCE_PRECEDENCE_VIOLATION",
        message: `Source precedence must match canonical order [${CANONICAL_SOURCE_PRECEDENCE.join(", ")}], but received [${source.precedence.join(", ")}]. Precedence alteration fails closed.`,
        path: "precedence",
        severity: "error",
      });
    }
  }

  // 3. Validate type definitions
  const declaredTypeIds = new Set<string>();
  const typePropertyMap = new Map<string, Set<string>>();

  for (const t of source.definitions.types) {
    if (declaredTypeIds.has(t.id)) {
      diagnostics.push({
        code: "DUPLICATE_TYPE_ID",
        message: `Duplicate type definition id '${t.id}'`,
        path: `types.${t.id}`,
        severity: "error",
      });
      continue;
    }
    declaredTypeIds.add(t.id);

    const propNames = new Set(Object.keys(t.properties));
    typePropertyMap.set(t.id, propNames);

    if (!propNames.has(t.primaryKey)) {
      diagnostics.push({
        code: "INVALID_PRIMARY_KEY",
        message: `Type '${t.id}' declares primary key '${t.primaryKey}' which is missing from its properties`,
        path: `types.${t.id}.primaryKey`,
        severity: "error",
      });
    }

    for (const [propName, propDef] of Object.entries(t.properties)) {
      if (!VALID_PROPERTY_TYPES.has(propDef.type)) {
        diagnostics.push({
          code: "INVALID_PROPERTY_TYPE",
          message: `Property '${propName}' in type '${t.id}' has invalid type '${propDef.type}'`,
          path: `types.${t.id}.properties.${propName}`,
          severity: "error",
        });
      }
    }
  }

  // 4. Validate links
  for (const l of source.definitions.links) {
    if (!declaredTypeIds.has(l.sourceTypeId)) {
      diagnostics.push({
        code: "UNDEFINED_TYPE",
        message: `Link '${l.id}' references undefined sourceTypeId '${l.sourceTypeId}'`,
        path: `links.${l.id}.sourceTypeId`,
        severity: "error",
      });
    }
    if (!declaredTypeIds.has(l.targetTypeId)) {
      diagnostics.push({
        code: "UNDEFINED_TYPE",
        message: `Link '${l.id}' references undefined targetTypeId '${l.targetTypeId}'`,
        path: `links.${l.id}.targetTypeId`,
        severity: "error",
      });
    }
  }

  // 5. Validate queries
  for (const q of source.definitions.queries) {
    if (!declaredTypeIds.has(q.returnTypeId)) {
      diagnostics.push({
        code: "UNDEFINED_TYPE",
        message: `Query '${q.id}' references undefined returnTypeId '${q.returnTypeId}'`,
        path: `queries.${q.id}.returnTypeId`,
        severity: "error",
      });
    }
  }

  // 6. Validate actions
  for (const a of source.definitions.actions) {
    if (!VALID_EFFECT_CLASSES.has(a.effectClass)) {
      diagnostics.push({
        code: "INVALID_EFFECT_CLASS",
        message: `Action '${a.id}' declares invalid effectClass '${a.effectClass}'`,
        path: `actions.${a.id}.effectClass`,
        severity: "error",
      });
    }
    if (!a.requiredRoles || a.requiredRoles.length === 0) {
      diagnostics.push({
        code: "MISSING_REQUIRED_ROLES",
        message: `Action '${a.id}' must declare at least one required role`,
        path: `actions.${a.id}.requiredRoles`,
        severity: "error",
      });
    }
  }

  // 7. Validate policies
  for (const p of source.definitions.policies) {
    if (!p.ruleExpression || p.ruleExpression.trim().length === 0) {
      diagnostics.push({
        code: "EMPTY_RULE_EXPRESSION",
        message: `Policy '${p.id}' contains an empty rule expression`,
        path: `policies.${p.id}.ruleExpression`,
        severity: "error",
      });
    }
  }

  // 8. Validate freshness rules
  for (const f of source.definitions.freshness) {
    if (declaredTypeIds.has(f.typeId)) {
      const props = typePropertyMap.get(f.typeId);
      if (props && !props.has(f.propertyName)) {
        diagnostics.push({
          code: "UNDEFINED_TYPE",
          message: `Freshness rule references property '${f.propertyName}' not found in type '${f.typeId}'`,
          path: `freshness.${f.typeId}.${f.propertyName}`,
          severity: "error",
        });
      }
    } else {
      diagnostics.push({
        code: "UNDEFINED_TYPE",
        message: `Freshness rule references undefined typeId '${f.typeId}'`,
        path: `freshness.${f.typeId}.${f.propertyName}`,
        severity: "error",
      });
    }
    if (f.maxStalenessMs <= 0) {
      diagnostics.push({
        code: "INVALID_FRESHNESS_BUDGET",
        message: `Freshness maxStalenessMs must be > 0 for '${f.typeId}.${f.propertyName}'`,
        path: `freshness.${f.typeId}.${f.propertyName}.maxStalenessMs`,
        severity: "error",
      });
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  if (hasErrors) {
    return {
      diagnostics,
      success: false,
    };
  }

  // Deterministic compilation and hashing
  const contractsDigest = computeCanonicalDigest(source.definitions);
  const profile: Profile = source.profile ?? "local";
  const runtimeVersions: RuntimeVersions =
    source.runtimeVersions ?? DEFAULT_RUNTIME_VERSIONS;

  const candidateDigest = computeCandidateDigest({
    config: source.config,
    contracts: contractsDigest,
    lock: source.lock,
    profile,
    runtimeVersions,
    tree: source.tree,
  });

  const candidate: Candidate = {
    candidateDigest,
    candidateId: `cand_${candidateDigest.slice(0, 16)}`,
    config: source.config,
    contracts: contractsDigest,
    lock: source.lock,
    profile,
    runtimeVersions,
    timestamp: 0, // Deterministic timestamp fixed at 0 for candidate identity reproducibility
    tree: source.tree,
  };

  return {
    candidate,
    diagnostics,
    success: true,
  };
}

/**
 * Pure function compilation conforming to V1-01 sketch
 */
export function compile(source: SourceSet): {
  readonly candidate?: Candidate;
  readonly diagnostics: readonly Diagnostic[];
} {
  const result = validateAndCompile(source);
  return {
    candidate: result.candidate,
    diagnostics: result.diagnostics,
  };
}

/**
 * Effect-based candidate compilation with narrow error channel
 */
export function compileCandidate(source: SourceSet): Effect.Effect<
  {
    readonly candidate: Candidate;
    readonly diagnostics: readonly Diagnostic[];
  },
  SourcePrecedenceViolationError | UnknownSchemaVersionError | CompilationError
> {
  return Effect.gen(function* () {
    const result = validateAndCompile(source);

    if (!result.success || !result.candidate) {
      const precedenceError = result.diagnostics.find(
        (d) => d.code === "SOURCE_PRECEDENCE_VIOLATION"
      );
      if (precedenceError) {
        return yield* Effect.fail(
          new SourcePrecedenceViolationError({
            declaredOrder: source.precedence ?? [],
            expectedOrder: CANONICAL_SOURCE_PRECEDENCE,
            message: precedenceError.message,
          })
        );
      }

      const versionError = result.diagnostics.find(
        (d) => d.code === "UNKNOWN_SCHEMA_VERSION"
      );
      if (versionError) {
        return yield* Effect.fail(
          new UnknownSchemaVersionError({
            supportedVersions: SUPPORTED_SCHEMA_VERSIONS,
            version: source.schemaVersion,
          })
        );
      }

      const errorMessages = result.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `[${d.code}] ${d.message}`);

      return yield* Effect.fail(
        new CompilationError({
          diagnostics: result.diagnostics,
          errors: errorMessages,
          message: `Candidate compilation failed with ${errorMessages.length} error(s): ${errorMessages.join("; ")}`,
        })
      );
    }

    return {
      candidate: result.candidate,
      diagnostics: result.diagnostics,
    };
  });
}
