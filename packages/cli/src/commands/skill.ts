import { BUILTIN_SKILLS, SkillService } from "@operon/skills";
import type { SkillRegistryService } from "@operon/skills";
import { Effect } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";

interface SkillSummary {
  readonly description: string;
  readonly digest: string;
  readonly id: string;
  readonly name: string;
  readonly requiredTools: readonly string[];
  readonly version: string;
}

interface SkillDetail extends SkillSummary {
  readonly authorityPrerequisites: readonly string[];
  readonly minContract: string;
}

function printSkillsHuman(skills: readonly SkillSummary[]) {
  printCli(`Registered Skills (${skills.length}):`);
  for (const s of skills) {
    printCli(`  - [${s.id}] ${s.name} (v${s.version})`);
    printCli(`    ${s.description}`);
    printCli(`    Required Tools: ${s.requiredTools.join(", ")}`);
    printCli(`    Digest: ${s.digest}`);
  }
}

const handleListSkills = Effect.fn("handleListSkills")(function* (
  service: SkillRegistryService,
  isJson: boolean
) {
  const skills = yield* service.listSkills();
  if (isJson) {
    printCliJson(skills);
  } else {
    printSkillsHuman(skills);
  }
  return 0;
});

function printSkillHuman(skill: SkillDetail) {
  printCli(`Skill: ${skill.name} (${skill.id})`);
  printCli(`Version: ${skill.version}`);
  printCli(`Min Contract: ${skill.minContract}`);
  printCli(`Required Tools: ${skill.requiredTools.join(", ")}`);
  printCli(
    `Authority Prerequisites: ${
      skill.authorityPrerequisites.join(", ") || "none"
    }`
  );
  printCli(`Digest: ${skill.digest}`);
}

const handleGetSkill = Effect.fn("handleGetSkill")(function* (
  service: SkillRegistryService,
  skillId: string | undefined,
  isJson: boolean
) {
  if (!skillId) {
    printCliError(
      "Error: Missing skill ID. Usage: operon skill get <skillId> [--json]"
    );
    return 1;
  }
  const skill = yield* service.getSkill(skillId).pipe(
    Effect.catchTag("SkillNotFoundError", (err) => {
      printCliError(`Error: Skill '${err.skillId}' not found.`);
      return Effect.void;
    })
  );
  if (!skill) {
    return 1;
  }
  if (isJson) {
    printCliJson(skill);
  } else {
    printSkillHuman(skill);
  }
  return 0;
});

export const runSkill = Effect.fn("runSkill")(function* (args: string[]) {
  const action = args[0] ?? "list";
  const isJson = args.includes("--json");

  const service = SkillService.make();
  yield* Effect.forEach(
    BUILTIN_SKILLS,
    (skill) => service.registerSkill(skill),
    { concurrency: 1 }
  );

  if (action === "list") {
    return yield* handleListSkills(service, isJson);
  }
  if (action === "get") {
    return yield* handleGetSkill(service, args[1], isJson);
  }

  printCliError(`Unknown skill action: ${action}. Use 'list' or 'get'.`);
  return 1;
});
