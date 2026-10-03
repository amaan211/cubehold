import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  applyProperties,
  downloadFile,
  formatBytes,
  ModpackError,
  type ModpackPlan,
  modpackVersion,
  modpackVersions,
  overrideTarget,
  parseProperties,
  planModpack,
  propertiesToMap,
  searchModpacks,
  serializeProperties,
  suggestedModpackMemoryMb,
} from "@cubehold/mc";
import type { InstallModpackInput } from "@cubehold/shared";
import yauzl from "yauzl";
import yazl from "yazl";
import { type AfterInstall, errMessage, ServerError, type ServerService } from "./service.js";

/** Largest .mrpack accepted: the mods themselves are downloaded separately. */
const MAX_PACK_BYTES = 1024 * 1024 * 1024;
/** Prepared packs nobody installed are removed after this. */
const PACK_TTL_MS = 2 * 60 * 60_000;
/** Mods downloaded at once on the host. */
const PARALLEL_DOWNLOADS = 6;

/**
 * server.properties keys the panel manages; a pack's own values for these
 * are ignored (port, login mode, RCON, query, whitelist).
 */
const MANAGED_PROPERTIES = new Set([
  "server-port",
  "server-ip",
  "online-mode",
  "enforce-secure-profile",
  "enable-rcon",
  "rcon.port",
  "rcon.password",
  "enable-query",
  "query.port",
  "white-list",
  "enforce-whitelist",
  "motd",
]);

interface PreparedPack {
  id: string;
  file: string;
  plan: ModpackPlan;
  overrides: number;
  iconUrl: string | null;
  at: number;
}

/**
 * Modrinth modpacks as new servers: read the pack, create the server with the
 * pack's Minecraft and loader versions, then (still "installing") download
 * the mods on the host, each checked against the pack's hash, and copy the
 * pack's overrides (configs, scripts) over the server.
 */
export class ModpackService {
  #packs = new Map<string, PreparedPack>();

  constructor(
    private readonly servers: ServerService,
    private readonly tmpDir: string,
  ) {
    // Prepared packs live in memory only, so files from before a restart are orphans.
    fs.rmSync(path.join(tmpDir, "modpacks"), { recursive: true, force: true });
  }

  search(query: string, offset: number) {
    return searchModpacks(query, offset);
  }

  async versions(projectId: string) {
    return (await modpackVersions(projectId)).filter((v) => v.file !== null);
  }

  /** Download a pack version from Modrinth and read it. */
  async fromModrinth(versionId: string, iconUrl: string | null) {
    const version = await modpackVersion(versionId).catch((err) => {
      throw new ServerError("VALIDATION", errMessage(err));
    });
    if (!version.file) throw new ServerError("VALIDATION", "This version has no .mrpack file");
    const file = this.#tmpFile();
    await downloadFile(version.file.url, file, {
      ...(version.file.sha512 ? { sha512: version.file.sha512 } : {}),
      timeoutMs: 10 * 60_000,
    });
    return this.#prepare(file, iconUrl);
  }

