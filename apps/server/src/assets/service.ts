import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { clientJarFor, downloadFile } from "@cubehold/mc";
import type { GuiTextures, ItemIcon } from "@cubehold/shared";
import yauzl from "yauzl";
import { type AssetReader, displayName, guiTextures, resolveIcon } from "./models.js";

/** What is taken from the client jar: item and block art, a few mob skins, HUD and inventory GUI. */
const KEEP = [
  "textures/item/",
  "textures/block/",
  "textures/entity/chest/",
  "textures/entity/shulker/",
  "textures/entity/skeleton/",
  "textures/entity/zombie/zombie.png",
  "textures/entity/creeper/creeper.png",
  "textures/entity/player/wide/steve.png",
  "textures/entity/shield",
  "textures/gui/sprites/hud/",
  "textures/gui/sprites/container/slot/",
  "textures/gui/container/inventory.png",
  "textures/gui/container/generic_54.png",
  "textures/gui/icons.png",
  "models/item/",
  "models/block/",
  "items/",
  "lang/en_us.json",
];
const PREFIX = "assets/minecraft/";
/** Bump when KEEP changes so older extractions are redone. */
const COMPLETE = ".complete-v2";
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Minecraft's own textures, models and English names, per game version,
 * taken from the official client jar (about 25 MB, downloaded once from
 * Mojang; only the needed files are kept, about 2 MB). Used to draw inventories exactly
 * like the game. Versions no server uses any more are removed.
 */
export class AssetService {
  #preparing = new Map<string, Promise<string>>();
  #icons = new Map<string, Map<string, ItemIcon>>();
  #lang = new Map<string, Record<string, string>>();
  #sizes = new Map<string, Map<string, [number, number] | null>>();

  constructor(private readonly root: string) {}

  dir(version: string): string {
    if (!VERSION.test(version)) throw new Error(`Invalid version: ${version}`);
    return path.join(this.root, version);
  }

  isReady(version: string): boolean {
    return fs.existsSync(path.join(this.dir(version), COMPLETE));
  }

  /** Make sure a version's assets are on disk; downloads and extracts them the first time. */
  ensure(version: string): Promise<string> {
    const dir = this.dir(version);
    if (this.isReady(version)) return Promise.resolve(dir);
    let job = this.#preparing.get(version);
    if (!job) {
      job = this.#prepare(version, dir).finally(() => this.#preparing.delete(version));
      this.#preparing.set(version, job);
    }
    return job;
  }

  async icons(
    version: string,
    ids: string[],
  ): Promise<{ icons: Record<string, ItemIcon>; names: Record<string, string>; gui: GuiTextures }> {
    await this.ensure(version);
    const reader = this.#reader(version);
    let cache = this.#icons.get(version);
    if (!cache) {
      cache = new Map();
      this.#icons.set(version, cache);
    }
    const lang = this.#langFor(version);
    const icons: Record<string, ItemIcon> = {};
    const names: Record<string, string> = {};
    for (const raw of new Set(ids)) {
      const id = raw.includes(":") ? raw : `minecraft:${raw}`;
      let icon = cache.get(id);
      if (!icon) {
        icon = resolveIcon(reader, id);
        cache.set(id, icon);
      }
      icons[id] = icon;
      names[id] = displayName(lang, id);
    }
    return { icons, names, gui: guiTextures(reader) };
  }

