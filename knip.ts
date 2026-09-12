import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [".cursor/**", "tools/**"],
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
      entry: ["validation/**/*.ts"],
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
