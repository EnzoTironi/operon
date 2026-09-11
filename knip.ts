import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [".cursor/**", ".agents/**", "tools/**"],
  ignoreDependencies: [
    "@effect/language-service",
    "@vitest/coverage-v8",
    "fast-check",
  ],
  ignoreExportsUsedInFile: true,
  rules: {
    duplicates: "off",
  },
  workspaces: {
    ".": {
      entry: [
        "validation/**/*.ts",
        ".agents/skills/verify-operon/helpers/**/*.ts",
      ],
    },
    "packages/alchemy": {
      entry: ["src/worker.ts!"],
      ignoreDependencies: ["alchemy"],
    },
    "examples/*": {
      entry: ["src/demo.ts!", "src/simulation.ts!"],
    },
  },
};

export default config;
