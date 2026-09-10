import path from "node:path";

export async function runDemo(args: string[]): Promise<number> {
  const domain = args[0];
  if (!domain) {
    console.error("Error: Missing demo domain name.");
    console.error(
      "  Usage: operon demo <healthcare|aviation|wastewater|sompo|education>"
    );
    console.error("  Example: operon demo healthcare");
    return 1;
  }

  const root = path.resolve(import.meta.dirname, "../../..");

  try {
    switch (domain.toLowerCase()) {
      case "healthcare":
      case "cdss": {
        const modPath = path.join(
          root,
          "examples/healthcare-cdss/dist/simulation.js"
        );
        const mod = (await import(modPath)) as {
          runClinicalSimulation: () => Promise<void>;
        };
        await mod.runClinicalSimulation();
        return 0;
      }
      case "aviation":
      case "skywise": {
        const modPath = path.join(
          root,
          "examples/aviation-skywise/dist/simulation.js"
        );
        const mod = (await import(modPath)) as {
          runAviationSimulation: () => Promise<void>;
        };
        await mod.runAviationSimulation();
        return 0;
      }
      case "wastewater":
      case "compliance": {
        const modPath = path.join(
          root,
          "examples/wastewater-compliance/dist/simulation.js"
        );
        const mod = (await import(modPath)) as {
          runWastewaterSimulation: () => Promise<void>;
        };
        await mod.runWastewaterSimulation();
        return 0;
      }
      case "sompo":
      case "rdp": {
        const modPath = path.join(
          root,
          "examples/sompo-rdp/dist/simulation.js"
        );
        const mod = (await import(modPath)) as {
          runSompoRdpSimulation: () => Promise<void>;
        };
        await mod.runSompoRdpSimulation();
        return 0;
      }
      case "education":
      case "higher-ed": {
        const modPath = path.join(
          root,
          "examples/higher-education/dist/simulation.js"
        );
        const mod = (await import(modPath)) as {
          runHigherEducationSimulation: () => Promise<void>;
        };
        await mod.runHigherEducationSimulation();
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
  } catch (error: unknown) {
    console.error(
      `Error: Failed to execute demo simulation '${domain}': ${String((error as any)?.message ?? error)}`
    );
    return 1;
  }
}
