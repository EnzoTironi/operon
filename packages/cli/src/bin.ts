#!/usr/bin/env node
import { runCli } from "./index.js";

try {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
} catch (error: unknown) {
  console.error("Fatal CLI Error:", error);
  process.exit(1);
}
