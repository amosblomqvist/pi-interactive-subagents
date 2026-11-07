import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import before the extension: its config snapshot is captured at module load.
const root = mkdtempSync(join(tmpdir(), "pi-unit-home-"));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith("PI_SUBAGENT_") || key.toUpperCase() === "PI_SUBAGENTS_CONFIG") delete process.env[key];
}
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
