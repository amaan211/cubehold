import type { McVersionOption } from "@cubehold/shared";
import { fetchJson } from "../http.js";
import type { ResolvedDownload } from "./types.js";
import { getVersionJson } from "./vanilla.js";

const META = "https://meta.fabricmc.net/v2/versions";

interface GameVersion {
  version: string;
  stable: boolean;
}
interface LoaderVersion {
  version: string;
  stable: boolean;
}
interface InstallerVersion {
  version: string;
  stable: boolean;
  url: string;
}

export async function listFabricVersions(): Promise<McVersionOption[]> {
  const games = await fetchJson<GameVersion[]>(`${META}/game`);
  return games.map((g) => ({
    id: g.version,
    kind: g.stable ? "release" : "snapshot",
    releasedAt: null,
  }));
}

/**
 * Fabric publishes a small "server launcher" jar per (game, loader, installer)
 * triple. On first run it downloads the vanilla server and the loader libraries.
 */
export async function resolveFabric(
  mcVersion: string,
  loaderVersion?: string,
): Promise<ResolvedDownload> {
  const [loaders, installers] = await Promise.all([
    fetchJson<LoaderVersion[]>(`${META}/loader`),
    fetchJson<InstallerVersion[]>(`${META}/installer`),
  ]);
  // A modpack names its loader; otherwise the newest stable one.
  const loader = loaderVersion
    ? loaders.find((l) => l.version === loaderVersion)
    : (loaders.find((l) => l.stable) ?? loaders[0]);
  if (loaderVersion && !loader) throw new Error(`Fabric Loader ${loaderVersion} does not exist`);
  const installer = installers.find((i) => i.stable) ?? installers[0];
  if (!loader || !installer) throw new Error("Fabric meta returned no loader/installer versions");

  // The Java requirement comes from Mojang's version JSON for the same game version.
  let javaMajor: number | null = null;
  try {
    javaMajor = (await getVersionJson(mcVersion)).javaVersion?.majorVersion ?? null;
  } catch {
    javaMajor = null;
  }

  return {
    software: "fabric",
    mcVersion,
    fileName: "fabric-server-launch.jar",
    url: `${META}/loader/${mcVersion}/${loader.version}/${installer.version}/server/jar`,
    sizeBytes: null,
    javaMajor,
    build: loader.version,
  };
}
