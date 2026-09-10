import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import type { DefinitionArtifact, SourceSet } from "./index.js";
import {
  CANONICAL_SOURCE_PRECEDENCE,
  compile,
  compileCandidate,
} from "./index.js";

const validArtifact: DefinitionArtifact = {
  actions: [
    {
      description: "Dispatch emergency response unit",
      effectClass: "state_mutation",
      id: "dispatch_unit",
      name: "Dispatch Unit",
      parametersSchema: { unitId: "string" },
      requiredRoles: ["dispatcher"],
      riskTier: "high",
    },
  ],
  freshness: [
    {
      maxStalenessMs: 30000,
      onStale: "warn",
      propertyName: "status",
      typeId: "Unit",
    },
  ],
  links: [
    {
      cardinality: "1:N",
      deletionSemantics: "restrict",
      id: "station_units",
      name: "stationUnits",
      sourceTypeId: "Station",
      targetTypeId: "Unit",
    },
  ],
  policies: [
    {
      id: "dispatch_gate",
      name: "Dispatch Review Gate",
      requiredReviewerRoles: ["supervisor"],
      ruleExpression: "unit.status == 'ready'",
    },
  ],
  presentation: { theme: "dark" },
  queries: [
    {
      id: "available_units",
      name: "Available Units",
      parameters: { stationId: "string" },
      returnTypeId: "Unit",
    },
  ],
  types: [
    {
      classification: "operational",
      id: "Station",
      name: "Station",
      primaryKey: "stationId",
      properties: {
        name: { name: "name", required: true, type: "string" },
        stationId: { name: "stationId", required: true, type: "string" },
      },
      typology: "entity",
    },
    {
      classification: "operational",
      id: "Unit",
      name: "Unit",
      primaryKey: "unitId",
      properties: {
        status: { name: "status", required: true, type: "string" },
        unitId: { name: "unitId", required: true, type: "string" },
      },
      typology: "entity",
    },
  ],
};

const validSourceSet: SourceSet = {
  config: "sha256:config_hash_abc123",
  definitions: validArtifact,
  lock: "sha256:lock_hash_def456",
  precedence: CANONICAL_SOURCE_PRECEDENCE,
  profile: "production",
  schemaVersion: "operon.schema/v1",
  tree: "sha256:tree_hash_789xyz",
};