  /** Every item in the game with its English name, for the give-item picker. */
  async catalog(version: string): Promise<Array<{ id: string; name: string }>> {
    const dir = await this.ensure(version);
    const lang = this.#langFor(version);
    // 1.21.4+ lists every item in items/; older versions have one item model each.
    let files = await fs.promises.readdir(path.join(dir, "items")).catch(() => [] as string[]);
    if (files.length === 0)
      files = await fs.promises.readdir(path.join(dir, "models", "item")).catch(() => []);
    return files
      .filter((f) => f.endsWith(".json") && f !== "generated.json" && !f.startsWith("template_"))
      .map((f) => {
        const id = `minecraft:${f.slice(0, -5)}`;
        return { id, name: displayName(lang, id) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Absolute path of a texture for the HTTP route, or null if not allowed or not there. */
  textureFile(version: string, rel: string): string | null {
    if (!VERSION.test(version) || !this.isReady(version)) return null;
    if (!/^textures\/[a-z0-9_./-]+\.png$/.test(rel) || rel.includes("..")) return null;
    const file = path.join(this.dir(version), ...rel.split("/"));
    return fs.existsSync(file) ? file : null;
  }

  /** Remove versions no server uses; skips any being prepared right now. */
  async gc(used: Set<string>): Promise<Array<{ version: string; sizeBytes: number }>> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const removed: Array<{ version: string; sizeBytes: number }> = [];
    for (const e of entries) {
      if (!e.isDirectory() || used.has(e.name) || this.#preparing.has(e.name)) continue;
      const dir = path.join(this.root, e.name);
      const sizeBytes = await dirBytes(dir);
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      this.#icons.delete(e.name);
      this.#lang.delete(e.name);
      this.#sizes.delete(e.name);
      removed.push({ version: e.name, sizeBytes });
      console.log(`[assets] removed unused Minecraft ${e.name} textures (${sizeBytes} bytes)`);
    }
    return removed;
  }

  async #prepare(version: string, dir: string): Promise<string> {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
    const jar = path.join(dir, "client.jar");
    try {
      const client = await clientJarFor(version);
      await downloadFile(client.url, jar, { sha1: client.sha1 });
      const files = await extract(jar, dir);
      await fs.promises.rm(jar, { force: true });
      await fs.promises.writeFile(path.join(dir, COMPLETE), `${files} files from ${client.url}\n`);
      console.log(`[assets] Minecraft ${version}: kept ${files} texture, model and language files`);
      return dir;
    } catch (err) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Could not get Minecraft ${version} textures: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  #reader(version: string): AssetReader {
    const dir = this.dir(version);
    let sizes = this.#sizes.get(version);
    if (!sizes) {
      sizes = new Map();
      this.#sizes.set(version, sizes);
    }
    const sizeCache = sizes;
    return {
      json(rel) {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8"));
        } catch {
          return null;
        }
      },
      textureSize(texture) {
        if (sizeCache.has(texture)) return sizeCache.get(texture) ?? null;
        const size = pngSize(path.join(dir, "textures", ...`${texture}.png`.split("/")));
        sizeCache.set(texture, size);
        return size;
      },
    };
  }

  #langFor(version: string): Record<string, string> {
    let lang = this.#lang.get(version);
    if (!lang) {
      try {
        lang = JSON.parse(
          fs.readFileSync(path.join(this.dir(version), "lang", "en_us.json"), "utf8"),
        );
      } catch {
        lang = {};
      }
      this.#lang.set(version, lang ?? {});
    }
    return lang ?? {};
  }
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

async function extract(jar: string, dir: string): Promise<number> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(jar, { lazyEntries: true, autoClose: true }, (err, z) =>
      err || !z ? reject(err ?? new Error("cannot open client jar")) : resolve(z),
    ),
  );
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const rel = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null;
      if (
        !rel ||
        name.endsWith("/") ||
        rel.includes("..") ||
        !KEEP.some((k) => rel.startsWith(k))
      ) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          reject(err ?? new Error(`cannot read ${name}`));
          return;
        }
        const target = path.join(dir, ...rel.split("/"));
        fs.promises
          .mkdir(path.dirname(target), { recursive: true })
          .then(() => pipeline(stream, fs.createWriteStream(target)))
          .then(() => {
            count++;
            zip.readEntry();
          }, reject);
      });
    });
    zip.readEntry();
  });
  return count;
}

async function dirBytes(p: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirBytes(full);
    else total += (await fs.promises.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
