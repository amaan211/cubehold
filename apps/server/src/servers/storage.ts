import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** True when `child` is `parent` or inside it. Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export class DestinationError extends Error {}

/**
 * Check a user-chosen export folder. It must be an absolute path outside the
 * panel's data folder (which is about to be deleted), and either not exist
 * yet or be empty, so an export never mixes with other files.
 */
export function validateExportDestination(input: string, dataDir: string): string {
  let dest = input.trim();
  if (dest === "~" || dest.startsWith("~/") || dest.startsWith("~\\")) {
    dest = path.join(os.homedir(), dest.slice(1));
  }
  if (!path.isAbsolute(dest)) {
    throw new DestinationError("Use a full path, for example C:\\Users\\you\\Backups\\my-server");
  }
  const resolved = path.resolve(dest);
  if (isInside(dataDir, resolved)) {
    throw new DestinationError(
      "Choose a folder outside the panel's data folder; that folder is deleted with the server",
    );
  }
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(resolved);
  } catch {
    st = null;
  }
  if (st) {
    if (!st.isDirectory()) throw new DestinationError("That path is a file, not a folder");
    if (fs.readdirSync(resolved).length > 0) {
      throw new DestinationError("That folder already has files in it; choose a new or empty one");
    }
  }
  return resolved;
}

export function defaultExportDestination(serverName: string, now = new Date()): string {
  return path.join(os.homedir(), "cubehold Backups", exportName(serverName, now));
}

/** "My server 2026-09-29 14-05": a folder name for an export. */
export function exportName(serverName: string, now = new Date()): string {
  const safe = serverName.replace(/[^\w .-]+/g, "_").trim() || "server";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `${safe} ${stamp}`;
}

/** Size of a directory tree on this machine. */
export async function dirSize(p: string): Promise<number> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await fs.promises.readdir(p)) total += await dirSize(path.join(p, name));
  return total;
}