describe("V1-01: Reproducible contract candidate compiler", () => {
  it("compiles valid source set to deterministic candidate and zero error diagnostics", () => {
    const result = compile(validSourceSet);
    expect(result.candidate).toBeDefined();
    expect(result.candidate?.candidateId).toMatch(/^cand_[a-f0-9]{16}$/u);
    expect(result.candidate?.profile).toBe("production");
    expect(result.candidate?.tree).toBe(validSourceSet.tree);
    expect(result.candidate?.lock).toBe(validSourceSet.lock);
    expect(result.candidate?.config).toBe(validSourceSet.config);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("produces identical contract and candidate digests when inputs are identical", () => {
    const res1 = compile(validSourceSet);
    const res2 = compile({ ...validSourceSet });

    expect(res1.candidate).toBeDefined();
    expect(res2.candidate).toBeDefined();
    expect(res1.candidate?.contracts).toBe(res2.candidate?.contracts);
    expect(res1.candidate?.candidateDigest).toBe(
      res2.candidate?.candidateDigest
    );
    expect(res1.candidate?.candidateId).toBe(res2.candidate?.candidateId);
  });

  it("produces different candidate digest if tree changes", () => {
    const res1 = compile(validSourceSet);
    const res2 = compile({
      ...validSourceSet,
      tree: "sha256:tree_hash_different",
    });

    expect(res1.candidate?.contracts).toBe(res2.candidate?.contracts);
    expect(res1.candidate?.candidateDigest).not.toBe(
      res2.candidate?.candidateDigest
    );
  });

  it("produces different candidate digest if lock changes", () => {
    const res1 = compile(validSourceSet);
    const res2 = compile({
      ...validSourceSet,
      lock: "sha256:lock_hash_different",
    });

    expect(res1.candidate?.candidateDigest).not.toBe(
      res2.candidate?.candidateDigest
    );
  });

  it("produces different candidate digest if config changes", () => {
    const res1 = compile(validSourceSet);
    const res2 = compile({
      ...validSourceSet,
      config: "sha256:config_hash_different",
    });

    expect(res1.candidate?.candidateDigest).not.toBe(
      res2.candidate?.candidateDigest
    );
  });

  it("produces different candidate and contract digests if definitions change", () => {
    const res1 = compile(validSourceSet);
    const modifiedArtifact: DefinitionArtifact = {
      ...validArtifact,
      types: [
        ...validArtifact.types,
        {
          id: "Drone",
          name: "Drone",
          primaryKey: "droneId",
          properties: {
            droneId: { name: "droneId", required: true, type: "string" },
          },
        },
      ],
    };

    const res2 = compile({
      ...validSourceSet,
      definitions: modifiedArtifact,
    });

    expect(res1.candidate?.contracts).not.toBe(res2.candidate?.contracts);
    expect(res1.candidate?.candidateDigest).not.toBe(
      res2.candidate?.candidateDigest
    );
  });

  it("produces different candidate digest across distinct profiles per ADR-02", () => {
    const localRes = compile({ ...validSourceSet, profile: "local" });
    const prodRes = compile({ ...validSourceSet, profile: "production" });

    expect(localRes.candidate?.contracts).toBe(prodRes.candidate?.contracts);
    expect(localRes.candidate?.candidateDigest).not.toBe(
      prodRes.candidate?.candidateDigest
    );
  });

  it("fails closed if source precedence order is changed", async () => {
    const scrambledPrecedence: any[] = [
      "tenant",
      "system",
      "contract",
      "environment",
    ];
    const invalidSource: SourceSet = {
      ...validSourceSet,
      precedence: scrambledPrecedence,
    };

    const pureRes = compile(invalidSource);
    expect(pureRes.candidate).toBeUndefined();
    expect(
      pureRes.diagnostics.some(
        (d) =>
          d.code === "SOURCE_PRECEDENCE_VIOLATION" && d.severity === "error"
      )
    ).toBe(true);

    const effectExit = await Effect.runPromiseExit(
      compileCandidate(invalidSource)
    );
    expect(Exit.isFailure(effectExit)).toBe(true);
    if (Exit.isFailure(effectExit)) {
      const error = effectExit.cause;
      expect(JSON.stringify(error)).toContain("SourcePrecedenceViolationError");
    }
  });

  it("fails closed if unknown schema version is provided", async () => {
    const unknownVersionSource: SourceSet = {
      ...validSourceSet,
      schemaVersion: "operon.schema/v99_unsupported",
    };

    const pureRes = compile(unknownVersionSource);
    expect(pureRes.candidate).toBeUndefined();
    expect(
      pureRes.diagnostics.some(
        (d) => d.code === "UNKNOWN_SCHEMA_VERSION" && d.severity === "error"
      )
    ).toBe(true);

    const effectExit = await Effect.runPromiseExit(
      compileCandidate(unknownVersionSource)
    );
    expect(Exit.isFailure(effectExit)).toBe(true);
    if (Exit.isFailure(effectExit)) {
      const error = effectExit.cause;
      expect(JSON.stringify(error)).toContain("UnknownSchemaVersionError");
    }
  });

  it("fails closed if link references undefined source or target type", async () => {
    const brokenLinkArtifact: DefinitionArtifact = {
      ...validArtifact,
      links: [
        {
          cardinality: "1:N",
          id: "phantom_link",
          name: "phantomLink",
          sourceTypeId: "NonExistentStation",
          targetTypeId: "Unit",
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      compileCandidate({
        ...validSourceSet,
        definitions: brokenLinkArtifact,
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const str = JSON.stringify(exit.cause);
      expect(str).toContain("UNDEFINED_TYPE");
      expect(str).toContain("NonExistentStation");
    }
  });

  it("fails closed if query references undefined return type", async () => {
    const brokenQueryArtifact: DefinitionArtifact = {
      ...validArtifact,
      queries: [
        {
          id: "ghost_query",
          name: "Ghost Query",
          parameters: {},
          returnTypeId: "GhostType",
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      compileCandidate({
        ...validSourceSet,
        definitions: brokenQueryArtifact,
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const str = JSON.stringify(exit.cause);
      expect(str).toContain("UNDEFINED_TYPE");
      expect(str).toContain("GhostType");
    }
  });

  it("fails closed if type declares primary key missing from its properties", async () => {
    const brokenKeyArtifact: DefinitionArtifact = {
      ...validArtifact,
      types: [
        {
          id: "Hospital",
          name: "Hospital",
          primaryKey: "hospitalId",
          properties: {
            name: { name: "name", required: true, type: "string" },
            // hospitalId missing
          },
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      compileCandidate({
        ...validSourceSet,
        definitions: brokenKeyArtifact,
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const str = JSON.stringify(exit.cause);
      expect(str).toContain("INVALID_PRIMARY_KEY");
      expect(str).toContain("hospitalId");
    }
  });

  it("fails closed if action declares invalid effect class", async () => {
    const brokenActionArtifact: DefinitionArtifact = {
      ...validArtifact,
      actions: [
        {
          description: "Dangerous action",
          effectClass: "arbitrary_mutation" as any,
          id: "dangerous_action",
          name: "Dangerous Action",
          parametersSchema: {},
          requiredRoles: ["admin"],
          riskTier: "critical",
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      compileCandidate({
        ...validSourceSet,
        definitions: brokenActionArtifact,
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const str = JSON.stringify(exit.cause);
      expect(str).toContain("INVALID_EFFECT_CLASS");
    }
  });

  it("fails closed if freshness budget has non-positive staleness window", async () => {
    const brokenFreshnessArtifact: DefinitionArtifact = {
      ...validArtifact,
      freshness: [
        {
          maxStalenessMs: 0,
          onStale: "reject",
          propertyName: "status",
          typeId: "Unit",
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      compileCandidate({
        ...validSourceSet,
        definitions: brokenFreshnessArtifact,
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const str = JSON.stringify(exit.cause);
      expect(str).toContain("INVALID_FRESHNESS_BUDGET");
    }
  });

  it("fails closed if policy has empty rule expression", async () => {
    const emptyPolicyArtifact: DefinitionArtifact = {
      ...validArtifact,
      policies: [
        {
          id: "blank_policy",
          name: "Blank Policy",
          requiredReviewerRoles: ["auditor"],
          ruleExpression: "   ",
        },
      ],
    };

    const exit = await Effect.runPromiseExit(
      compileCandidate({
        ...validSourceSet,
        definitions: emptyPolicyArtifact,
      })
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const str = JSON.stringify(exit.cause);
      expect(str).toContain("EMPTY_RULE_EXPRESSION");
    }
  });
});
