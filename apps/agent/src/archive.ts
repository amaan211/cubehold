import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { renameWithRetry, safeResolve } from "./files.js";

export interface ZipResult {
  files: number;
  /** Uncompressed bytes. */
  sizeBytes: number;
  /** Size of the zip itself (0 when streamed). */
  zipBytes: number;
}

export type ProgressFn = (done: number, total: number | null) => void;

/** Already-compressed formats: storing them is as small and much faster. */
const STORE = /\.(mca|mcc|jar|zip|gz|png|jpg|ogg|mp3|7z|xz|zst)$/i;

interface FileItem {
  abs: string;
  /** Path inside the zip, always forward slashes. */
  name: string;
  size: number;
  mtime: Date;
  mode: number;
}

/**
 * Files under `rels` (relative to root), depth first. Directories that end up
 * empty are recorded so they survive a round trip. Symlinks are skipped:
 * following them could leave the server folder.
 */
async function collect(
  root: string,
  rels: string[],
  skip: (name: string) => boolean,
): Promise<{ files: FileItem[]; emptyDirs: string[] }> {
  const files: FileItem[] = [];
  const emptyDirs: string[] = [];
  const walk = async (abs: string, name: string): Promise<void> => {
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(abs);
    } catch {
      return; // vanished while walking
    }
    if (st.isSymbolicLink() || skip(path.basename(abs))) return;
    if (st.isDirectory()) {
      const entries = await fs.promises.readdir(abs);
      if (entries.length === 0) emptyDirs.push(`${name}/`);
      for (const e of entries.sort()) await walk(path.join(abs, e), `${name}/${e}`);
      return;
    }
    if (st.isFile()) files.push({ abs, name, size: st.size, mtime: st.mtime, mode: st.mode });
  };
  for (const rel of rels) {
    const abs = safeResolve(root, rel);
    await walk(abs, rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
  }
  return { files, emptyDirs };
}

/**
 * Write a zip of `rels` (relative to srcRoot) to `out`. Streams file by file,
 * so memory stays flat for worlds of any size; ZIP64 is used when needed.
 */
async function writeZip(
  srcRoot: string,
  rels: string[],
  out: Writable,
  opts: { skipNames?: string[]; onProgress?: ProgressFn },
): Promise<{ files: number; sizeBytes: number }> {
  const skip = new Set((opts.skipNames ?? []).map((n) => n.toLowerCase()));
  const { files, emptyDirs } = await collect(srcRoot, rels, (n) => skip.has(n.toLowerCase()));
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - lastReport > 500) {
      lastReport = now;
      opts.onProgress?.(done, total);
    }
  };

  const zip = new yazl.ZipFile();
  for (const dir of emptyDirs) zip.addEmptyDirectory(dir);
  for (const f of files) {
    zip.addReadStreamLazy(
      f.name,
      { mtime: f.mtime, mode: f.mode, compress: !STORE.test(f.name) },
      (cb) => {
        const counter = new PassThrough();
        counter.on("data", (chunk: Buffer) => {
          done += chunk.length;
          report();
        });
        const src = fs.createReadStream(f.abs);
        src.on("error", (err) => counter.destroy(err));
        src.pipe(counter);
        cb(null, counter);
      },
    );
  }
  zip.end();
  await pipeline(zip.outputStream as NodeJS.ReadableStream, out);
  report(true);
  return { files: files.length, sizeBytes: total };
}

