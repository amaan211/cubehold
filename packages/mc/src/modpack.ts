/**
 * Modrinth modpacks (.mrpack): a zip with modrinth.index.json (which files to
 * download, with hashes, and which Minecraft and loader versions to run) plus
 * overrides/ and server-overrides/ folders copied over the server.
 * Format: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */
import { z } from "zod";
import { fetchJson } from "./http.js";

const MODRINTH = "https://api.modrinth.com/v2";

/** The only hosts a pack may download from, as the format requires. */
export const MRPACK_DOWNLOAD_HOSTS = [
  "cdn.modrinth.com",
  "github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
];

const envValue = z.enum(["required", "optional", "unsupported"]);

const indexSchema = z.object({
  formatVersion: z.literal(1),
  game: z.literal("minecraft"),
  versionId: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      hashes: z.object({ sha1: z.string().optional(), sha512: z.string().optional() }),
      env: z.object({ client: envValue, server: envValue }).optional(),
      downloads: z.array(z.string()).min(1),
      fileSize: z.number().int().nonnegative(),
    }),
  ),
  dependencies: z.record(z.string(), z.string()),
});

export type MrpackIndex = z.infer<typeof indexSchema>;

export interface ModpackFile {
  path: string;
  urls: string[];
  sha512: string | null;
  sha1: string | null;
  sizeBytes: number;
}

export interface ModpackPlan {
  name: string;
  version: string;
  summary: string | null;
  mcVersion: string;
  software: "vanilla" | "fabric" | "forge" | "neoforge";
  /** null for vanilla. */
  loaderVersion: string | null;
  /** Files the server needs (client-only ones are left out). */
  files: ModpackFile[];
  /** Client-only files that were left out. */
  clientOnly: number;
  downloadBytes: number;
}

export class ModpackError extends Error {}

/**
 * A relative path inside the server folder, or null if the pack tries to
 * write anywhere else (absolute paths, "..", drive letters).
 */
