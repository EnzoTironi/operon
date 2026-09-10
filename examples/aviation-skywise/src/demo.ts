import { runAviationSimulation } from "./simulation.js";

try {
  await runAviationSimulation();
} catch (error) {
  console.error(error);
}
