import { bedrockSupport, compareVersionsIn, getManifest, listVersions } from "@cubehold/mc";
import type { Server } from "@cubehold/shared";
import type { AddonService } from "../servers/addons.js";
import { ACTIVE, errMessage, ServerError, type ServerService } from "../servers/service.js";
import type { NetworkService } from "./service.js";

interface Installed {
  file: string;
  name: string;
  version: string | null;
  enabled: boolean;
}

const match = (items: Installed[], re: RegExp) =>
  items.find((i) => re.test(i.file) || re.test(i.name)) ?? null;

/**
 * Bedrock crossplay: Geyser translates for Bedrock players (phones,
 * consoles, Windows Bedrock) and Floodgate lets them in without a Java
 * account. Paper and Purpur get both from GeyserMC, plus ViaVersion when the
 * server is behind the newest release; Fabric gets them from Modrinth.
 * Each server gets its own Bedrock (UDP) port, passed to Geyser at launch.
 */
export class BedrockService {
  constructor(
    private readonly servers: ServerService,
    private readonly addons: AddonService,
    private readonly network: NetworkService,
  ) {}

  async status(serverId: string) {
    const row = await this.servers.row(serverId);
    const support = await this.#support(
      row.software as Server["software"],
      row.mcVersion,
      row.javaVersion,
    );
    let items: Installed[] = [];
    if (row.software !== "vanilla") {
      // Local jar metadata only: the full plugin list also asks Modrinth, which is slow.
      const folder = row.software === "fabric" ? "mods" : "plugins";
      const jars = await this.servers
        .agentOf(row)
        .inspectJars(row.directory, folder)
        .catch(() => []);
      items = jars.map((j) => ({
        file: j.file,
        name: j.name ?? j.file.replace(/\.jar(\.disabled)?$/i, ""),
        version: j.version,
        enabled: j.enabled,
      }));
    }
    const geyser = match(items, /geyser/i);
    const floodgate = match(items, /floodgate/i);
    return {
      ...support,
      geyser,
      floodgate,
      viaversion: match(items, /viaversion/i),
      enabled: !!geyser?.enabled,
      port: await this.servers.bedrockPort(row, false),
      running: ACTIVE.includes(row.status as never),
    };
  }

  async enable(serverId: string) {
    const row = await this.servers.row(serverId);
    const support = await this.#support(
      row.software as Server["software"],
      row.mcVersion,
      row.javaVersion,
    );
    if (!support.supported) throw new ServerError("VALIDATION", support.reason);
    const current = await this.status(serverId);
    const steps: Array<[source: "geysermc" | "modrinth", project: string, label: string]> =
      support.via === "geysermc"
        ? [
            ["geysermc", "geyser", "Geyser"],
            ["geysermc", "floodgate", "Floodgate"],
            ...(support.needsViaVersion
              ? [["modrinth", "viaversion", "ViaVersion"] as ["modrinth", string, string]]
              : []),
          ]
        : [
            ["modrinth", "geyser", "Geyser"],
            ["modrinth", "floodgate", "Floodgate"],
          ];
    const notes: string[] = [];
    for (const [source, project, label] of steps) {
      const have =
        (label === "Geyser" && current.geyser) ||
        (label === "Floodgate" && current.floodgate) ||
        (label === "ViaVersion" && current.viaversion);
      if (have) continue;
      try {
        const r = await this.addons.install(serverId, source, project, true);
        notes.push(...r.notes);
      } catch (err) {
        // Geyser is required; the rest improves things but is not essential.
        if (label === "Geyser")
          throw new ServerError("BAD_STATE", `Could not install Geyser: ${errMessage(err)}`);
        notes.push(`${label} could not be installed: ${errMessage(err)}`);
      }
    }
    const port = await this.servers.bedrockPort(await this.servers.row(serverId), true);
    await this.network.syncMappings(row.hostId).catch(() => {});
    return { port, notes: [...new Set(notes)] };
  }

  /** Remove Geyser and Floodgate (ViaVersion stays: other things may rely on it). */
  async disable(serverId: string) {
    const current = await this.status(serverId);
    if (current.running) {
      throw new ServerError(
        "BAD_STATE",
        "Stop the server first: it keeps its plugin files open while running.",
      );
    }
    for (const item of [current.geyser, current.floodgate]) {
      if (item) await this.addons.remove(serverId, item.file, false);
    }
    const row = await this.servers.row(serverId);
    await this.servers.updateSettings(serverId, { bedrockPort: null });
    await this.network.syncMappings(row.hostId).catch(() => {});
    return { ok: true };
  }

  async #support(software: Server["software"], mcVersion: string, javaMajor: number) {
    const [list, manifest] = await Promise.all([
      listVersions(software).catch(() => []),
      getManifest().catch(() => null),
    ]);
    const compare = (a: string, b: string) => compareVersionsIn(list, a, b);
    const s = bedrockSupport(
      software,
      mcVersion,
      javaMajor,
      manifest?.latest.release ?? null,
      compare,
    );
    return s.supported
      ? { supported: true as const, reason: null, via: s.via, needsViaVersion: s.needsViaVersion }
      : { supported: false as const, reason: s.reason, via: null, needsViaVersion: false };
  }
}