export function safePackPath(p: string): string | null {
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

function allowedUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && MRPACK_DOWNLOAD_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/** Check a modrinth.index.json and work out what installing it on a server takes. */
export function planModpack(raw: unknown): ModpackPlan {
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModpackError(
      `This is not a Modrinth modpack index: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const index = parsed.data;
  const deps = index.dependencies;
  const mcVersion = deps.minecraft;
  if (!mcVersion) throw new ModpackError("The pack does not say which Minecraft version it needs");
  let software: ModpackPlan["software"] = "vanilla";
  let loaderVersion: string | null = null;
  if (deps["fabric-loader"]) {
    software = "fabric";
    loaderVersion = deps["fabric-loader"];
  } else if (deps.neoforge) {
    software = "neoforge";
    loaderVersion = deps.neoforge;
  } else if (deps.forge) {
    software = "forge";
    loaderVersion = deps.forge;
  } else if (deps["quilt-loader"]) {
    throw new ModpackError("Quilt modpacks are not supported yet (Fabric, Forge and NeoForge are)");
  }

  const files: ModpackFile[] = [];
  let clientOnly = 0;
  for (const f of index.files) {
    if (f.env?.server === "unsupported") {
      clientOnly++;
      continue;
    }
    const path = safePackPath(f.path);
    if (!path)
      throw new ModpackError(`The pack wants to write outside the server folder: ${f.path}`);
    const urls = f.downloads.filter(allowedUrl);
    if (urls.length === 0) {
      throw new ModpackError(`${f.path} downloads from a host modpacks may not use`);
    }
    if (!f.hashes.sha512 && !f.hashes.sha1) throw new ModpackError(`${f.path} has no checksum`);
    files.push({
      path,
      urls,
      sha512: f.hashes.sha512 ?? null,
      sha1: f.hashes.sha1 ?? null,
      sizeBytes: f.fileSize,
    });
  }
  return {
    name: index.name,
    version: index.versionId,
    summary: index.summary ?? null,
    mcVersion,
    software,
    loaderVersion,
    files,
    clientOnly,
    downloadBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
  };
}

/**
 * Where an override entry of the zip goes, or null if it is not an override.
 * server-overrides/ wins over overrides/ for the same path (the caller copies
 * them in that order).
 */
export function overrideTarget(entry: string): { path: string; server: boolean } | null {
  const m = /^(server-overrides|overrides)\/(.+)$/.exec(entry.replace(/\\/g, "/"));
  if (!m?.[2] || m[2].endsWith("/")) return null;
  const path = safePackPath(m[2]);
  return path ? { path, server: m[1] === "server-overrides" } : null;
}

/** Memory to suggest for a pack: more mods need more heap. */
export function suggestedModpackMemoryMb(plan: ModpackPlan): number {
  const mods = plan.files.filter((f) => f.path.startsWith("mods/")).length;
  if (mods > 250) return 10_240;
  if (mods > 150) return 8_192;
  if (mods > 60) return 6_144;
  return 4_096;
}

// --- Modrinth browsing ----------------------------------------------------------

export interface ModpackHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl: string | null;
  downloads: number;
  follows: number;
  loaders: string[];
  gameVersions: string[];
  pageUrl: string;
}

export async function searchModpacks(
  query: string,
  offset = 0,
): Promise<{
  hits: ModpackHit[];
  total: number;
}> {
  const params = new URLSearchParams({
    query,
    offset: String(offset),
    limit: "20",
    index: query ? "relevance" : "downloads",
    // Packs that run on a server.
    facets: JSON.stringify([
      ["project_type:modpack"],
      ["server_side:required", "server_side:optional"],
    ]),
  });
  const res = await fetchJson<{
    hits: Array<{
      project_id: string;
      slug: string;
      title: string;
      description: string;
      author: string;
      icon_url: string | null;
      downloads: number;
      follows: number;
      categories: string[];
      display_categories?: string[];
      versions: string[];
    }>;
    total_hits: number;
  }>(`${MODRINTH}/search?${params}`);
  const loaderNames = new Set(["fabric", "forge", "neoforge", "quilt"]);
  return {
    total: res.total_hits,
    hits: res.hits.map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      iconUrl: h.icon_url || null,
      downloads: h.downloads,
      follows: h.follows,
      loaders: h.categories.filter((c) => loaderNames.has(c)),
      gameVersions: h.versions,
      pageUrl: `https://modrinth.com/modpack/${h.slug}`,
    })),
  };
}

export interface ModpackVersion {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  publishedAt: string;
  featured: boolean;
  file: { url: string; sha512: string | null; sizeBytes: number; fileName: string } | null;
}

export async function modpackVersions(projectId: string): Promise<ModpackVersion[]> {
  const list = await fetchJson<
    Array<{
      id: string;
      name: string;
      version_number: string;
      game_versions: string[];
      loaders: string[];
      date_published: string;
      featured: boolean;
      files: Array<{
        url: string;
        filename: string;
        primary: boolean;
        size: number;
        hashes: { sha512?: string };
      }>;
    }>
  >(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version`);
  return list.map((v) => {
    const f =
      v.files.find((x) => x.primary && x.filename.endsWith(".mrpack")) ??
      v.files.find((x) => x.filename.endsWith(".mrpack"));
    return {
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      publishedAt: v.date_published,
      featured: v.featured,
      file: f
        ? { url: f.url, sha512: f.hashes.sha512 ?? null, sizeBytes: f.size, fileName: f.filename }
        : null,
    };
  });
}

export async function modpackVersion(versionId: string): Promise<ModpackVersion> {
  const v = await fetchJson<{ project_id: string }>(
    `${MODRINTH}/version/${encodeURIComponent(versionId)}`,
  );
  const all = await modpackVersions(v.project_id);
  const hit = all.find((x) => x.id === versionId);
  if (!hit) throw new ModpackError("That modpack version does not exist");
  return hit;
}
