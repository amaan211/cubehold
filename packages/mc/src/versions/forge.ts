/**
 * Forge and NeoForge, the loaders most modpacks use. Both publish an
 * installer jar; run with --installServer it writes the libraries plus either
 * a launch arguments file (Minecraft 1.17 and newer) or a forge-*.jar to run
 * (older versions). The agent runs the installer; see install.ts.
 */
import type { McVersionOption } from "@cubehold/shared";
import { fetchJson, fetchText } from "../http.js";
import type { ResolvedDownload } from "./types.js";
import { getVersionJson } from "./vanilla.js";

const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FORGE_PROMOS =
  "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

/** Oldest Forge whose installer sets up a server the same way as today's. */
const FORGE_OLDEST = "1.12.2";

/**
 * The Minecraft version a NeoForge version is for. 20.4.237 and 21.1.172 are
 * for 1.20.4 and 1.21.1 (a 0 in the middle means no patch: 21.0.x is 1.21);
 * from 2026 NeoForge uses Minecraft's own numbers, 26.1.2.112 is for 26.1.2.
 */
export function neoForgeMinecraftVersion(version: string): string | null {
  const parts = version.split("-")[0]?.split(".").map(Number) ?? [];
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c] = parts;
  if (a === undefined || b === undefined) return null;
  if (a >= 25) {
    if (parts.length < 4 || c === undefined) return null;
    return c === 0 ? `${a}.${b}` : `${a}.${b}.${c}`;
  }
  if (a < 20 || (a === 20 && b < 2)) return null; // 1.20.1 NeoForge was a Forge fork under another name
  return b === 0 ? `1.${a}` : `1.${a}.${b}`;
}

async function neoForgeVersions(): Promise<string[]> {
  const xml = await fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1] as string);
}

export async function listNeoForgeVersions(): Promise<McVersionOption[]> {
  const byMc = new Map<string, boolean>();
  for (const v of await neoForgeVersions()) {
    const mc = neoForgeMinecraftVersion(v);
    if (!mc) continue;
    // A Minecraft version counts as released for NeoForge once one build is not a beta.
    byMc.set(mc, (byMc.get(mc) ?? false) || !v.includes("-"));
  }
  return [...byMc.entries()]
    .map(
      ([id, stable]) => ({ id, kind: stable ? "release" : "snapshot", releasedAt: null }) as const,
    )
    .sort((x, y) => compareDotted(y.id, x.id));
}

export async function resolveNeoForge(
  mcVersion: string,
  loaderVersion?: string,
): Promise<ResolvedDownload> {
  const all = (await neoForgeVersions()).filter((v) => neoForgeMinecraftVersion(v) === mcVersion);
  const version = loaderVersion ?? [...all].reverse().find((v) => !v.includes("-")) ?? all.at(-1);
  if (!version || (loaderVersion && !all.includes(loaderVersion))) {
    throw new Error(
      loaderVersion
        ? `NeoForge ${loaderVersion} is not available for Minecraft ${mcVersion}`
        : `NeoForge is not available for Minecraft ${mcVersion}`,
    );
  }
  const url = `${NEOFORGE_MAVEN}/${version}/neoforge-${version}-installer.jar`;
  return {
    software: "neoforge",
    mcVersion,
    fileName: "installer.jar",
    url,
    sha256: (await fetchText(`${url}.sha256`)).trim().split(/\s+/)[0],
    sizeBytes: null,
    javaMajor: await javaFor(mcVersion),
    build: version,
    installer: { argsDir: `libraries/net/neoforged/neoforge/${version}` },
  };
}

interface Promos {
  promos: Record<string, string>;
}

export async function listForgeVersions(): Promise<McVersionOption[]> {
  const { promos } = await fetchJson<Promos>(FORGE_PROMOS);
  const mcs = new Set(Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, "")));
  return [...mcs]
    .filter((mc) => compareDotted(mc, FORGE_OLDEST) >= 0)
    .sort((x, y) => compareDotted(y, x))
    .map((id) => ({ id, kind: "release", releasedAt: null }) as const);
}

export async function resolveForge(
  mcVersion: string,
  loaderVersion?: string,
): Promise<ResolvedDownload> {
  const { promos } = await fetchJson<Promos>(FORGE_PROMOS);
  const version =
    loaderVersion ?? promos[`${mcVersion}-recommended`] ?? promos[`${mcVersion}-latest`];
  if (!version) throw new Error(`Forge is not available for Minecraft ${mcVersion}`);
  const full = `${mcVersion}-${version}`;
  const url = `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`;
  return {
    software: "forge",
    mcVersion,
    fileName: "installer.jar",
    url,
    sha1: (await fetchText(`${url}.sha1`)).trim().split(/\s+/)[0],
    sizeBytes: null,
    javaMajor: await javaFor(mcVersion),
    build: version,
    // 1.17+ launches through an args file; older versions through the forge jar the installer writes.
    installer: {
      argsDir: `libraries/net/minecraftforge/forge/${full}`,
      jarPrefix: `forge-${full}`,
    },
  };
}

async function javaFor(mcVersion: string): Promise<number | null> {
  try {
    return (await getVersionJson(mcVersion)).javaVersion?.majorVersion ?? null;
  } catch {
    return null;
  }
}

function compareDotted(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
