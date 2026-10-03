import type { AddonSource, ServerSoftware } from "@cubehold/shared";
import { fetchJson, HttpError } from "./http.js";

/**
 * Plugin and mod catalogues: Modrinth (plugins and mods) and Hangar (Paper
 * plugins). Only open APIs; CurseForge needs a per-user API key and is not
 * wired in yet.
 */

const MODRINTH = "https://api.modrinth.com/v2";
const HANGAR = "https://hangar.papermc.io/api/v1";

export interface AddonPlatform {
  kind: "plugin" | "mod";
  /** Folder inside the server directory. */
  folder: "plugins" | "mods";
  modrinthLoaders: string[];
  /** Hangar only hosts Paper-family plugins. */
  hangar: boolean;
}

export function addonPlatform(software: ServerSoftware): AddonPlatform | null {
  switch (software) {
    case "paper":
      return {
        kind: "plugin",
        folder: "plugins",
        modrinthLoaders: ["paper", "spigot", "bukkit"],
        hangar: true,
      };
    case "purpur":
      return {
        kind: "plugin",
        folder: "plugins",
        modrinthLoaders: ["purpur", "paper", "spigot", "bukkit"],
        hangar: true,
      };
    case "fabric":
      return { kind: "mod", folder: "mods", modrinthLoaders: ["fabric"], hangar: false };
    case "forge":
      return { kind: "mod", folder: "mods", modrinthLoaders: ["forge"], hangar: false };
    case "neoforge":
      return { kind: "mod", folder: "mods", modrinthLoaders: ["neoforge"], hangar: false };
    default:
      return null;
  }
}

export interface AddonHit {
  source: AddonSource;
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl: string | null;
  downloads: number;
  updatedAt: string | null;
  pageUrl: string;
}

export interface AddonSearchResult {
  hits: AddonHit[];
  total: number;
  offset: number;
  limit: number;
}

export interface AddonVersion {
  source: AddonSource;
  projectId: string;
  versionId: string;
  versionName: string;
  fileName: string;
  url: string;
  sizeBytes: number | null;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  channel: "release" | "beta" | "alpha";
  publishedAt: string | null;
  /** Required dependencies; projectId is null when the dependency lives outside the catalogue. */
  dependencies: Array<{
    projectId: string | null;
    name: string | null;
    externalUrl: string | null;
  }>;
}

export class AddonUnavailableError extends Error {}

const PAGE = 20;

// --- Modrinth ----------------------------------------------------------------

interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url: string | null;
  downloads: number;
  date_modified: string;
  project_type: string;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  date_published: string;
  loaders: string[];
  game_versions: string[];
  files: Array<{
    url: string;
    filename: string;
    primary: boolean;
    size: number;
    hashes: { sha1?: string; sha512?: string };
  }>;
  dependencies: Array<{
    project_id: string | null;
    version_id: string | null;
    file_name: string | null;
    dependency_type: "required" | "optional" | "incompatible" | "embedded";
  }>;
}

export async function searchModrinth(
  platform: AddonPlatform,
  mcVersion: string,
  query: string,
  offset = 0,
): Promise<AddonSearchResult> {
  const facets: string[][] = [
    [`project_type:${platform.kind}`],
    platform.modrinthLoaders.map((l) => `categories:${l}`),
    [`versions:${mcVersion}`],
  ];
  // Client-only mods do nothing on a server.
  if (platform.kind === "mod") facets.push(["server_side:required", "server_side:optional"]);
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(PAGE),
    offset: String(offset),
    index: query ? "relevance" : "downloads",
  });
  const res = await fetchJson<{ hits: ModrinthHit[]; total_hits: number }>(
    `${MODRINTH}/search?${params}`,
  );
  return {
    hits: res.hits.map((h) => ({
      source: "modrinth",
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      iconUrl: h.icon_url || null,
      downloads: h.downloads,
      updatedAt: h.date_modified,
      pageUrl: `https://modrinth.com/${platform.kind}/${h.slug}`,
    })),
    total: res.total_hits,
    offset,
    limit: PAGE,
  };
}

const CHANNEL_RANK = { release: 0, beta: 1, alpha: 2 } as const;

function fromModrinthVersion(v: ModrinthVersion): AddonVersion {
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  if (!file) throw new AddonUnavailableError(`Version ${v.version_number} has no files`);
  return {
    source: "modrinth",
    projectId: v.project_id,
    versionId: v.id,
    versionName: v.version_number,
    fileName: file.filename,
    url: file.url,
    sizeBytes: file.size,
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    channel: v.version_type,
    publishedAt: v.date_published,
    dependencies: v.dependencies
      .filter((d) => d.dependency_type === "required" && d.project_id)
      .map((d) => ({ projectId: d.project_id, name: d.file_name, externalUrl: null })),
  };
}

/** Newest compatible version, preferring releases over betas over alphas. */
export async function resolveModrinthVersion(
  projectId: string,
  platform: AddonPlatform,
  mcVersion: string,
): Promise<AddonVersion> {
  const params = new URLSearchParams({
    loaders: JSON.stringify(platform.modrinthLoaders),
    game_versions: JSON.stringify([mcVersion]),
  });
  let versions: ModrinthVersion[];
  try {
    versions = await fetchJson<ModrinthVersion[]>(
      `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?${params}`,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404)
      throw new AddonUnavailableError("Project not found on Modrinth");
    throw err;
  }
  const best = [...versions].sort(
    (a, b) =>
      CHANNEL_RANK[a.version_type] - CHANNEL_RANK[b.version_type] ||
      b.date_published.localeCompare(a.date_published),
  )[0];
  if (!best) {
    throw new AddonUnavailableError(
      `No version for Minecraft ${mcVersion} on ${platform.modrinthLoaders[0]}`,
    );
  }
  return fromModrinthVersion(best);
}

