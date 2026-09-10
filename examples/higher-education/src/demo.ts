import { runHigherEducationSimulation } from "./simulation.js";

async function main(): Promise<void> {
  try {
    await runHigherEducationSimulation();
    process.exit(0);
  } catch (error) {
    console.error("Simulation failed:", error);
    process.exit(1);
  }
}

await main();
