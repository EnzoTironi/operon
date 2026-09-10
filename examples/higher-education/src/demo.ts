import { Effect } from "effect";

import { runHigherEducationSimulation } from "./simulation.js";

const exitCode = await Effect.runPromise(
  Effect.tryPromise({
    try: () => runHigherEducationSimulation(),
    catch: (error: unknown) => error,
  }).pipe(
    Effect.as(0),
    Effect.catch((error) => {
      console.error("Simulation failed:", error);
      return Effect.succeed(1);
    }),
    Effect.catchDefect((defect) => {
      console.error("Simulation failed:", defect);
      return Effect.succeed(1);
    })
  )
);
process.exit(exitCode);
