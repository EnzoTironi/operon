import { Stack } from "alchemy/Stack";
import { Context, Effect, Layer } from "effect";

const DOCUMENTED_CELL_STAGES = ["local", "dev", "staging", "prod"] as const;

type DocumentedCellStage = (typeof DOCUMENTED_CELL_STAGES)[number];

export type CellStageTier = "ephemeral" | "shared-preprod" | "production";

export function cellDatabaseName(stage: string): string {
  return `operon_${stage.replaceAll("-", "_")}`;
}

function cellStageTier(stage: string): CellStageTier {
  if (stage === "prod") {
    return "production";
  }
  if (stage === "staging") {
    return "shared-preprod";
  }
  return "ephemeral";
}

function cellEnvFileHint(stage: string): string {
  switch (stage) {
    case "prod": {
      return ".env.prod";
    }
    case "staging": {
      return ".env.staging";
    }
    case "dev": {
      return ".env.dev";
    }
    default: {
      return ".env.local";
    }
  }
}

function isDocumentedCellStage(stage: string): stage is DocumentedCellStage {
  return DOCUMENTED_CELL_STAGES.some((documented) => documented === stage);
}

function retainPostgresDataOnDestroy(stage: string): boolean {
  return stage === "prod";
}

/**
 * Effect layer: stage-derived policy for the Operon cell Postgres composition.
 * Staging and prod share the same Docker program; they differ by tier,
 * env-file hint, and whether destroy retains the data volume.
 */
export class CellStagePolicy extends Context.Service<
  CellStagePolicy,
  {
    readonly stage: string;
    readonly documented: boolean;
    readonly tier: CellStageTier;
    readonly database: string;
    readonly envFileHint: string;
    readonly retainPostgresData: boolean;
  }
>()("operon/alchemy/CellStagePolicy") {
  static readonly layer = Layer.effect(
    CellStagePolicy,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const { stage } = stack;
      return CellStagePolicy.of({
        database: cellDatabaseName(stage),
        documented: isDocumentedCellStage(stage),
        envFileHint: cellEnvFileHint(stage),
        retainPostgresData: retainPostgresDataOnDestroy(stage),
        stage,
        tier: cellStageTier(stage),
      });
    })
  );
}
