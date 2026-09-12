import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: [".cursor/**", "frozen/**", "tools/**", "packages/gateway/vendor/**"],
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
      entry: ["alchemy.run.ts!"],
      ignoreBinaries: ["umask"],
    },
    "packages/gateway": {
      entry: ["src/index.ts!", "src/cell.ts!"],
      ignore: ["vendor/**"],
      ignoreDependencies: [
        "@babel/parser",
        "@cfworker/json-schema",
        "@effect/platform-node",
        "@libsql/client",
        "@modelcontextprotocol/client",
        "@modelcontextprotocol/core",
        "@modelcontextprotocol/sdk",
        "@paralleldrive/cuid2",
        "@standard-schema/spec",
        "@types/js-yaml",
        "@types/semver",
        "ajv",
        "ajv-formats",
        "drizzle-orm",
        "fractional-indexing",
        "graphql",
        "graphql-yoga",
        "js-yaml",
        "kysely",
        "oauth4webapi",
        "openapi-types",
        "quickjs-emscripten",
        "semver",
        "sucrase",
        "tldts",
        "zod",
      ],
    },
  },
};

export default config;