  /** A .mrpack uploaded from the browser. */
  async fromUpload(body: Readable) {
    const file = this.#tmpFile();
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > MAX_PACK_BYTES)
          done(new ServerError("VALIDATION", "The file is larger than 1 GB"));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, fs.createWriteStream(file));
    } catch (err) {
      await fs.promises.rm(file, { force: true });
      throw err;
    }
    return this.#prepare(file, null);
  }

  preview(packId: string) {
    return this.#view(this.#pack(packId));
  }

  async install(input: InstallModpackInput) {
    const pack = this.#pack(input.packId);
    const { plan } = pack;
    const afterInstall: AfterInstall = (ctx) => this.#installFiles(pack, ctx);
    const server = await this.servers.create(
      {
        hostId: input.hostId,
        name: input.name,
        software: plan.software,
        mcVersion: plan.mcVersion,
        memoryMb: input.memoryMb,
        port: input.port,
        onlineMode: input.onlineMode,
        acceptEula: input.acceptEula,
      },
      {
        ...(plan.loaderVersion ? { loaderVersion: plan.loaderVersion } : {}),
        afterInstall,
        modpack: { name: plan.name, version: plan.version },
      },
    );
    return server;
  }

  async #prepare(file: string, iconUrl: string | null) {
    try {
      const { index, overrides } = await readPack(file);
      const plan = planModpack(index);
      const id = randomBytes(9).toString("base64url");
      const pack: PreparedPack = { id, file, plan, overrides, iconUrl, at: Date.now() };
      this.#packs.set(id, pack);
      this.#sweep();
      return this.#view(pack);
    } catch (err) {
      await fs.promises.rm(file, { force: true });
      throw err instanceof ModpackError ? new ServerError("VALIDATION", err.message) : err;
    }
  }

  #view(pack: PreparedPack) {
    const { plan } = pack;
    const mods = plan.files.filter((f) => f.path.startsWith("mods/")).length;
    return {
      packId: pack.id,
      name: plan.name,
      version: plan.version,
      summary: plan.summary,
      iconUrl: pack.iconUrl,
      mcVersion: plan.mcVersion,
      software: plan.software,
      loaderVersion: plan.loaderVersion,
      mods,
      otherFiles: plan.files.length - mods,
      clientOnly: plan.clientOnly,
      overrides: pack.overrides,
      downloadBytes: plan.downloadBytes,
      suggestedMemoryMb: suggestedModpackMemoryMb(plan),
    };
  }

  #pack(packId: string): PreparedPack {
    const pack = this.#packs.get(packId);
    if (!pack) {
      throw new ServerError("NOT_FOUND", "This modpack is no longer prepared; choose it again");
    }
    return pack;
  }

  #tmpFile(): string {
    const dir = path.join(this.tmpDir, "modpacks");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${randomBytes(9).toString("base64url")}.mrpack`);
  }

  /** Forget packs that were prepared long ago and never installed. */
  #sweep(): void {
    for (const [id, p] of this.#packs) {
      if (Date.now() - p.at > PACK_TTL_MS) {
        this.#packs.delete(id);
        void fs.promises.rm(p.file, { force: true });
      }
    }
  }

  async #installFiles(pack: PreparedPack, ctx: Parameters<AfterInstall>[0]): Promise<void> {
    const { row, agent, report } = ctx;
    const { plan } = pack;
    const total = plan.files.length;
    let done = 0;
    report(
      "download",
      `Downloading ${total} files of ${plan.name} (${formatBytes(plan.downloadBytes)})`,
      0,
    );

    // The host downloads each file itself and checks it against the pack's hash.
    const queue = [...plan.files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        let lastError: unknown = null;
        for (const url of f.urls) {
          try {
            await agent.fetchUrl({
              url,
              root: row.directory,
              relPath: f.path,
              ...(f.sha512 ? { sha512: f.sha512 } : { sha1: f.sha1 as string }),
            });
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (lastError) throw new Error(`${f.path}: ${errMessage(lastError)}`);
        done++;
        report(
          "download",
          `Downloading ${plan.name} files (${done}/${total})`,
          Math.round((done / total) * 100),
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_DOWNLOADS, total) }, worker));

    if (pack.overrides > 0) {
      report("configure", `Copying ${pack.overrides} configuration files from the pack`, null);
      const { zip, properties } = await overridesZip(pack.file);
      const name = ".cubehold-modpack.zip";
      try {
        await agent.upload(row.directory, name, fs.createReadStream(zip), true);
        await agent.unzip(agentPath(row.directory, name), row.directory, { overwrite: true });
      } finally {
        await agent.removePaths(row.directory, [name]).catch(() => {});
        await fs.promises.rm(zip, { force: true });
      }
      if (properties) await this.#mergeProperties(row.directory, agent, properties);
    }
    report("configure", `${plan.name} ${plan.version} installed`, null);
    this.#packs.delete(pack.id);
    await fs.promises.rm(pack.file, { force: true });
  }

  /** The pack's server.properties, minus what the panel manages. */
  async #mergeProperties(
    directory: string,
    agent: Parameters<AfterInstall>[0]["agent"],
    packText: string,
  ): Promise<void> {
    const current = parseProperties(await agent.readFile(directory, "server.properties"));
    const values: Record<string, string> = {};
    for (const [key, value] of propertiesToMap(parseProperties(packText))) {
      if (!MANAGED_PROPERTIES.has(key)) values[key] = value;
    }
    await agent.writeFile(
      directory,
      "server.properties",
      serializeProperties(applyProperties(current, values)),
    );
  }
}

/** Join a file name onto a host path whichever separator the host uses. */
function agentPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") ? "\\" : "/"}${name}`;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) =>
      err || !zip ? reject(err ?? new Error("cannot open zip")) : resolve(zip),
    ),
  );
}

