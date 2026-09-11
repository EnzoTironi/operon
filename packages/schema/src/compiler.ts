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

export interface CompilationResult {
  readonly candidate?: Candidate;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

export interface CompileResult {
  readonly candidate?: Candidate;
  readonly diagnostics: readonly Diagnostic[];
}

function validateSchemaAndPrecedence(source: SourceSet): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!SUPPORTED_SCHEMA_VERSIONS.some((v) => v === source.schemaVersion)) {
    diagnostics.push({
      code: "UNKNOWN_SCHEMA_VERSION",
      message: `Unknown schema version '${source.schemaVersion}'. Supported versions are: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
      path: "schemaVersion",
      severity: "error",
    });
  }

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
  return diagnostics;
}

interface TypeValidationResult {
  readonly declaredTypeIds: Set<string>;
  readonly diagnostics: readonly Diagnostic[];
  readonly typePropertyMap: Map<string, Set<string>>;
}

function validateSingleType(
  t: SourceSet["definitions"]["types"][number],
  declaredTypeIds: Set<string>,
  typePropertyMap: Map<string, Set<string>>
): readonly Diagnostic[] {
  if (declaredTypeIds.has(t.id)) {
    return [
      {
        code: "DUPLICATE_TYPE_ID",
        message: `Duplicate type definition id '${t.id}'`,
        path: `types.${t.id}`,
        severity: "error",
      },
    ];
  }
  declaredTypeIds.add(t.id);

  const diagnostics: Diagnostic[] = [];
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

  return diagnostics;
}

function validateTypes(
  types: SourceSet["definitions"]["types"]
): TypeValidationResult {
  const declaredTypeIds = new Set<string>();
  const typePropertyMap = new Map<string, Set<string>>();
  const diagnostics: Diagnostic[] = [];

  for (const t of types) {
    diagnostics.push(
      ...validateSingleType(t, declaredTypeIds, typePropertyMap)
    );
  }

  return { declaredTypeIds, diagnostics, typePropertyMap };
}

function validateLinksAndQueries(
  links: SourceSet["definitions"]["links"],
  queries: SourceSet["definitions"]["queries"],
  declaredTypeIds: ReadonlySet<string>
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const l of links) {
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
  for (const q of queries) {
    if (!declaredTypeIds.has(q.returnTypeId)) {
      diagnostics.push({
        code: "UNDEFINED_TYPE",
        message: `Query '${q.id}' references undefined returnTypeId '${q.returnTypeId}'`,
        path: `queries.${q.id}.returnTypeId`,
        severity: "error",
      });
    }
  }
  return diagnostics;
}

function validateActions(
  actions: SourceSet["definitions"]["actions"]
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const a of actions) {
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
  return diagnostics;
}

function validatePolicies(
  policies: SourceSet["definitions"]["policies"]
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const p of policies) {
    if (!p.ruleExpression || p.ruleExpression.trim().length === 0) {
      diagnostics.push({
        code: "EMPTY_RULE_EXPRESSION",
        message: `Policy '${p.id}' contains an empty rule expression`,
        path: `policies.${p.id}.ruleExpression`,
        severity: "error",
      });
    }
  }
  return diagnostics;
}

function checkFreshnessRule(
  f: SourceSet["definitions"]["freshness"][number],
  declaredTypeIds: ReadonlySet<string>,
  typePropertyMap: ReadonlyMap<string, Set<string>>
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const props = typePropertyMap.get(f.typeId);
  if (!declaredTypeIds.has(f.typeId) || (props && !props.has(f.propertyName))) {
    const msg = declaredTypeIds.has(f.typeId)
      ? `Freshness rule references property '${f.propertyName}' not found in type '${f.typeId}'`
      : `Freshness rule references undefined typeId '${f.typeId}'`;
    diagnostics.push({
      code: "UNDEFINED_TYPE",
      message: msg,
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
  return diagnostics;
}

function validateFreshness(
  freshness: SourceSet["definitions"]["freshness"],
  declaredTypeIds: ReadonlySet<string>,
  typePropertyMap: ReadonlyMap<string, Set<string>>
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const f of freshness) {
    diagnostics.push(
      ...checkFreshnessRule(f, declaredTypeIds, typePropertyMap)
    );
  }
  return diagnostics;
}

function buildCandidate(source: SourceSet): Candidate {
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

  return {
    candidateDigest,
    candidateId: `cand_${candidateDigest.slice(0, 16)}`,
    config: source.config,
    contracts: contractsDigest,
    lock: source.lock,
    profile,
    runtimeVersions,
    timestamp: 0,
    tree: source.tree,
  };
}

/**
 * Validates and compiles a SourceSet into an immutable, reproducible Candidate with diagnostics.
 */
export function validateAndCompile(source: SourceSet): CompilationResult {
  const typesResult = validateTypes(source.definitions.types);
  const diagnostics: Diagnostic[] = [
    ...validateSchemaAndPrecedence(source),
    ...typesResult.diagnostics,
    ...validateLinksAndQueries(
      source.definitions.links,
      source.definitions.queries,
      typesResult.declaredTypeIds
    ),
    ...validateActions(source.definitions.actions),
    ...validatePolicies(source.definitions.policies),
    ...validateFreshness(
      source.definitions.freshness,
      typesResult.declaredTypeIds,
      typesResult.typePropertyMap
    ),
  ];

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  if (hasErrors) {
    return {
      diagnostics,
      success: false,
    };
  }

  return {
    candidate: buildCandidate(source),
    diagnostics,
    success: true,
  };
}

/**
 * Pure function compilation conforming to V1-01 sketch
 */
export function compile(source: SourceSet): CompileResult {
  const result = validateAndCompile(source);
  return {
    candidate: result.candidate,
    diagnostics: result.diagnostics,
  };
}

/**
 * Effect-based candidate compilation with narrow error channel
 */
export const compileCandidate = Effect.fn("compileCandidate")(function* (
  source: SourceSet
): Effect.fn.Return<
  {
    readonly candidate: Candidate;
    readonly diagnostics: readonly Diagnostic[];
  },
  SourcePrecedenceViolationError | UnknownSchemaVersionError | CompilationError
> {
  const result = validateAndCompile(source);

  if (!result.success || !result.candidate) {
    const precedenceError = result.diagnostics.find(
      (d) => d.code === "SOURCE_PRECEDENCE_VIOLATION"
    );
    if (precedenceError) {
      return yield* new SourcePrecedenceViolationError({
        declaredOrder: source.precedence ?? [],
        expectedOrder: CANONICAL_SOURCE_PRECEDENCE,
        message: precedenceError.message,
      });
    }

    const versionError = result.diagnostics.find(
      (d) => d.code === "UNKNOWN_SCHEMA_VERSION"
    );
    if (versionError) {
      return yield* new UnknownSchemaVersionError({
        supportedVersions: SUPPORTED_SCHEMA_VERSIONS,
        version: source.schemaVersion,
      });
    }

    const errorMessages = result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `[${d.code}] ${d.message}`);

    return yield* new CompilationError({
      diagnostics: result.diagnostics,
      errors: errorMessages,
      message: `Candidate compilation failed with ${errorMessages.length} error(s): ${errorMessages.join("; ")}`,
    });
  }

  return {
    candidate: result.candidate,
    diagnostics: result.diagnostics,
  };
});
