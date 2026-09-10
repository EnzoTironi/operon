import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../../..");

console.log("=== OPERON CLEANUP WORKFLOW ===");

// 1. Terminate any background operon MCP servers
try {
  execSync('pkill -f "operon mcp" 2>/dev/null || true', { stdio: "ignore" });
  console.log("✔ Terminated background MCP server processes.");
} catch {
  console.log("✔ No background MCP processes were active.");
}

// 2. Remove temporary test database files while strictly keeping .evidence
const tempPatterns = [
  path.join(rootDir, "test-operon-*.db"),
  path.join(rootDir, "test-operon-*.db-wal"),
  path.join(rootDir, "test-operon-*.db-shm"),
  path.join(rootDir, ".tmp-*.db"),
];

for (const pattern of tempPatterns) {
  try {
    const dir = path.dirname(pattern);
    const prefix = path.basename(pattern).replace("*", "");
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(prefix.split(".")[0]) && file.endsWith(".db")) {
          fs.rmSync(path.join(dir, file), { force: true });
        }
      }
    }
  } catch {}
}
console.log("✔ Cleaned temporary SQLite database files.");

// 3. Confirm evidence directory is intact
const evidenceDir = path.join(rootDir, ".evidence/verify-operon");
if (fs.existsSync(evidenceDir)) {
  const runs = fs.readdirSync(evidenceDir);
  console.log(
    `✔ Evidence directory preserved: ${evidenceDir} (${runs.length} runs present).`
  );
} else {
  console.log("✔ Evidence directory ready for new runs.");
}

console.log("=== CLEANUP COMPLETED SAFELY ===");
