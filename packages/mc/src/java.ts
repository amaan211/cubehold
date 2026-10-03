import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { downloadFile, fetchJson } from "./http.js";

const execFileAsync = promisify(execFile);

/**
 * Fallback Java requirement for versions whose Mojang JSON predates the
 * `javaVersion` field. Prefer the JSON value whenever available.
 */
export function fallbackJavaMajor(mcVersion: string): number {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mcVersion);
  if (!m) return 21;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major >= 26) return 25; // year-based versions (26.x+) require Java 25
  if (major === 1) {
    if (minor < 17) return 8;
    if (minor === 17) return 16;
    if (minor < 20 || (minor === 20 && patch <= 4)) return 17;
    return 21;
  }
  return 21;
}

export type JavaPlatform = { os: "windows" | "linux" | "mac"; arch: "x64" | "aarch64" };

export function currentPlatform(): JavaPlatform {
  const p = process.platform;
  const a = process.arch;
  return {
    os: p === "win32" ? "windows" : p === "darwin" ? "mac" : "linux",
    arch: a === "arm64" ? "aarch64" : "x64",
  };
}

interface AdoptiumAsset {
  binary: {
    image_type: string;
    package: { checksum: string; link: string; name: string; size: number };
  };
  release_name: string;
  version: { semver: string };
}

export interface JavaRuntime {
  major: number;
  /** Absolute path to the java executable. */
  javaPath: string;
  /** Root directory of the extracted runtime. */
  home: string;
  releaseName: string | null;
}

export interface EnsureJavaOptions {
  onProgress?: (message: string, percent: number | null) => void;
  platform?: JavaPlatform;
}

/**
 * Find or download a JRE for the given major version under `javaDir/<major>`.
 * Downloads come from Adoptium (Eclipse Temurin) with SHA-256 verification.
 */
export async function ensureJava(
  javaDir: string,
  major: number,
  opts: EnsureJavaOptions = {},
): Promise<JavaRuntime> {
  const root = path.join(javaDir, String(major));
  const existing = await findJavaBinary(root);
  if (existing) {
    return {
      major,
      javaPath: existing,
      home: path.dirname(path.dirname(existing)),
      releaseName: readReleaseName(root),
    };
  }

  const platform = opts.platform ?? currentPlatform();
  opts.onProgress?.(`Looking up Java ${major} for ${platform.os}/${platform.arch}`, null);
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${platform.os}&architecture=${platform.arch}&image_type=jre&vendor=eclipse`;
  const assets = await fetchJson<AdoptiumAsset[]>(url);
  const asset = assets.find((a) => a.binary.image_type === "jre") ?? assets[0];
  if (!asset)
    throw new Error(
      `No Java ${major} runtime available from Adoptium for ${platform.os}/${platform.arch}`,
    );

  const pkg = asset.binary.package;
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const archive = path.join(root, pkg.name);

  opts.onProgress?.(`Downloading ${pkg.name}`, 0);
  await downloadFile(pkg.link, archive, {
    sha256: pkg.checksum,
    onProgress: (received, total) => {
      const pct = total ? Math.round((received / total) * 100) : null;
      opts.onProgress?.(
        `Downloading ${pkg.name} (${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""})`,
        pct,
      );
    },
  });

  opts.onProgress?.("Extracting Java runtime", null);
  await extractArchive(archive, root);
  await fs.promises.rm(archive, { force: true });
  await fs.promises.writeFile(path.join(root, ".release"), asset.release_name, "utf8");

  const javaPath = await findJavaBinary(root);
  if (!javaPath)
    throw new Error(`Java ${major} was extracted but no java binary was found under ${root}`);
  opts.onProgress?.(`Java ${major} ready (${asset.release_name})`, 100);
  return {
    major,
    javaPath,
    home: path.dirname(path.dirname(javaPath)),
    releaseName: asset.release_name,
  };
}

/**
 * Both Windows (bsdtar) and Linux/macOS ship a `tar` that understands the
 * archive formats Adoptium uses (zip on Windows, tar.gz elsewhere).
 */
async function extractArchive(archive: string, dest: string): Promise<void> {
  // Run inside `dest` with a relative archive name: Windows bsdtar reads an
  // absolute `C:\...` path as host:path and tries to connect to "C".
  // On Windows use the built-in bsdtar explicitly: a GNU tar earlier on PATH
  // (Git for Windows, MSYS) cannot read zip archives.
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  await execFileAsync(tar, ["-xf", path.basename(archive)], {
    cwd: dest,
    windowsHide: true,
    maxBuffer: 1 << 20,
  });
}

function readReleaseName(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, ".release"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Locate bin/java(.exe) under a runtime folder. Windows and Linux archives
 * unpack to jdk-…/bin/java, macOS ones to jdk-…/Contents/Home/bin/java.
 */
export async function findJavaBinary(
  root: string,
  exe = process.platform === "win32" ? "java.exe" : "java",
): Promise<string | null> {
  const candidates = [root];
  // root, jdk-…, Contents, Home: four levels of folders that may hold bin/.
  for (let depth = 0; depth < 4; depth++) {
    const next: string[] = [];
    for (const dir of candidates.splice(0)) {
      const direct = path.join(dir, "bin", exe);
      if (await exists(direct)) return direct;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory()) next.push(path.join(dir, e.name));
    }
    candidates.push(...next);
    if (candidates.length === 0) break;
  }
  return null;
}

/** Ask a java binary for its major version, e.g. 21. Returns null if it fails to run. */
export async function probeJavaMajor(javaPath: string): Promise<number | null> {
  try {
    const { stderr, stdout } = await execFileAsync(javaPath, ["-version"], { windowsHide: true });
    const m = /version "(\d+)(?:\.(\d+))?/.exec(stderr || stdout);
    if (!m) return null;
    const first = Number(m[1]);
    return first === 1 ? Number(m[2]) : first; // "1.8.0_392" -> 8
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function hostTotalMemoryMb(): number {
  return Math.round(os.totalmem() / 1024 / 1024);
}
