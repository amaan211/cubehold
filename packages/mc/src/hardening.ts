import type { ServerSoftware } from "@cubehold/shared";
import type { AddonVersion } from "./addons.js";
import { fetchJson } from "./http.js";

// --- Log4Shell (CVE-2021-44228) ------------------------------------------------------

/**
 * Mojang's official mitigation for servers that still ship the vulnerable
 * log4j: https://www.minecraft.net/en-us/article/important-message--security-vulnerability-java-edition
 *  - 1.7 to 1.11.2 and 1.12 to 1.16.5: a log4j config that disables lookups
 *  - 1.17 and 1.18: -Dlog4j2.formatMsgNoLookups=true (always passed at launch)
 * Paper and Purpur builds from after December 2021 carry a fixed log4j.
 */
export interface Log4jMitigation {
  status: "not-affected" | "fixed-build" | "flag" | "config-file";
  /** Mojang's config, when this version needs one. */
  file: { name: string; url: string; sha1: string } | null;
  args: string[];
}

const LOG4J_OLD = {
  name: "log4j2_17-111.xml",
  url: "https://launcher.mojang.com/v1/objects/4bb89a97a66f350bc9f73b3ca8509632682aea2e/log4j2_17-111.xml",
  sha1: "4bb89a97a66f350bc9f73b3ca8509632682aea2e",
};
const LOG4J_MID = {
  name: "log4j2_112-116.xml",
  url: "https://launcher.mojang.com/v1/objects/02937d122c86ce73319ef9975b58896fc1b491d1/log4j2_112-116.xml",
  sha1: "02937d122c86ce73319ef9975b58896fc1b491d1",
};

export function log4jMitigation(software: ServerSoftware, mcVersion: string): Log4jMitigation {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcVersion);
  const minor = m ? Number(m[1]) : null;
  const patch = m ? Number(m[2] ?? 0) : 0;
  const affected = minor !== null && minor >= 7 && (minor < 18 || (minor === 18 && patch === 0));
  if (!affected || minor === null) {
    return { status: "not-affected", file: null, args: [] };
  }
  if (software === "paper" || software === "purpur") {
    return { status: "fixed-build", file: null, args: [] };
  }
  if (minor >= 17) return { status: "flag", file: null, args: [] };
  const file = minor <= 11 ? LOG4J_OLD : LOG4J_MID;
  return { status: "config-file", file, args: [`-Dlog4j.configurationFile=${file.name}`] };
}

// --- Bedrock crossplay (Geyser + Floodgate) --------------------------------------------

const GEYSER_API = "https://download.geysermc.org/v2/projects";
export const BEDROCK_BASE_PORT = 19132;

export type BedrockSupport =
  | { supported: true; via: "geysermc" | "modrinth"; needsViaVersion: boolean }
  | { supported: false; reason: string };

/**
 * Whether Geyser can run on this server. Plugin servers need 1.20.5 or
 * newer on Java 21 (older ones need a proxy, which the panel does not set
 * up); servers behind the newest release also need ViaVersion, since Geyser
 * speaks the newest protocol. Fabric builds exist only for the newest
 * versions; Modrinth says which.
 * https://geysermc.org/wiki/geyser/supported-versions/
 */
export function bedrockSupport(
  software: ServerSoftware,
  mcVersion: string,
  javaMajor: number,
  latestRelease: string | null,
  compare: (a: string, b: string) => number,
): BedrockSupport {
  if (software === "vanilla") {
    return {
      supported: false,
      reason: "Vanilla servers cannot load Geyser. Paper, Purpur and Fabric can.",
    };
  }
  if (software === "fabric") return { supported: true, via: "modrinth", needsViaVersion: false };
  if (software !== "paper" && software !== "purpur") {
    return { supported: false, reason: `Geyser is not set up for ${software} servers here.` };
  }
  if (compare(mcVersion, "1.20.5") < 0) {
    return {
      supported: false,
      reason: `Geyser needs Minecraft 1.20.5 or newer on Paper and Purpur; this server runs ${mcVersion}.`,
    };
  }
  if (javaMajor > 0 && javaMajor < 21) {
    return {
      supported: false,
      reason: `Geyser needs Java 21; this server uses Java ${javaMajor}.`,
    };
  }
  const behind = latestRelease !== null && compare(mcVersion, latestRelease) < 0;
  return { supported: true, via: "geysermc", needsViaVersion: behind };
}

interface GeyserBuild {
  version: string;
  build: number;
  time: string;
  downloads: Record<string, { name: string; sha256: string }>;
}

/** Newest Geyser or Floodgate build for Spigot-family servers, from GeyserMC's own site. */
export async function resolveGeyserMc(project: "geyser" | "floodgate"): Promise<AddonVersion> {
  const b = await fetchJson<GeyserBuild>(`${GEYSER_API}/${project}/versions/latest/builds/latest`);
  const d = b.downloads.spigot;
  if (!d) throw new Error(`GeyserMC has no Spigot build of ${project}`);
  return {
    source: "geysermc",
    projectId: project,
    versionId: String(b.build),
    versionName: `${b.version} build ${b.build}`,
    fileName: d.name,
    url: `${GEYSER_API}/${project}/versions/${b.version}/builds/${b.build}/downloads/spigot`,
    sizeBytes: null,
    sha256: d.sha256,
    channel: "release",
    publishedAt: b.time,
    dependencies: [],
  };
}

/** JVM flags for Geyser: its Bedrock (UDP) port, so servers on one machine do not collide. */
export function geyserArgs(bedrockPort: number | null): string[] {
  return bedrockPort ? [`-DgeyserUdpPort=${bedrockPort}`] : [];
}
