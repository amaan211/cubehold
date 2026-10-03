import type { McVersionOption } from "@cubehold/shared";
import { fetchJson } from "../http.js";
import type { ResolvedDownload } from "./types.js";

/** PaperMC "Fill" API v3. The v2 API was sunset in 2026. */
const BASE = "https://fill.papermc.io/v3/projects";

interface ProjectResponse {
  project: { id: string; name: string };
  /** Grouped by major: { "1.21": ["1.21.11", "1.21.11-rc3", ...] } newest first. */
  versions: Record<string, string[]>;
}

interface VersionResponse {
  version: {
    id: string;
    support: { status: string };
    java: { version: { minimum: number }; flags?: { recommended?: string[] } };
  };
}

interface Build {
  id: number;
  time: string;
  channel: "STABLE" | "BETA" | "ALPHA" | "RECOMMENDED";
  downloads: Record<
    string,
    { name: string; checksums: { sha256: string }; size: number; url: string }
  >;
}

const PRERELEASE = /-(rc|pre|snapshot)/i;

export async function listPaperVersions(project = "paper"): Promise<McVersionOption[]> {
  const res = await fetchJson<ProjectResponse>(`${BASE}/${project}`);
  const out: McVersionOption[] = [];
  for (const group of Object.values(res.versions)) {
    for (const id of group) {
      out.push({ id, kind: PRERELEASE.test(id) ? "snapshot" : "release", releasedAt: null });
    }
  }
  return out;
}

export async function resolvePaper(
  mcVersion: string,
  project = "paper",
): Promise<ResolvedDownload> {
  const [info, builds] = await Promise.all([
    fetchJson<VersionResponse>(`${BASE}/${project}/versions/${mcVersion}`),
    fetchJson<Build[]>(`${BASE}/${project}/versions/${mcVersion}/builds`),
  ]);
  if (builds.length === 0) throw new Error(`No ${project} builds for ${mcVersion}`);
  // Builds come newest first. Prefer the newest stable build; fall back to the newest of any channel.
  const build =
    builds.find((b) => b.channel === "STABLE" || b.channel === "RECOMMENDED") ?? builds[0];
  if (!build) throw new Error(`No ${project} builds for ${mcVersion}`);
  const dl = build.downloads["server:default"] ?? Object.values(build.downloads)[0];
  if (!dl) throw new Error(`${project} build ${build.id} has no server download`);
  return {
    software: project === "paper" ? "paper" : "purpur",
    mcVersion,
    fileName: "server.jar",
    url: dl.url,
    sha256: dl.checksums.sha256,
    sizeBytes: dl.size,
    javaMajor: info.version.java.version.minimum ?? null,
    build: String(build.id),
    recommendedJvmFlags: info.version.java.flags?.recommended,
  };
}
