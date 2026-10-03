import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Replaced by the release build (packaging/build.ts); undefined when running from source.
declare const __CUBEHOLD_DIST__: boolean | undefined;
declare const __CUBEHOLD_VERSION__: string | undefined;

/**
 * True in a release build: the panel is one bundled file (server.mjs) next to
 * the agent bundle (agent.mjs), the web app (web/) and the migrations
 * (drizzle/). False under `pnpm dev` and in tests, which run the sources.
 */
export const isDist = typeof __CUBEHOLD_DIST__ !== "undefined" && __CUBEHOLD_DIST__ === true;

/** The folder holding server.mjs in a release build. */
export const distDir: string | null = isDist ? path.dirname(fileURLToPath(import.meta.url)) : null;

export const VERSION: string =
  typeof __CUBEHOLD_VERSION__ === "string" ? __CUBEHOLD_VERSION__ : "dev";

/** A file shipped next to server.mjs, or null when running from source. */
export function distFile(...parts: string[]): string | null {
  return distDir ? path.join(distDir, ...parts) : null;
}

/**
 * Where an installed panel keeps its data when DATA_DIR is not set: the
 * per-user application data folder of the OS. From source it stays in
 * ./data so development never touches an installed copy.
 */
export function defaultDataDir(): string {
  if (!isDist) return path.resolve(process.cwd(), "data");
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "cubehold");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "cubehold");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "cubehold");
}

/** The built web app: next to server.mjs in a release, or CUBEHOLD_WEB_DIR. */
export function webDir(override?: string): string | null {
  const dir = override ?? distFile("web");
  return dir && fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}
