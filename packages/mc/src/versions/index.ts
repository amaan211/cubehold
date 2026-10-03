import type { McVersionOption, ServerSoftware } from "@cubehold/shared";
import { listFabricVersions, resolveFabric } from "./fabric.js";
import { listForgeVersions, listNeoForgeVersions, resolveForge, resolveNeoForge } from "./forge.js";
import { listPaperVersions, resolvePaper } from "./paper.js";
import { listPurpurVersions, resolvePurpur } from "./purpur.js";
import type { ResolvedDownload } from "./types.js";
import { listVanillaVersions, resolveVanilla } from "./vanilla.js";

export type { ResolvedDownload } from "./types.js";
export { clientJarFor, getManifest } from "./vanilla.js";

export const SUPPORTED_SOFTWARE: ServerSoftware[] = [
  "paper",
  "purpur",
  "vanilla",
  "fabric",
  "neoforge",
  "forge",
];
export { neoForgeMinecraftVersion } from "./forge.js";

const listCache = new Map<ServerSoftware, { at: number; data: McVersionOption[] }>();
const LIST_TTL_MS = 10 * 60_000;

/** Every version of a software, newest first (releases and pre-releases). Cached for 10 minutes. */
export async function listVersions(software: ServerSoftware): Promise<McVersionOption[]> {
  const hit = listCache.get(software);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.data;
  const data = await fetchVersionList(software);
  listCache.set(software, { at: Date.now(), data });
  return data;
}

async function fetchVersionList(software: ServerSoftware): Promise<McVersionOption[]> {
  switch (software) {
    case "vanilla":
      return listVanillaVersions();
    case "paper":
      return listPaperVersions("paper");
    case "purpur":
      return listPurpurVersions();
    case "fabric":
      return listFabricVersions();
    case "neoforge":
      return listNeoForgeVersions();
    case "forge":
      return listForgeVersions();
    default:
      throw new Error(`${software} is not supported yet`);
  }
}

/**
 * Order two versions of the same software: negative when `a` is older than
 * `b`, positive when newer, 0 when equal. Uses the vendor's own newest-first
 * list so year-based versions (26.x) and pre-releases sort correctly; falls
 * back to a numeric comparison for versions the list does not contain.
 */
export function compareVersionsIn(list: McVersionOption[], a: string, b: string): number {
  if (a === b) return 0;
  const ia = list.findIndex((v) => v.id === a);
  const ib = list.findIndex((v) => v.id === b);
  if (ia >= 0 && ib >= 0) return ib - ia; // lower index = newer
  return compareNumeric(a, b);
}

export async function compareVersions(
  software: ServerSoftware,
  a: string,
  b: string,
): Promise<number> {
  return compareVersionsIn(await listVersions(software), a, b);
}

function compareNumeric(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    if (x !== y) return x - y;
  }
  return 0;
}

/** The download for a version; loaderVersion pins Fabric, Forge or NeoForge (modpacks do). */
export async function resolveDownload(
  software: ServerSoftware,
  mcVersion: string,
  loaderVersion?: string,
): Promise<ResolvedDownload> {
  switch (software) {
    case "vanilla":
      return resolveVanilla(mcVersion);
    case "paper":
      return resolvePaper(mcVersion, "paper");
    case "purpur":
      return resolvePurpur(mcVersion);
    case "fabric":
      return resolveFabric(mcVersion, loaderVersion);
    case "neoforge":
      return resolveNeoForge(mcVersion, loaderVersion);
    case "forge":
      return resolveForge(mcVersion, loaderVersion);
    default:
      throw new Error(`${software} is not supported yet`);
  }
}
