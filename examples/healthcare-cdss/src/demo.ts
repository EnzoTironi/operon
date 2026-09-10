import { runClinicalSimulation } from "./simulation.js";

try {
  await runClinicalSimulation();
} catch (error: unknown) {
  console.error("Simulation failed:", error);
  process.exit(1);
}
