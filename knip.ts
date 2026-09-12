import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [".cursor/**", "frozen/**", "tools/**"],
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
    "packages/alchemy": {
      entry: ["src/worker.ts!"],
      ignoreDependencies: ["alchemy"],
    },
  },
};

export default config;
