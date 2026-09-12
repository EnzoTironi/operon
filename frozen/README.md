# Frozen

Code in this directory is kept for reference and is out of every default graph:

- not a pnpm workspace package (`pnpm-workspace.yaml` lists `packages/*` only), so `pnpm -r run build` and `pnpm -r run test` skip it;
- ignored by oxlint and oxfmt (`frozen/**` in `oxlint.config.ts` and `oxfmt.config.ts`);
- ignored by knip (`frozen/**` in `knip.ts`).

Nothing here is maintained. It may stop compiling against the current packages. Deletion is a founder decision; see the PR that froze each entry.

## Index

| Path | Was | Why frozen |
| :-- | :-- | :-- |
| `examples/aviation-skywise` | `examples/aviation-skywise` | Industry demo outside the phase 1 e-mail demo (roadmap Fase 1, corta/congela). |
| `examples/healthcare-cdss` | `examples/healthcare-cdss` | Industry demo outside the phase 1 e-mail demo; phase 1 has no healthcare recipe. |
| `examples/higher-education` | `examples/higher-education` | Industry demo outside the phase 1 e-mail demo. |
| `examples/sompo-rdp` | `examples/sompo-rdp` | Industry demo outside the phase 1 e-mail demo. |
| `examples/wastewater-compliance` | `examples/wastewater-compliance` | Industry demo outside the phase 1 e-mail demo. |
| `validation/evidence-gate.ts` | `validation/evidence-gate.ts` | S17 evidence gate signer. Part of the F1/F2 assurance program, which phase 1 freezes. Never wired into CI. |
| `validation/publication` | `validation/publication` | Publication boundary gate over `@operon/assurance`. Same program. Never wired into CI. |
| `mcp/ai-fde.ts` | `packages/mcp/src/ai-fde.ts` | Regex AI-FDE extractor. Phase 1 freezes it; the live `@operon/mcp` graph does not export it. |

## Thawing an entry

Move it back to its original path and restore the workspace glob, or add `frozen/examples/*` to `pnpm-workspace.yaml`. The example `tsconfig.json` files and `validation/publication/publication-gate.ts` already resolve paths from their frozen location.
