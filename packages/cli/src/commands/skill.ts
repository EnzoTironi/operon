import { BUILTIN_SKILLS, SkillService } from "@operon/skills";
import { Effect } from "effect";

export function runSkill(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const action = args[0];
    const isJson = args.includes("--json");

    const service = SkillService.make();
    for (const skill of BUILTIN_SKILLS) {
      yield* service.registerSkill(skill);
    }

    if (action === "list" || !action) {
      const skills = yield* service.listSkills();
      if (isJson) {
        console.log(JSON.stringify(skills, null, 2));
      } else {
        console.log(`Registered Skills (${skills.length}):`);
        for (const s of skills) {
          console.log(`  - [${s.id}] ${s.name} (v${s.version})`);
          console.log(`    ${s.description}`);
          console.log(`    Required Tools: ${s.requiredTools.join(", ")}`);
          console.log(`    Digest: ${s.digest}`);
        }
      }
      return 0;
    }

    if (action === "get") {
      const skillId = args[1];
      if (!skillId) {
        console.error(
          "Error: Missing skill ID. Usage: operon skill get <skillId> [--json]"
        );
        return 1;
      }
      const skill = yield* service.getSkill(skillId).pipe(
        Effect.catchTag("SkillNotFoundError", (err) => {
          console.error(`Error: Skill '${err.skillId}' not found.`);
          return Effect.succeed(undefined);
        })
      );
      if (!skill) return 1;

      if (isJson) {
        console.log(JSON.stringify(skill, null, 2));
      } else {
        console.log(`Skill: ${skill.name} (${skill.id})`);
        console.log(`Version: ${skill.version}`);
        console.log(`Min Contract: ${skill.minContract}`);
        console.log(`Required Tools: ${skill.requiredTools.join(", ")}`);
        console.log(
          `Authority Prerequisites: ${
            skill.authorityPrerequisites.join(", ") || "none"
          }`
        );
        console.log(`Digest: ${skill.digest}`);
      }
      return 0;
    }

    console.error(`Unknown skill action: ${action}. Use 'list' or 'get'.`);
    return 1;
  });
}
