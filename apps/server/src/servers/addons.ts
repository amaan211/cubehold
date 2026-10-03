import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AddonPlatform,
  AddonUnavailableError,
  type AddonVersion,
  addonPlatform,
  downloadFile,
  identifyModrinthFiles,
  modrinthProjects,
  modrinthUpdates,
  resolveGeyserMc,
  resolveHangarVersion,
  resolveModrinthVersion,
  searchHangar,
  searchModrinth,
} from "@cubehold/mc";
import type { AddonSource } from "@cubehold/shared";
import {
  ACTIVE,
  errMessage,
  nowIso,
  ServerError,
  type ServerRow,
  type ServerService,
} from "./service.js";
import type { Tasks } from "./tasks.js";

/** Where the panel remembers what it installed (Hangar files cannot be looked up by hash). */
const MANIFEST = ".cubehold/addons.json";
const UPDATE_TTL_MS = 10 * 60_000;

interface ManifestEntry {
  source: AddonSource;
  projectId: string;
  versionId: string;
  versionName: string;
  title: string | null;
  iconUrl: string | null;
  pageUrl: string | null;
  installedAt: string;
}
interface Manifest {
  files: Record<string, ManifestEntry>;
}

export interface InstalledAddon {
  file: string;
  enabled: boolean;
  sizeBytes: number;
  modifiedAt: string;
  name: string;
  version: string | null;
  description: string | null;
  source: AddonSource | null;
  projectId: string | null;
  pageUrl: string | null;
  iconUrl: string | null;
  update: { versionName: string } | null;
}

/** The jar name without ".disabled", which is how the manifest keys files. */
const baseName = (file: string) => file.replace(/\.disabled$/i, "");

function checkFile(file: string): string {
  if (/[/\\]/.test(file) || !/\.jar(\.disabled)?$/i.test(file)) {
    throw new ServerError("VALIDATION", "Not a plugin or mod file");
  }
  return file;
}

/**
 * Plugin (Paper/Purpur) and mod (Fabric, Forge, NeoForge) management:
 * search Modrinth and Hangar filtered to the server's loader and version,
 * install with required dependencies, detect what is installed by hash,
 * offer updates, disable and remove.
 *
 * Downloads land in the panel's temp folder, are verified, then uploaded to
 * the server's host through its agent, so this works the same for remote
 * hosts later.
 */
export class AddonService {
  #updates = new Map<string, { at: number; key: string; data: Map<string, AddonVersion> }>();

  constructor(
    private readonly servers: ServerService,
    private readonly tasks: Tasks,
    private readonly tmpDir: string,
  ) {}

  async info(serverId: string) {
    const row = await this.servers.row(serverId);
    return {
      platform: addonPlatform(row.software as never),
      software: row.software,
      mcVersion: row.mcVersion,
    };
  }

  async search(serverId: string, source: AddonSource, query: string, offset: number) {
    const row = await this.servers.row(serverId);
    const platform = this.#platform(row);
    try {
      if (source === "geysermc") {
        throw new ServerError("VALIDATION", "Geyser is set up from the Network tab");
      }
      if (source === "hangar") {
        if (!platform.hangar) throw new ServerError("VALIDATION", "Hangar only has Paper plugins");
        return await searchHangar(row.mcVersion, query, offset);
      }
      return await searchModrinth(platform, row.mcVersion, query, offset);
    } catch (err) {
      if (err instanceof ServerError) throw err;
      throw new ServerError(
        "BAD_STATE",
        `Could not reach ${source === "hangar" ? "Hangar" : "Modrinth"}: ${errMessage(err)}`,
      );
    }
  }