export interface ModrinthProjectInfo {
  id: string;
  slug: string;
  title: string;
  iconUrl: string | null;
  projectType: string;
}

export async function modrinthProjects(ids: string[]): Promise<Map<string, ModrinthProjectInfo>> {
  const out = new Map<string, ModrinthProjectInfo>();
  if (ids.length === 0) return out;
  const res = await fetchJson<
    Array<{
      id: string;
      slug: string;
      title: string;
      icon_url: string | null;
      project_type: string;
    }>
  >(`${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  for (const p of res) {
    out.set(p.id, {
      id: p.id,
      slug: p.slug,
      title: p.title,
      iconUrl: p.icon_url || null,
      projectType: p.project_type,
    });
  }
  return out;
}

/** Which Modrinth versions these files are, by SHA-1. Files Modrinth does not know are absent. */
export async function identifyModrinthFiles(
  sha1s: string[],
): Promise<Map<string, { projectId: string; versionId: string; versionName: string }>> {
  const out = new Map<string, { projectId: string; versionId: string; versionName: string }>();
  if (sha1s.length === 0) return out;
  const res = await fetchJson<Record<string, ModrinthVersion>>(
    `${MODRINTH}/version_files`,
    20_000,
    {
      method: "POST",
      body: { hashes: sha1s, algorithm: "sha1" },
    },
  );
  for (const [hash, v] of Object.entries(res)) {
    out.set(hash, { projectId: v.project_id, versionId: v.id, versionName: v.version_number });
  }
  return out;
}

/** Newest compatible version for each file, by SHA-1. */
export async function modrinthUpdates(
  sha1s: string[],
  platform: AddonPlatform,
  mcVersion: string,
): Promise<Map<string, AddonVersion>> {
  const out = new Map<string, AddonVersion>();
  if (sha1s.length === 0) return out;
  const res = await fetchJson<Record<string, ModrinthVersion>>(
    `${MODRINTH}/version_files/update`,
    20_000,
    {
      method: "POST",
      body: {
        hashes: sha1s,
        algorithm: "sha1",
        loaders: platform.modrinthLoaders,
        game_versions: [mcVersion],
      },
    },
  );
  for (const [hash, v] of Object.entries(res)) {
    try {
      out.set(hash, fromModrinthVersion(v));
    } catch {
      // version without files; nothing to offer
    }
  }
  return out;
}

// --- Hangar ------------------------------------------------------------------

interface HangarProject {
  id: number;
  name: string;
  namespace: { owner: string; slug: string };
  stats: { downloads: number };
  description: string;
  lastUpdated: string;
  avatarUrl: string | null;
}

interface HangarVersion {
  name: string;
  createdAt: string;
  channel: { name: string };
  downloads: Record<
    string,
    {
      fileInfo: { name: string; sizeBytes: number; sha256Hash: string } | null;
      externalUrl: string | null;
      downloadUrl: string | null;
    }
  >;
  pluginDependencies?: Record<
    string,
    Array<{ name: string; projectId: number | null; required: boolean; externalUrl: string | null }>
  >;
}

export async function searchHangar(
  mcVersion: string,
  query: string,
  offset = 0,
): Promise<AddonSearchResult> {
  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
    platform: "PAPER",
    version: mcVersion,
  });
  if (query) params.set("query", query);
  else params.set("sort", "-downloads");
  const res = await fetchJson<{ pagination: { count: number }; result: HangarProject[] }>(
    `${HANGAR}/projects?${params}`,
  );
  return {
    hits: res.result.map((p) => ({
      source: "hangar",
      projectId: p.namespace.slug,
      slug: p.namespace.slug,
      title: p.name,
      description: p.description,
      author: p.namespace.owner,
      iconUrl: p.avatarUrl,
      downloads: p.stats.downloads,
      updatedAt: p.lastUpdated,
      pageUrl: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
    })),
    total: res.pagination.count,
    offset,
    limit: PAGE,
  };
}

export async function resolveHangarVersion(slug: string, mcVersion: string): Promise<AddonVersion> {
  const params = new URLSearchParams({
    limit: "25",
    offset: "0",
    platform: "PAPER",
    platformVersion: mcVersion,
  });
  let res: { result: HangarVersion[] };
  try {
    res = await fetchJson(`${HANGAR}/projects/${encodeURIComponent(slug)}/versions?${params}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404)
      throw new AddonUnavailableError("Project not found on Hangar");
    throw err;
  }
  const rank = (v: HangarVersion) => (/^release$/i.test(v.channel.name) ? 0 : 1);
  const sorted = [...res.result].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  );
  const best = sorted[0];
  if (!best) throw new AddonUnavailableError(`No version for Minecraft ${mcVersion}`);
  const dl = best.downloads.PAPER;
  if (!dl?.downloadUrl || !dl.fileInfo) {
    throw new AddonUnavailableError(
      dl?.externalUrl
        ? `${slug} is only distributed from ${dl.externalUrl}; download it there and upload it in the Files tab.`
        : `${slug} ${best.name} has no Paper download`,
    );
  }
  return {
    source: "hangar",
    projectId: slug,
    versionId: best.name,
    versionName: best.name,
    fileName: dl.fileInfo.name,
    url: dl.downloadUrl,
    sizeBytes: dl.fileInfo.sizeBytes,
    sha256: dl.fileInfo.sha256Hash,
    channel: rank(best) === 0 ? "release" : "beta",
    publishedAt: best.createdAt,
    dependencies: (best.pluginDependencies?.PAPER ?? [])
      .filter((d) => d.required)
      .map((d) => ({ projectId: null, name: d.name, externalUrl: d.externalUrl })),
  };
}
