import path from "node:path";

import { Effect, Exit } from "effect";

export function runDemo(args: string[]): Effect.Effect<number, unknown, never> {
  const domain = args[0];

  if (!domain) {
    console.error("Error: Missing demo domain name.");
    console.error(
      "  Usage: operon demo <healthcare|aviation|wastewater|sompo|education>"
    );
    console.error("  Example: operon demo healthcare");
    return Effect.succeed(1);
  }

  const root = path.resolve(import.meta.dirname, "../../..");

  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        switch (domain.toLowerCase()) {
          case "healthcare":
          case "cdss": {
            const modPath = path.join(
              root,
              "examples/healthcare-cdss/dist/simulation.js"
            );
            const mod = (yield* Effect.promise(() => import(modPath))) as {
              runClinicalSimulation: () => Promise<void>;
            };
            yield* Effect.promise(() => mod.runClinicalSimulation());
            return 0;
          }
          case "aviation":
          case "skywise": {
            const modPath = path.join(
              root,
              "examples/aviation-skywise/dist/simulation.js"
            );
            const mod = (yield* Effect.promise(() => import(modPath))) as {
              runAviationSimulation: () => Promise<void>;
            };
            yield* Effect.promise(() => mod.runAviationSimulation());
            return 0;
          }
          case "wastewater":
          case "compliance": {
            const modPath = path.join(
              root,
              "examples/wastewater-compliance/dist/simulation.js"
            );
            const mod = (yield* Effect.promise(() => import(modPath))) as {
              runWastewaterSimulation: () => Promise<void>;
            };
            yield* Effect.promise(() => mod.runWastewaterSimulation());
            return 0;
          }
          case "sompo":
          case "rdp": {
            const modPath = path.join(
              root,
              "examples/sompo-rdp/dist/simulation.js"
            );
            const mod = (yield* Effect.promise(() => import(modPath))) as {
              runSompoRdpSimulation: () => Promise<void>;
            };
            yield* Effect.promise(() => mod.runSompoRdpSimulation());
            return 0;
          }
          case "education":
          case "higher-ed": {
            const modPath = path.join(
              root,
              "examples/higher-education/dist/simulation.js"
            );
            const mod = (yield* Effect.promise(() => import(modPath))) as {
              runHigherEducationSimulation: () => Promise<void>;
            };
            yield* Effect.promise(() => mod.runHigherEducationSimulation());
            return 0;
          }
          default: {
            console.error(`Error: Unknown demo domain '${domain}'`);
            console.error(
              "  Available domains: healthcare, aviation, wastewater, sompo, education"
            );
            return 1;
          }
        }
      })
    );

    if (Exit.isFailure(exit)) {
      console.error(
        `Error: Failed to execute demo simulation '${domain}': ${String(exit.cause)}`
      );
      return 1;
    }

    return exit.value;
  }).pipe(Effect.annotateLogs({ command: "demo", domain }));
}
