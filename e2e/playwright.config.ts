/**
 * End-to-end tests of a release build of cubehold.
 *
 *   pnpm dist && pnpm e2e
 *       starts build/app/server.mjs on port 4210 with a fresh data folder,
 *       and stops its agent and deletes the folder afterwards.
 *   CUBEHOLD_E2E_URL=http://192.168.1.20:4000 pnpm e2e
 *       tests a panel that is already running (the Docker image, an install).
 *
 * Options: CUBEHOLD_E2E_DATA=<folder> reuses a data folder (downloaded Java stays
 * between runs), CUBEHOLD_E2E_MC_PORT=<port> sets the test server's port (25590).
 * The owner account is owner / correct-horse-battery.
 */
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const repo = path.resolve(import.meta.dirname, "..");
const external = process.env.CUBEHOLD_E2E_URL;
const port = Number(process.env.CUBEHOLD_E2E_PORT ?? 4210);

// Set once in the runner; workers inherit it, so every process uses the same folder.
if (!external && !process.env.CUBEHOLD_E2E_DATA) {
  process.env.CUBEHOLD_E2E_DATA = path.join(os.tmpdir(), `cubehold-e2e-${Date.now()}`);
  process.env.CUBEHOLD_E2E_TEMP_DATA = "1";
}

export default defineConfig({
  testDir: "tests",
  // Installing a server downloads Java and the server jar.
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalTeardown: "./teardown.ts",
  use: {
    baseURL: external ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: external
    ? undefined
    : {
        command: `node "${path.join(repo, "build/app/server.mjs")}"`,
        url: `http://127.0.0.1:${port}/health`,
        env: {
          DATA_DIR: process.env.CUBEHOLD_E2E_DATA as string,
          PORT: String(port),
          HOST: "127.0.0.1",
        },
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
