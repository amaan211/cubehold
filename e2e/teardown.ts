import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The panel under test starts an agent daemon that outlives it by design;
 * stop it (and its servers), then remove a data folder the run created.
 */
export default async function teardown(): Promise<void> {
  const dataDir = process.env.CUBEHOLD_E2E_DATA;
  if (process.env.CUBEHOLD_E2E_URL || !dataDir) return;
  const server = path.resolve(import.meta.dirname, "../build/app/server.mjs");
  spawnSync(process.execPath, [server, "agent", "stop"], {
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: "inherit",
  });
  const stateFile = path.join(dataDir, "agent.json");
  for (let i = 0; i < 120 && fs.existsSync(stateFile); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (process.env.CUBEHOLD_E2E_TEMP_DATA === "1") {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}
