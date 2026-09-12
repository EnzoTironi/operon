import { Stack } from "alchemy/Stack";
import { Config, Context, Effect, Layer } from "effect";

import { cellDatabaseName, defaultCellPostgresPort } from "./connection.ts";

const DOCUMENTED_CELL_STAGES = ["local", "dev", "staging", "prod"] as const;

type DocumentedCellStage = (typeof DOCUMENTED_CELL_STAGES)[number];

export type CellStageTier = "ephemeral" | "shared-preprod" | "production";

function isDocumentedCellStage(stage: string): stage is DocumentedCellStage {
  return DOCUMENTED_CELL_STAGES.some((documented) => documented === stage);
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

/** Only production keeps its Postgres data volume when the stack is destroyed. */
function retainPostgresDataOnDestroy(stage: string): boolean {
  return stage === "prod";
}

/**
 * Stage-derived policy for the Operon cell Alchemy program.
 *
 * Every stage runs the same Docker resource graph. What differs is this
 * policy: database name, loopback port, tier, and whether destroy retains
 * the data volume. The port is deterministic per stage and can be pinned
 * with `OPERON_POSTGRES_PORT`, so the cell connection string is known
 * before the container exists.
 */
export class CellStagePolicy extends Context.Service<
  CellStagePolicy,
  {
    readonly stage: string;
    readonly documented: boolean;
    readonly tier: CellStageTier;
    readonly database: string;
    readonly port: number;
    readonly retainPostgresData: boolean;
  }
>()("operon/alchemy/CellStagePolicy") {
  static readonly layer = Layer.effect(
    CellStagePolicy,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const stage = stack.stage;
      const port = yield* Config.port("OPERON_POSTGRES_PORT").pipe(
        Config.withDefault(defaultCellPostgresPort(stage))
      );
      return CellStagePolicy.of({
        database: cellDatabaseName(stage),
        documented: isDocumentedCellStage(stage),
        port,
        retainPostgresData: retainPostgresDataOnDestroy(stage),
        stage,
        tier: cellStageTier(stage),
      });
    })
  );
}
