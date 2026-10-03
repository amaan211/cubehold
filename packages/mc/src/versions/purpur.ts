import type { McVersionOption } from "@cubehold/shared";
import { fetchJson } from "../http.js";
import type { ResolvedDownload } from "./types.js";

/** Purpur, a Paper fork with extra gameplay options. https://purpurmc.org/docs/purpur/ */
const BASE = "https://api.purpurmc.org/v2/purpur";

export async function listPurpurVersions(): Promise<McVersionOption[]> {
  const res = await fetchJson<{ versions: string[] }>(BASE);
  // The API lists oldest first.
  return [...res.versions].reverse().map((id) => ({
    id,
    kind: /-(rc|pre)/i.test(id) ? "snapshot" : "release",
    releasedAt: null,
  }));
}

export async function resolvePurpur(mcVersion: string): Promise<ResolvedDownload> {
  const version = await fetchJson<{ builds: { latest: string } }>(`${BASE}/${mcVersion}`);
  const build = version.builds.latest;
  if (!build) throw new Error(`No Purpur builds for ${mcVersion}`);
  const info = await fetchJson<{ md5?: string; result?: string }>(`${BASE}/${mcVersion}/${build}`);
  return {
    software: "purpur",
    mcVersion,
    fileName: "server.jar",
    url: `${BASE}/${mcVersion}/${build}/download`,
    md5: info.md5,
    sizeBytes: null,
    javaMajor: null,
    build,
  };
}
