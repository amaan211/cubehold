import type { BackupCategory } from "@cubehold/shared";

/**
 * Knowledge about what lives in a server directory, used for exports before
 * deletion and for swapping binaries on a version change.
 */

/** Re-downloadable binaries and caches. Never exported; replaced on version change. */
const DOWNLOADED_DIRS = new Set([
  "cache",
  "libraries",
  "versions",
  "bundler",
  ".fabric",
  ".paper", // Paper's remapped-plugin cache (Paper 26+)
  ".paper-remapped",
]);

const ADDON_DIRS = new Set(["plugins", "mods", "config", "defaultconfigs", "kubejs", "scripts"]);
const LOG_DIRS = new Set(["logs", "crash-reports", "debug"]);
const CONFIG_FILE = /\.(properties|json|ya?ml|toml|txt|png)$/i;

export type FileCategory = BackupCategory | "downloaded";

/** World folders for a level name, in the layouts vanilla/Fabric and Paper use. */
export function worldFolderNames(levelName: string): string[] {
  return [levelName, `${levelName}_nether`, `${levelName}_the_end`];
}

/**
 * Put one top-level entry of a server directory into a category.
 * `kind` distinguishes a folder named like a file pattern from a real file.
 */
export function classifyEntry(
  name: string,
  kind: "file" | "dir",
  levelName = "world",
): FileCategory {
  const lower = name.toLowerCase();
  if (worldFolderNames(levelName.toLowerCase()).includes(lower) && kind === "dir") return "world";
  if (kind === "dir") {
    if (DOWNLOADED_DIRS.has(lower) || lower.startsWith(".cubehold")) return "downloaded";
    if (ADDON_DIRS.has(lower)) return "addons";
    if (LOG_DIRS.has(lower)) return "logs";
    return "other";
  }
  if (lower.endsWith(".jar") || lower.endsWith(".part")) return "downloaded";
  if (CONFIG_FILE.test(lower)) return "config";
  return "other";
}

/**
 * Entries to delete when switching a server to another Minecraft version:
 * the server jar plus everything the old jar unpacked or downloaded.
 * Worlds, plugins, mods and configs are left alone.
 */
export function versionArtifacts(jarFile: string | undefined): string[] {
  return [...(jarFile ? [jarFile] : []), ...DOWNLOADED_DIRS];
}
