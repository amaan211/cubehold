import type { McVersionOption } from "@cubehold/shared";
import { fetchJson } from "../http.js";
import type { ResolvedDownload } from "./types.js";

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

interface Manifest {
  latest: { release: string; snapshot: string };
  versions: Array<{
    id: string;
    type: "release" | "snapshot" | "old_beta" | "old_alpha";
    url: string;
    time: string;
    releaseTime: string;
    sha1: string;
  }>;
}

interface VersionJson {
  id: string;
  javaVersion?: { component: string; majorVersion: number };
  downloads: {
    server?: { sha1: string; size: number; url: string };
    client?: { sha1: string; size: number; url: string };
  };
}

let manifestCache: { at: number; data: Manifest } | null = null;

export async function getManifest(): Promise<Manifest> {
  if (manifestCache && Date.now() - manifestCache.at < 10 * 60_000) return manifestCache.data;
  const data = await fetchJson<Manifest>(MANIFEST_URL);
  manifestCache = { at: Date.now(), data };
  return data;
}

export async function listVanillaVersions(): Promise<McVersionOption[]> {
  const m = await getManifest();
  return m.versions
    .filter((v) => v.type === "release" || v.type === "snapshot")
    .map((v) => ({
      id: v.id,
      kind: v.type === "release" ? "release" : "snapshot",
      releasedAt: v.releaseTime,
    }));
}

/** Fetch the per-version JSON, which is the source of truth for the Java requirement. */
export async function getVersionJson(mcVersion: string): Promise<VersionJson> {
  const m = await getManifest();
  const entry = m.versions.find((v) => v.id === mcVersion);
  if (!entry) throw new Error(`Unknown Minecraft version: ${mcVersion}`);
  return fetchJson<VersionJson>(entry.url);
}

/**
 * The game client for a version. Only its textures, models and English names
 * are used, to draw inventories the way the game does.
 */
export async function clientJarFor(
  mcVersion: string,
): Promise<{ url: string; sha1: string; sizeBytes: number }> {
  const json = await getVersionJson(mcVersion);
  const client = json.downloads.client;
  if (!client) throw new Error(`Minecraft ${mcVersion} has no client download`);
  return { url: client.url, sha1: client.sha1, sizeBytes: client.size };
}

export async function resolveVanilla(mcVersion: string): Promise<ResolvedDownload> {
  const json = await getVersionJson(mcVersion);
  const server = json.downloads.server;
  if (!server) throw new Error(`Minecraft ${mcVersion} has no server download`);
  return {
    software: "vanilla",
    mcVersion,
    fileName: "server.jar",
    url: server.url,
    sha1: server.sha1,
    sizeBytes: server.size,
    javaMajor: json.javaVersion?.majorVersion ?? null,
    build: null,
  };
}
