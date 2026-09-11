import { Effect, Exit } from "effect";

import { joinPath, resolvePath } from "../fs-io.js";

interface DemoTarget {
  readonly fnName: string;
  readonly relPath: string;
}

const DEMO_TARGETS = {
  aviation: {
    fnName: "runAviationSimulation",
    relPath: "examples/aviation-skywise/dist/simulation.js",
  },
  cdss: {
    fnName: "runClinicalSimulation",
    relPath: "examples/healthcare-cdss/dist/simulation.js",
  },
  compliance: {
    fnName: "runWastewaterSimulation",
    relPath: "examples/wastewater-compliance/dist/simulation.js",
  },
  education: {
    fnName: "runHigherEducationSimulation",
    relPath: "examples/higher-education/dist/simulation.js",
  },
  healthcare: {
    fnName: "runClinicalSimulation",
    relPath: "examples/healthcare-cdss/dist/simulation.js",
  },
  "higher-ed": {
    fnName: "runHigherEducationSimulation",
    relPath: "examples/higher-education/dist/simulation.js",
  },
  rdp: {
    fnName: "runSompoRdpSimulation",
    relPath: "examples/sompo-rdp/dist/simulation.js",
  },
  skywise: {
    fnName: "runAviationSimulation",
    relPath: "examples/aviation-skywise/dist/simulation.js",
  },
  sompo: {
    fnName: "runSompoRdpSimulation",
    relPath: "examples/sompo-rdp/dist/simulation.js",
  },
  wastewater: {
    fnName: "runWastewaterSimulation",
    relPath: "examples/wastewater-compliance/dist/simulation.js",
  },
} as const satisfies Record<string, DemoTarget>;

function getDemoTarget(domain: string): DemoTarget | undefined {
  const normalized = domain.toLowerCase();
  if (Object.hasOwn(DEMO_TARGETS, normalized)) {
    // SAFETY: domain key existence checked via Object.hasOwn on DEMO_TARGETS
    return DEMO_TARGETS[normalized as keyof typeof DEMO_TARGETS];
  }
  return undefined;
}

const executeDemoTarget = Effect.fn("executeDemoTarget")(function* (
  root: string,
  target: DemoTarget
) {
  const modPath = joinPath(root, target.relPath);
  // SAFETY: target simulation file exports a named simulation function
  const mod = (yield* Effect.promise(() => import(modPath))) as Record<
    string,
    () => Promise<void>
  >;
  const runner = mod[target.fnName];
  // SAFETY: runner function is known simulation entry point
  yield* Effect.promise(() => runner());
  return 0;
});

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

  const target = getDemoTarget(domain);
  if (!target) {
    console.error(`Error: Unknown demo domain '${domain}'`);
    console.error(
      "  Available domains: healthcare, aviation, wastewater, sompo, education"
    );
    return Effect.succeed(1);
  }

  const root = resolvePath(import.meta.dirname, "../../..");

  return Effect.gen(function* () {
    const exit = yield* Effect.exit(executeDemoTarget(root, target));

    if (Exit.isFailure(exit)) {
      yield* Effect.logError(
        `Error: Failed to execute demo simulation '${domain}': ${String(exit.cause)}`
      );
      return 1;
    }

    return exit.value;
  }).pipe(Effect.annotateLogs({ command: "demo", domain }));
}
