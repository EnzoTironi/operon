import { Context, Effect, Layer } from "effect";

import {
  IncompatibleContractError,
  InsufficientAuthorityError,
  MissingToolError,
  SkillNotFoundError,
} from "./errors.js";
import type { SkillManifest } from "./manifest.js";

export interface SkillRegistryService {
  readonly registerSkill: (
    skill: SkillManifest
  ) => Effect.Effect<void, IncompatibleContractError>;
  readonly getSkill: (
    id: string
  ) => Effect.Effect<SkillManifest, SkillNotFoundError>;
  readonly listSkills: () => Effect.Effect<readonly SkillManifest[]>;
  readonly validateExecution: (
    skillId: string,
    availableTools: readonly string[],
    subjectRoles: readonly string[]
  ) => Effect.Effect<
    { readonly allowed: true; readonly skill: SkillManifest },
    SkillNotFoundError | MissingToolError | InsufficientAuthorityError
  >;
}

export class SkillService extends Context.Service<
  SkillService,
  SkillRegistryService
>()("@operon/skills/SkillService") {
  static readonly defaultKernelContract = "operon.kernel/v0";

  static make(
    kernelContract: string = SkillService.defaultKernelContract
  ): SkillRegistryService {
    const skills = new Map<string, SkillManifest>();

    return {
      registerSkill: (skill: SkillManifest) =>
        Effect.gen(function* () {
          if (skill.minContract > kernelContract) {
            return yield* Effect.fail(
              new IncompatibleContractError({
                kernelContract,
                minContract: skill.minContract,
                skillId: skill.id,
              })
            );
          }
          skills.set(skill.id, skill);
        }),

      getSkill: (id: string) =>
        Effect.gen(function* () {
          const skill = skills.get(id);
          if (!skill) {
            return yield* Effect.fail(new SkillNotFoundError({ skillId: id }));
          }
          return skill;
        }),

      listSkills: () => Effect.succeed([...skills.values()]),

      validateExecution: (
        skillId: string,
        availableTools: readonly string[],
        subjectRoles: readonly string[]
      ) =>
        Effect.gen(function* () {
          const skill = skills.get(skillId);
          if (!skill) {
            return yield* Effect.fail(new SkillNotFoundError({ skillId }));
          }

          const missingTools = skill.requiredTools.filter(
            (t: string) => !availableTools.includes(t)
          );
          if (missingTools.length > 0) {
            return yield* Effect.fail(
              new MissingToolError({
                missingTools,
                skillId,
              })
            );
          }

          if (skill.authorityPrerequisites.length > 0) {
            const hasAuthority =
              subjectRoles.includes("admin") ||
              skill.authorityPrerequisites.some((req: string) =>
                subjectRoles.includes(req)
              );
            if (!hasAuthority) {
              return yield* Effect.fail(
                new InsufficientAuthorityError({
                  actualRoles: subjectRoles,
                  requiredAuthorities: skill.authorityPrerequisites,
                  skillId,
                })
              );
            }
          }

          return { allowed: true as const, skill };
        }),
    };
  }

  static readonly live = Layer.succeed(SkillService, SkillService.make());
}
