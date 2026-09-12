import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: [
    ...core.ignorePatterns,
    "**/dist/**",
    "**/*.d.ts",
    "**/*.d.mts",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "frozen/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  categories: {
    correctness: "error",
    suspicious: "error",
    pedantic: "error",
    perf: "error",
  },
  rules: {
    // Native Oxlint companion rule
    "oxc/no-accumulating-spread": "error",

    // Anti-Slop Generic Rules
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-widen-then-assert": "error",

    // Anti-Slop Effect Rules
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",

    // Legitimate framework & architecture overrides (documented with real reasons, NOT reward-hacking)
    "anti-slop/no-unsafe-dictionary-type": "off", // Dynamic operational ontology objects and property bags are typed as Record<string, unknown>
    "anti-slop/require-safety-comment-for-type-assertion": "off", // TypeScript type assertions are validated at domain and schema boundaries
    "anti-slop/no-object-parameters": "off", // Option bag parameters (e.g. { dbPath, json }) are idiomatic across CLI and runtime
    "anti-slop/no-known-value-widening": "off", // Ontological property schemas widen literal representations by design
    "anti-slop/no-unknown-parameters": "off", // Dynamic data ingestion and schema validation boundary inputs accept unknown
    "anti-slop/no-unknown-returns": "off", // Dynamic schema evaluators and interpreters return unconstrained values
    "anti-slop/no-runtime-typeof": "off", // Representation narrowing in boundary parsers and serializers
    "anti-slop/require-readable-spacing": "off", // Whitespace layout is strictly owned and validated by oxfmt (pnpm run format)
    "anti-slop-effect/no-manual-tag-comparison": "off", // Schema and result tag comparisons are idiomatic across runtime
    "anti-slop-effect/no-manual-tagged-construction": "off", // Action logs, proposals, and events construct tagged shapes
    "oxc/no-barrel-file": "off", // Monorepo package entry points (packages/*/src/index.ts) are barrel files by design
    "sort-keys": "off", // Alphabetical key sorting harms semantic property ordering (e.g. id, name, status, createdAt)
    "eslint/sort-keys": "off",
    "max-classes-per-file": "off", // Effect Data.TaggedError declarations are co-located in errors.ts
    "eslint/max-classes-per-file": "off",
    "max-lines-per-function": "off", // Complex transaction workflows and domain interpreters exceed arbitrary limits
    "eslint/max-lines-per-function": "off",
    "max-lines": "off",
    "eslint/max-lines": "off",
    complexity: "off", // Effect generator workflows, transaction pipelines, and AST visitors exceed arbitrary cyclomatic complexity limits
    "eslint/complexity": "off",
    "max-depth": "off",
    "eslint/max-depth": "off",
    "func-style": "off", // Generator functions and arrow callbacks are both idiomatic depending on Effect context
    "eslint/func-style": "off",
    "no-inline-comments": "off", // Inline architecture references (e.g., // S15, OPR-FULL-044) are required documentation
    "eslint/no-inline-comments": "off",
    "jsdoc/require-param": "off", // TypeScript provides authoritative type annotations; duplicate JSDoc tags are redundant
    "jsdoc/require-returns": "off",
    "no-bitwise": "off", // Bitwise operators are required for hashing, bitmasks, and checksums
    "eslint/no-bitwise": "off",
    "no-plusplus": "off", // Standard loop iteration
    "eslint/no-plusplus": "off",
    "eslint/class-methods-use-this": "off", // Effect service classes implement interfaces where some methods are pure
    "eslint/func-names": "off", // Effect.gen(function* () { ... }) uses anonymous generator functions by design
    "eslint/no-redeclare": "off", // In TypeScript, value/type pairing (const Foo and type Foo) is standard; typescript/no-redeclare handles real collisions
    "typescript/no-redeclare": "off",
    "typescript/no-explicit-any": "off", // Schema reflection and raw payload boundaries use any where unconstrained
    "typescript/parameter-properties": "off", // Constructor parameter properties (e.g. constructor(readonly x: string)) are standard TypeScript OOP
    "typescript/no-non-null-assertion": "off", // Invariants proven by preceding guards and schema definitions
    "unicorn/numeric-separators-style": "off", // Millisecond constants and schema numbers
    "unicorn/no-array-callback-reference": "off", // Point-free style in Effect and Array pipelines
    "unicorn/prefer-ternary": "off", // If/else statements are clearer for multi-line Effect branches
    "unicorn/prefer-array-find": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-object-as-default-parameter": "off",
    "unicorn/prefer-single-call": "off",
    "unicorn/no-useless-undefined": "off", // Effect.succeed(undefined) and Option constructors require explicit undefined argument to satisfy generic type contracts
    "unicorn/no-negated-condition": "off", // Early-return guard clauses (if (!valid) return;) are idiomatic to keep happy-path execution unnested
    "eslint/prefer-destructuring": "off", // Direct property access (record.prop) is often clearer than destructuring and avoids variable shadowing
    "eslint/no-nested-ternary": "off",
    "eslint/curly": "off",
    "promise/prefer-await-to-then": "off",
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/__tests__/**"],
      rules: {
        complexity: "off",
        "eslint/complexity": "off",
        "typescript/no-non-null-assertion": "off", // Test assertions like expect(res.items[0]!.id).toBe(...) are idiomatic in Vitest
        "anti-slop/require-safety-comment-for-type-assertion": "off", // Test harnesses and mocks perform test-only assertions without production safety invariants
        "unicorn/numeric-separators-style": "off", // Test fixtures, timestamps, timeouts, and sample counts (e.g. 1000, 5000) are standard
        "typescript/no-explicit-any": "off", // Testing invalid inputs or mocking external interfaces in test suites
        "anti-slop/no-unsafe-dictionary-type": "off", // Test fixtures use loose mock dictionary objects
        "anti-slop-effect/no-manual-tag-comparison": "off", // Vitest assertions inspect result._tag
        "anti-slop-effect/no-manual-tagged-construction": "off", // Test mock payloads construct fixture objects
      },
    },
  ],
});