  async installed(serverId: string, checkUpdates = true) {
    const row = await this.servers.row(serverId);
    const platform = this.#platform(row);
    const agent = this.servers.agentOf(row);
    const jars = await agent.inspectJars(row.directory, platform.folder);
    const manifest = await this.#readManifest(row);

    let offline = false;
    let identified = new Map<
      string,
      { projectId: string; versionId: string; versionName: string }
    >();
    try {
      identified = await identifyModrinthFiles(jars.map((j) => j.sha1));
    } catch {
      offline = true;
    }
    const projectIds = new Set<string>([...identified.values()].map((v) => v.projectId));
    for (const m of Object.values(manifest.files))
      if (m.source === "modrinth") projectIds.add(m.projectId);
    const projects = await modrinthProjects([...projectIds]).catch(() => new Map());

    let updates = new Map<string, AddonVersion>();
    if (checkUpdates && !offline)
      updates = await this.#checkUpdates(row, platform, jars, identified, manifest);

    const items: InstalledAddon[] = jars.map((j) => {
      const m = manifest.files[baseName(j.file)];
      const id = identified.get(j.sha1);
      const projectId = id?.projectId ?? m?.projectId ?? null;
      const source: AddonSource | null = id ? "modrinth" : (m?.source ?? null);
      const proj = source === "modrinth" && projectId ? projects.get(projectId) : undefined;
      const upd = updates.get(j.file);
      return {
        file: j.file,
        enabled: j.enabled,
        sizeBytes: j.sizeBytes,
        modifiedAt: j.modifiedAt,
        name: proj?.title ?? j.name ?? m?.title ?? baseName(j.file).replace(/\.jar$/i, ""),
        version: j.version ?? id?.versionName ?? m?.versionName ?? null,
        description: j.description,
        source,
        projectId,
        pageUrl: proj ? `https://modrinth.com/${platform.kind}/${proj.slug}` : (m?.pageUrl ?? null),
        iconUrl: proj?.iconUrl ?? m?.iconUrl ?? null,
        update: upd ? { versionName: upd.versionName } : null,
      };
    });
    return {
      platform,
      items,
      offline,
      running: ACTIVE.includes(row.status as never),
    };
  }

  /** Install the newest compatible version, plus missing required dependencies (Modrinth). */
  async install(
    serverId: string,
    source: AddonSource,
    projectId: string,
    withDependencies: boolean,
  ) {
    const row = await this.servers.row(serverId);
    this.servers.assertIdle(row);
    const platform = this.#platform(row);
    if (source === "hangar" && !platform.hangar) {
      throw new ServerError("VALIDATION", "Hangar only has Paper plugins");
    }
    const version = await this.#resolve(source, projectId, platform, row.mcVersion);
    return this.tasks.run(
      serverId,
      "addon",
      `Installing ${version.fileName}`,
      async (task) => {
        const current = await this.installed(serverId, false);
        const have = new Set(current.items.map((i) => i.projectId).filter(Boolean));
        const installed: string[] = [];
        const notes: string[] = [];

        await this.#put(row, platform, version);
        installed.push(version.fileName);
        have.add(version.projectId);

        for (const dep of version.dependencies) {
          if (dep.projectId) {
            if (!withDependencies || have.has(dep.projectId)) continue;
            task.progress(null, `Installing dependency ${dep.projectId}`);
            try {
              const dv = await resolveModrinthVersion(dep.projectId, platform, row.mcVersion);
              await this.#put(row, platform, dv);
              installed.push(dv.fileName);
              have.add(dep.projectId);
            } catch (err) {
              notes.push(
                `Could not install a required dependency (${dep.projectId}): ${errMessage(err)}`,
              );
            }
          } else if (
            dep.name &&
            !current.items.some((i) => i.name.toLowerCase() === dep.name?.toLowerCase())
          ) {
            notes.push(
              `Also needs ${dep.name}${dep.externalUrl ? ` from ${dep.externalUrl}` : ""}.`,
            );
          }
        }
        this.#updates.delete(serverId);
        const running = ACTIVE.includes((await this.servers.row(serverId)).status as never);
        if (running) notes.push("Restart the server to load it.");
        return { installed, notes };
      },
      (r) => r.installed.join(", "),
    );
  }

