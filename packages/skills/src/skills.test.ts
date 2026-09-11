import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuditInvestigationSkill, BUILTIN_SKILLS } from "./builtin.js";
import {
  IncompatibleContractError,
  InsufficientAuthorityError,
  MissingToolError,
  SkillNotFoundError,
} from "./errors.js";
import { computeSkillDigest, defineSkill } from "./manifest.js";
import { SkillService } from "./registry.js";

describe("@operon/skills", () => {
  it("computes deterministic RFC 8785 canonical digests", () => {
    const raw = {
      authorityPrerequisites: ["auditor"],
      description: "Sample test skill",
      id: "test.skill",
      inputSchema: { foo: "string" },
      minContract: "operon.kernel/v0",
      name: "Test Skill",
      outputSchema: { bar: "number" },
      requiredTools: ["tool_a", "tool_b"],
      version: "1.0.0",
    };

    const digest1 = computeSkillDigest(raw);
    const digest2 = computeSkillDigest(raw);
    expect(digest1).toBe(digest2);
    expect(digest1).toHaveLength(64); // SHA-256 hex

    const skill = defineSkill(raw);
    expect(skill.digest).toBe(digest1);
  });

  it("registers and lists skills via SkillService", async () => {
    const service = SkillService.make("operon.kernel/v0");

    await Promise.all(
      BUILTIN_SKILLS.map((skill) =>
        Effect.runPromise(service.registerSkill(skill))
      )
    );

    const listed = await Effect.runPromise(service.listSkills());
    expect(listed).toHaveLength(7);
    expect(listed.map((s) => s.id)).toEqual(BUILTIN_SKILLS.map((s) => s.id));

    const retrieved = await Effect.runPromise(
      service.getSkill(AuditInvestigationSkill.id)
    );
    expect(retrieved.id).toBe(AuditInvestigationSkill.id);
    expect(retrieved.digest).toBe(AuditInvestigationSkill.digest);
  });

  it("rejects skill with incompatible kernel contract version", async () => {
    const service = SkillService.make("operon.kernel/v0");
    const futureSkill = defineSkill({
      authorityPrerequisites: [],
      description: "Skill requiring future v2 kernel",
      id: "future.skill",
      inputSchema: {},
      minContract: "operon.kernel/v2",
      name: "Future Skill",
      outputSchema: {},
      requiredTools: [],
      version: "2.0.0",
    });

    const error = await Effect.runPromise(
      service.registerSkill(futureSkill).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(IncompatibleContractError);
    expect((error as IncompatibleContractError).minContract).toBe(
      "operon.kernel/v2"
    );
  });

  it("validates skill execution: passes when tools and roles are met", async () => {
    const service = SkillService.make("operon.kernel/v0");
    await Effect.runPromise(service.registerSkill(AuditInvestigationSkill));

    const result = await Effect.runPromise(
      service.validateExecution(
        AuditInvestigationSkill.id,
        ["operon_verify_audit_ledger", "operon_get_audit_records"],
        ["auditor"]
      )
    );

    expect(result.allowed).toBe(true);
    expect(result.skill.id).toBe(AuditInvestigationSkill.id);
  });

  it("validates skill execution: fails with MissingToolError when tools are missing", async () => {
    const service = SkillService.make("operon.kernel/v0");
    await Effect.runPromise(service.registerSkill(AuditInvestigationSkill));

    const error = await Effect.runPromise(
      service
        .validateExecution(
          AuditInvestigationSkill.id,
          ["operon_get_audit_records"], // missing operon_verify_audit_ledger
          ["auditor"]
        )
        .pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(MissingToolError);
    expect((error as MissingToolError).missingTools).toEqual([
      "operon_verify_audit_ledger",
    ]);
  });

  it("validates skill execution: fails with InsufficientAuthorityError when role is missing", async () => {
    const service = SkillService.make("operon.kernel/v0");
    await Effect.runPromise(service.registerSkill(AuditInvestigationSkill));

    const error = await Effect.runPromise(
      service
        .validateExecution(
          AuditInvestigationSkill.id,
          ["operon_verify_audit_ledger", "operon_get_audit_records"],
          ["viewer"] // Not auditor or compliance_officer
        )
        .pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InsufficientAuthorityError);
    expect((error as InsufficientAuthorityError).requiredAuthorities).toEqual([
      "auditor",
      "compliance_officer",
    ]);
  });

  it("allows execution when subject has admin role regardless of prerequisites", async () => {
    const service = SkillService.make("operon.kernel/v0");
    await Effect.runPromise(service.registerSkill(AuditInvestigationSkill));

    const result = await Effect.runPromise(
      service.validateExecution(
        AuditInvestigationSkill.id,
        ["operon_verify_audit_ledger", "operon_get_audit_records"],
        ["admin"]
      )
    );

    expect(result.allowed).toBe(true);
  });

  it("returns SkillNotFoundError for non-existent skill ID", async () => {
    const service = SkillService.make("operon.kernel/v0");

    const error = await Effect.runPromise(
      service.getSkill("nonexistent.skill").pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(SkillNotFoundError);
    expect((error as SkillNotFoundError).skillId).toBe("nonexistent.skill");
  });
});
