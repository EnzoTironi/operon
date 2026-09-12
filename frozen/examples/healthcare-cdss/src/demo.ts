import { Effect } from "effect";

import { runClinicalSimulation } from "./simulation.js";

const exitCode = await Effect.runPromise(
  Effect.tryPromise({
    catch: String,
    try: () => runClinicalSimulation(),
  }).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Effect.logError(`Simulation failed: ${String(error)}`).pipe(Effect.as(1))
    ),
    Effect.catchDefect((defect) =>
      Effect.logError(`Simulation failed: ${String(defect)}`).pipe(Effect.as(1))
    )
  )
);
process.exit(exitCode);