  async update(serverId: string, file: string) {
    checkFile(file);
    const row = await this.servers.row(serverId);
    this.servers.assertIdle(row);
    const platform = this.#platform(row);
    this.#assertStopped(row, platform);
    const current = await this.installed(serverId, true);
    const item = current.items.find((i) => i.file === file);
    if (!item) throw new ServerError("NOT_FOUND", `${file} is not installed`);
    if (!item.update || !item.source || !item.projectId) {
      throw new ServerError("BAD_STATE", `${item.name} is up to date`);
    }
    const source = item.source;
    const projectId = item.projectId;
    return this.tasks.run(serverId, "addon", `Updating ${item.name}`, async () => {
      const v = await this.#resolve(source, projectId, platform, row.mcVersion);
      await this.#put(row, platform, v, !item.enabled);
      const newFile = item.enabled ? v.fileName : `${v.fileName}.disabled`;
      if (newFile !== file) {
        await this.servers.agentOf(row).removePaths(row.directory, [`${platform.folder}/${file}`]);
        await this.#editManifest(row, (m) => {
          delete m.files[baseName(file)];
        });
      }
      this.#updates.delete(serverId);
      return { file: newFile, version: v.versionName };
    });
  }

  async remove(serverId: string, file: string, deleteConfig: boolean) {
    checkFile(file);
    const row = await this.servers.row(serverId);
    this.servers.assertIdle(row);
    const platform = this.#platform(row);
    this.#assertStopped(row, platform);
    const agent = this.servers.agentOf(row);
    const jar = (await agent.inspectJars(row.directory, platform.folder)).find(
      (j) => j.file === file,
    );
    if (!jar) throw new ServerError("NOT_FOUND", `${file} is not installed`);
    const paths = [`${platform.folder}/${file}`];
    // A plugin keeps its settings and data in plugins/<name>.
    if (deleteConfig && platform.kind === "plugin" && jar.id && /^[\w .-]+$/.test(jar.id)) {
      paths.push(`plugins/${jar.id}`);
    }
    await agent.removePaths(row.directory, paths);
    await this.#editManifest(row, (m) => {
      delete m.files[baseName(file)];
    });
    this.#updates.delete(serverId);
    return { removed: paths };
  }

  /** Disable by renaming to .jar.disabled, which Paper and every mod loader ignore. */
  async toggle(serverId: string, file: string, enabled: boolean) {
    checkFile(file);
    const row = await this.servers.row(serverId);
    this.servers.assertIdle(row);
    const platform = this.#platform(row);
    this.#assertStopped(row, platform);
    const isEnabled = !/\.disabled$/i.test(file);
    if (isEnabled === enabled) return { file };
    const next = enabled ? baseName(file) : `${file}.disabled`;
    await this.servers
      .agentOf(row)
      .rename(row.directory, `${platform.folder}/${file}`, `${platform.folder}/${next}`);
    return { file: next };
  }

  // --- internals -------------------------------------------------------------------

  /** A running server holds its jars open (Windows refuses to touch them) and would not notice anyway. */
  #assertStopped(row: ServerRow, platform: AddonPlatform): void {
    if (ACTIVE.includes(row.status as never)) {
      throw new ServerError(
        "BAD_STATE",
        `Stop the server first: it keeps its ${platform.kind} files open while running.`,
      );
    }
  }

  #platform(row: ServerRow): AddonPlatform {
    const p = addonPlatform(row.software as never);
    if (!p) {
      throw new ServerError(
        "BAD_STATE",
        "Vanilla servers cannot load plugins or mods. Create a Paper, Purpur or Fabric server for that.",
      );
    }
    return p;
  }

  async #resolve(
    source: AddonSource,
    projectId: string,
    platform: AddonPlatform,
    mcVersion: string,
  ) {
    try {
      if (source === "geysermc") {
        if (projectId !== "geyser" && projectId !== "floodgate") {
          throw new AddonUnavailableError(`GeyserMC has no project ${projectId}`);
        }
        return await resolveGeyserMc(projectId);
      }
      return source === "hangar"
        ? await resolveHangarVersion(projectId, mcVersion)
        : await resolveModrinthVersion(projectId, platform, mcVersion);
    } catch (err) {
      if (err instanceof AddonUnavailableError) throw new ServerError("VALIDATION", err.message);
      throw new ServerError("BAD_STATE", `Could not reach ${source}: ${errMessage(err)}`);
    }
  }

  /** Download, verify, and upload one version into the server's plugin/mod folder. */
  async #put(
    row: ServerRow,
    platform: AddonPlatform,
    v: AddonVersion,
    disabled = false,
  ): Promise<void> {
    if (/[/\\]/.test(v.fileName) || !/\.jar$/i.test(v.fileName)) {
      throw new ServerError("BAD_STATE", `Unexpected file name from ${v.source}: ${v.fileName}`);
    }
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, `${randomBytes(6).toString("hex")}-${v.fileName}`);
    try {
      await downloadFile(v.url, tmp, { sha1: v.sha1, sha256: v.sha256, sha512: v.sha512 });
      const target = `${platform.folder}/${v.fileName}${disabled ? ".disabled" : ""}`;
      await this.servers
        .remoteOf(row)
        .upload(row.directory, target, fs.createReadStream(tmp), true);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    let title: string | null = null;
    let iconUrl: string | null = null;
    let pageUrl: string | null = null;
    if (v.source === "modrinth") {
      const p = (await modrinthProjects([v.projectId]).catch(() => new Map())).get(v.projectId);
      title = p?.title ?? null;
      iconUrl = p?.iconUrl ?? null;
      pageUrl = p ? `https://modrinth.com/${platform.kind}/${p.slug}` : null;
    } else if (v.source === "geysermc") {
      title = v.projectId === "geyser" ? "Geyser" : "Floodgate";
      pageUrl = `https://geysermc.org/download?project=${v.projectId}`;
    } else {
      title = v.projectId;
      pageUrl = `https://hangar.papermc.io/${v.projectId}`;
    }
    await this.#editManifest(row, (m) => {
      m.files[v.fileName] = {
        source: v.source,
        projectId: v.projectId,
        versionId: v.versionId,
        versionName: v.versionName,
        title,
        iconUrl,
        pageUrl,
        installedAt: nowIso(),
      };
    });
  }

  async #checkUpdates(
    row: ServerRow,
    platform: AddonPlatform,
    jars: Array<{ file: string; sha1: string }>,
    identified: Map<string, { versionId: string }>,
    manifest: Manifest,
  ): Promise<Map<string, AddonVersion>> {
    const key = `${row.mcVersion}|${jars.map((j) => j.sha1).join(",")}`;
    const hit = this.#updates.get(row.id);
    if (hit && hit.key === key && Date.now() - hit.at < UPDATE_TTL_MS) return hit.data;

    const out = new Map<string, AddonVersion>();
    const known = jars.filter((j) => identified.has(j.sha1));
    try {
      const latest = await modrinthUpdates(
        known.map((j) => j.sha1),
        platform,
        row.mcVersion,
      );
      for (const j of known) {
        const v = latest.get(j.sha1);
        if (v && v.versionId !== identified.get(j.sha1)?.versionId) out.set(j.file, v);
      }
    } catch {
      // offline or rate limited; no update badges this time
    }
    for (const j of jars) {
      const m = manifest.files[baseName(j.file)];
      if (!m || m.source === "modrinth" || identified.has(j.sha1)) continue;
      try {
        const v = await this.#resolve(m.source, m.projectId, platform, row.mcVersion);
        if (v.versionName !== m.versionName) out.set(j.file, v);
      } catch {
        // project gone or no compatible version
      }
    }
    this.#updates.set(row.id, { at: Date.now(), key, data: out });
    return out;
  }

  async #readManifest(row: ServerRow): Promise<Manifest> {
    try {
      const parsed = JSON.parse(
        await this.servers.agentOf(row).readFile(row.directory, MANIFEST),
      ) as Manifest;
      return parsed?.files ? parsed : { files: {} };
    } catch {
      return { files: {} };
    }
  }

  async #editManifest(row: ServerRow, fn: (m: Manifest) => void): Promise<void> {
    const m = await this.#readManifest(row);
    fn(m);
    await this.servers.agentOf(row).writeFile(row.directory, MANIFEST, JSON.stringify(m, null, 2));
  }
}
