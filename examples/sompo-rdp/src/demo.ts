import { runSompoRdpSimulation } from "./simulation.js";

async function main(): Promise<void> {
  try {
    await runSompoRdpSimulation();
    process.exit(0);
  } catch (error) {
    console.error("Simulation failed:", error);
    process.exit(1);
  }
}

await main();