async function* entries(zip: yauzl.ZipFile): AsyncGenerator<yauzl.Entry> {
  const next = () =>
    new Promise<yauzl.Entry | null>((resolve, reject) => {
      zip.once("entry", (e: yauzl.Entry) => {
        zip.removeAllListeners("end");
        resolve(e);
      });
      zip.once("end", () => {
        zip.removeAllListeners("entry");
        resolve(null);
      });
      zip.once("error", reject);
      zip.readEntry();
    });
  for (let e = await next(); e; e = await next()) yield e;
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("cannot read zip entry"));
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    }),
  );
}

/** The index and the number of override files, without unpacking anything. */
async function readPack(file: string): Promise<{ index: unknown; overrides: number }> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(file);
  } catch {
    throw new ModpackError("This is not a .mrpack file (it is not a zip)");
  }
  try {
    let index: unknown = null;
    let overrides = 0;
    for await (const e of entries(zip)) {
      if (e.fileName === "modrinth.index.json") {
        if (e.uncompressedSize > 32 * 1024 * 1024)
          throw new ModpackError("The pack index is too large");
        index = JSON.parse((await readEntry(zip, e)).toString("utf8"));
      } else if (overrideTarget(e.fileName)) {
        overrides++;
      }
    }
    if (!index)
      throw new ModpackError(
        "This zip has no modrinth.index.json, so it is not a Modrinth modpack",
      );
    return { index, overrides };
  } finally {
    zip.close();
  }
}

/**
 * A zip of the pack's overrides with the overrides/ prefix removed,
 * server-overrides/ winning over overrides/. server.properties and eula.txt
 * are held back: the panel manages those.
 */
async function overridesZip(file: string): Promise<{ zip: string; properties: string | null }> {
  const zip = await openZip(file);
  const chosen = new Map<string, yauzl.Entry>();
  let properties: { text: string; server: boolean } | null = null;
  const dest = `${file}.overrides.zip`;
  try {
    for await (const e of entries(zip)) {
      const target = overrideTarget(e.fileName);
      if (!target) continue;
      if (target.path === "eula.txt") continue;
      if (target.path === "server.properties") {
        if (!properties || target.server) {
          properties = { text: (await readEntry(zip, e)).toString("utf8"), server: target.server };
        }
        continue;
      }
      // Entries come in any order; a server-overrides/ copy always wins.
      const prev = chosen.get(target.path);
      if (!prev || target.server) chosen.set(target.path, e);
    }
    // Streamed one entry at a time, so large override folders never sit in memory.
    const out = new yazl.ZipFile();
    const written = pipeline(out.outputStream as unknown as Readable, fs.createWriteStream(dest));
    for (const [p, entry] of chosen) {
      out.addReadStream(await entryStream(zip, entry), p, { mtime: entry.getLastModDate() });
    }
    out.end();
    await written;
  } finally {
    zip.close();
  }
  return { zip: dest, properties: properties?.text ?? null };
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, stream) =>
      err || !stream ? reject(err ?? new Error("cannot read zip entry")) : resolve(stream),
    ),
  );
}
