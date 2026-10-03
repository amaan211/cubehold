import fs from "node:fs";
import path from "node:path";
import type { CopyResult, DirEntry, PathStat } from "./types.js";

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
export function safeResolve(root: string, rel: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, rel.replace(/^[/\\]+/, ""));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes server directory: ${rel}`);
  }
  return target;
}

export async function readFileSafe(
  root: string,
  rel: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const p = safeResolve(root, rel);
  const st = await fs.promises.stat(p);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (st.size > maxBytes)
    throw new Error(`File too large to open in the editor (${Math.round(st.size / 1024)} KB)`);
  return fs.promises.readFile(p, "utf8");
}

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename() that rides out Windows briefly locking a file (antivirus, the
 * search indexer, a process that just exited). Retries for about 2 seconds.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT.has(code) || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export async function writeFileSafe(root: string, rel: string, content: string): Promise<void> {
  const p = safeResolve(root, rel);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, content, "utf8");
  try {
    await renameWithRetry(tmp, p);
  } catch (err) {
    // Still locked against replacement: write in place (not atomic, but the
    // content is complete in memory) and drop the temp file.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!TRANSIENT.has(code)) throw err;
    await fs.promises.writeFile(p, content, "utf8");
    await fs.promises.rm(tmp, { force: true });
  }
}

export async function listDirSafe(root: string, rel: string): Promise<DirEntry[]> {
  const p = safeResolve(root, rel);
  const entries = await fs.promises.readdir(p, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    try {
      const st = await fs.promises.stat(path.join(p, e.name));
      out.push({
        name: e.name,
        kind: e.isDirectory() ? "dir" : "file",
        sizeBytes: e.isDirectory() ? 0 : st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    } catch {
      // broken symlink or race; skip
    }
  }
  return out.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Total size and file count under a path. Symlinks are counted, never followed. */
export async function measure(p: string): Promise<{ sizeBytes: number; files: number }> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return { sizeBytes: 0, files: 0 };
  }
  if (!st.isDirectory()) return { sizeBytes: st.size, files: 1 };
  let sizeBytes = 0;
  let files = 0;
  const entries = await fs.promises.readdir(p).catch(() => [] as string[]);
  for (const name of entries) {
    const m = await measure(path.join(p, name));
    sizeBytes += m.sizeBytes;
    files += m.files;
  }
  return { sizeBytes, files };
}

export async function statPaths(root: string, rels: string[]): Promise<PathStat[]> {
  const out: PathStat[] = [];
  for (const rel of rels) {
    const p = safeResolve(root, rel);
    let kind: PathStat["kind"] = null;
    try {
      kind = (await fs.promises.lstat(p)).isDirectory() ? "dir" : "file";
    } catch {
      out.push({ path: rel, exists: false, kind: null, sizeBytes: 0, files: 0 });
      continue;
    }
    out.push({ path: rel, exists: true, kind, ...(await measure(p)) });
  }
  return out;
}

/**
 * Copy entries of `srcRoot` into `destDir`, keeping their relative paths.
 * Missing sources are skipped. Existing targets are an error unless
 * `overwrite` is set, so an export never silently merges into old data.
 */
export async function copyInto(
  srcRoot: string,
  rels: string[],
  destDir: string,
  overwrite = false,
): Promise<CopyResult> {
  if (!path.isAbsolute(destDir)) throw new Error("Destination must be an absolute path");
  await fs.promises.mkdir(destDir, { recursive: true });
  let files = 0;
  let sizeBytes = 0;
  for (const rel of rels) {
    const src = safeResolve(srcRoot, rel);
    if (!(await exists(src))) continue;
    const dest = safeResolve(destDir, rel);
    if (!overwrite && (await exists(dest))) throw new Error(`${dest} already exists`);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.cp(src, dest, {
      recursive: true,
      force: overwrite,
      errorOnExist: !overwrite,
      preserveTimestamps: true,
    });
    const m = await measure(dest);
    files += m.files;
    sizeBytes += m.sizeBytes;
  }
  return { files, sizeBytes };
}

export async function removePaths(root: string, rels: string[]): Promise<void> {
  for (const rel of rels) {
    const p = safeResolve(root, rel);
    if (p === path.resolve(root)) throw new Error("Refusing to remove the root itself");
    await fs.promises.rm(p, RM_OPTIONS);
  }
}

/**
 * Delete a whole directory tree and confirm it is gone. Retries cover Windows
 * briefly holding files after a process exits.
 */
export async function removeTree(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  const depth = resolved.slice(root.length).split(path.sep).filter(Boolean).length;
  if (resolved === root || depth < 2) throw new Error(`Refusing to delete ${resolved}`);
  await fs.promises.rm(resolved, RM_OPTIONS);
  if (await exists(resolved)) throw new Error(`Could not fully delete ${resolved}`);
}