/** Zip `rels` into `destFile` (absolute). Written to a temp file and renamed when complete. */
export async function createZip(
  srcRoot: string,
  rels: string[],
  destFile: string,
  opts: { skipNames?: string[]; onProgress?: ProgressFn } = {},
): Promise<ZipResult> {
  if (!path.isAbsolute(destFile)) throw new Error("Archive path must be absolute");
  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.part`;
  try {
    const r = await writeZip(srcRoot, rels, fs.createWriteStream(tmp), opts);
    await renameWithRetry(tmp, destFile);
    const zipBytes = (await fs.promises.stat(destFile)).size;
    return { ...r, zipBytes };
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

/** Zip straight into a stream (folder downloads). */
export function streamZip(
  srcRoot: string,
  rels: string[],
  out: Writable,
  opts: { skipNames?: string[] } = {},
): Promise<{ files: number; sizeBytes: number }> {
  return writeZip(srcRoot, rels, out, opts);
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      file,
      // autoClose off: entries are listed first and read afterwards; callers close.
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false,
      },
      (err, zip) => (err || !zip ? reject(err ?? new Error("cannot open zip")) : resolve(zip)),
    ),
  );
}

/** List entries without extracting them. */
async function entries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const out: yauzl.Entry[] = [];
    zip.on("entry", (e: yauzl.Entry) => {
      out.push(e);
      zip.readEntry();
    });
    zip.once("end", () => resolve(out));
    zip.once("error", reject);
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, stream) =>
      err || !stream ? reject(err ?? new Error("cannot read entry")) : resolve(stream),
    ),
  );
}

/**
 * Extract a zip into destDir. Entry names are checked against the target
 * (no "zip slip"), free disk space is checked first, and existing files are
 * only replaced with `overwrite`.
 */
export async function extractZip(
  zipFile: string,
  destDir: string,
  opts: { overwrite?: boolean; onProgress?: ProgressFn } = {},
): Promise<{ files: number; sizeBytes: number }> {
  const zip = await openZip(zipFile);
  try {
    const list = await entries(zip);
    const total = list.reduce((n, e) => n + (e.fileName.endsWith("/") ? 0 : e.uncompressedSize), 0);
    await fs.promises.mkdir(destDir, { recursive: true });
    const fsStat = await fs.promises.statfs(destDir).catch(() => null);
    if (fsStat && fsStat.bavail * fsStat.bsize < total) {
      throw new Error(
        `Not enough disk space: the archive needs ${Math.ceil(total / 1024 / 1024)} MB`,
      );
    }
    let files = 0;
    let done = 0;
    let lastReport = 0;
    for (const e of list) {
      const target = safeResolve(destDir, e.fileName);
      if (e.fileName.endsWith("/")) {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      if (!opts.overwrite && fs.existsSync(target)) {
        throw new Error(`${e.fileName} already exists`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const src = await openEntry(zip, e);
      const counter = new PassThrough();
      counter.on("data", (chunk: Buffer) => {
        done += chunk.length;
        const now = Date.now();
        if (now - lastReport > 500) {
          lastReport = now;
          opts.onProgress?.(done, total);
        }
      });
      await pipeline(src, counter, fs.createWriteStream(target));
      const mtime = e.getLastModDate();
      await fs.promises.utimes(target, mtime, mtime).catch(() => {});
      files++;
    }
    opts.onProgress?.(total, total);
    return { files, sizeBytes: total };
  } finally {
    zip.close();
  }
}

/** Names of the top-level entries in a zip (used to know what a restore replaces). */
export async function zipTopLevel(zipFile: string): Promise<string[]> {
  const zip = await openZip(zipFile);
  try {
    const names = new Set<string>();
    for (const e of await entries(zip)) {
      const top = e.fileName.split("/")[0];
      if (top) names.add(top);
    }
    return [...names];
  } finally {
    zip.close();
  }
}

/** Read one small entry (plugin.yml, fabric.mod.json) from a zip/jar. */
export async function readZipEntry(
  zipFile: string,
  names: string[],
  maxBytes = 256 * 1024,
): Promise<{ name: string; text: string } | null> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(zipFile);
  } catch {
    return null; // not a zip
  }
  try {
    const wanted = new Set(names);
    for (const e of await entries(zip)) {
      if (!wanted.has(e.fileName) || e.uncompressedSize > maxBytes) continue;
      const stream = await openEntry(zip, e);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      return { name: e.fileName, text: Buffer.concat(chunks).toString("utf8") };
    }
    return null;
  } finally {
    zip.close();
  }
}

export interface JarMeta {
  kind: "plugin" | "mod" | null;
  /** Plugin name / mod id; plugin config folders are named after it. */
  id: string | null;
  name: string | null;
  version: string | null;
  description: string | null;
}

const META_FILES = [
  "paper-plugin.yml",
  "plugin.yml",
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/neoforge.mods.toml",
  "META-INF/mods.toml",
];

export async function inspectJar(file: string): Promise<JarMeta> {
  const empty: JarMeta = { kind: null, id: null, name: null, version: null, description: null };
  const entry = await readZipEntry(file, META_FILES).catch(() => null);
  if (!entry) return empty;
  if (entry.name.endsWith(".yml")) {
    const y = yamlScalars(entry.text);
    return {
      kind: "plugin",
      id: y.name ?? null,
      name: y.name ?? null,
      version: y.version ?? null,
      description: y.description ?? null,
    };
  }
  if (entry.name.endsWith(".json")) {
    try {
      const j = JSON.parse(entry.text) as {
        id?: string;
        name?: string;
        version?: string;
        description?: string;
        quilt_loader?: { id?: string; version?: string; metadata?: { name?: string } };
      };
      return {
        kind: "mod",
        id: j.id ?? j.quilt_loader?.id ?? null,
        name: j.name ?? j.quilt_loader?.metadata?.name ?? j.id ?? null,
        version: j.version ?? j.quilt_loader?.version ?? null,
        description: typeof j.description === "string" ? j.description : null,
      };
    } catch {
      return { ...empty, kind: "mod" };
    }
  }
  const t = tomlStrings(entry.text);
  const version = t.version && !t.version.includes("${") ? t.version : null;
  return {
    kind: "mod",
    id: t.modId ?? null,
    name: t.displayName ?? t.modId ?? null,
    version,
    description: t.description ?? null,
  };
}

/** Top-level `key: value` pairs of a simple YAML document. */
function yamlScalars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2] as string;
    if (v.startsWith("|") || v.startsWith(">") || v.startsWith("[") || v.startsWith("{")) continue;
    v = v.replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (!((m[1] as string) in out)) out[m[1] as string] = v;
  }
  return out;
}

/** First occurrence of `key="value"` for each key in a mods.toml. */
function tomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*([A-Za-z]\w*)\s*=\s*["']([^"'\n]*)["']/gm)) {
    const k = m[1] as string;
    if (!(k in out)) out[k] = m[2] as string;
  }
  return out;
}

export async function hashFile(file: string): Promise<{ sha1: string; sha512: string }> {
  const sha1 = createHash("sha1");
  const sha512 = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) {
    sha1.update(chunk as Buffer);
    sha512.update(chunk as Buffer);
  }
  return { sha1: sha1.digest("hex"), sha512: sha512.digest("hex") };
}
