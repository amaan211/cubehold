import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  defaultPropertiesText,
  downloadFile,
  ensureJava,
  fallbackJavaMajor,
  formatBytes,
  type ResolvedDownload,
  resolveDownload,
  versionArtifacts,
} from "@cubehold/mc";
import { removeTree, renameWithRetry } from "./files.js";
import type { InitialFiles, InstallStep, StagedBinaries, StageRequest } from "./types.js";

/** Downloads land here first so a failed download never touches a working server. */
export const STAGING_DIR = ".cubehold-staging";

export type InstallReporter = (step: InstallStep, message: string, percent: number | null) => void;

/**
 * Resolve the jar for a version, make sure its Java runtime is installed, and
 * download the jar into the staging folder with checksum verification. Runs
 * on the host that will run the server, so nothing crosses the panel's link.
 */
export async function stageServerBinaries(
  javaDir: string,
  t: StageRequest,
  report: InstallReporter,
): Promise<StagedBinaries> {
  const staging = path.join(t.directory, STAGING_DIR);
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(staging, { recursive: true });

  report("download", `Resolving ${t.software} ${t.mcVersion}`, null);
  const resolved: ResolvedDownload = await resolveDownload(
    t.software,
    t.mcVersion,
    t.loaderVersion,
  );
  const javaMajor = resolved.javaMajor ?? fallbackJavaMajor(t.mcVersion);

  report("java", `Minecraft ${t.mcVersion} needs Java ${javaMajor}`, null);
  const java = await ensureJava(javaDir, javaMajor, {
    onProgress: (message, percent) => report("java", message, percent),
  });

  const stagedPath = path.join(staging, resolved.fileName);
  const label = `${resolved.fileName}${resolved.build ? ` (build ${resolved.build})` : ""}`;
  report("download", `Downloading ${label}`, 0);
  await downloadFile(resolved.url, stagedPath, {
    sha1: resolved.sha1,
    sha256: resolved.sha256,
    md5: resolved.md5,
    onProgress: (received, total) => {
      const pct = total ? Math.round((received / total) * 100) : null;
      report(
        "download",
        `Downloading ${resolved.fileName} (${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ""})`,
        pct,
      );
    },
  });

  if (resolved.installer) {
    return runInstaller(staging, stagedPath, java.javaPath, javaMajor, resolved, report);
  }
  return {
    javaMajor,
    jarFile: resolved.fileName,
    launch: "jar",
    stagedPath,
    entries: [resolved.fileName],
    build: resolved.build,
    recommendedJvmFlags: resolved.recommendedJvmFlags ?? null,
  };
}

/**
 * Forge and NeoForge: run the official installer in the staging folder. It
 * downloads Minecraft and the loader's libraries and writes either a launch
 * args file (1.17+) or a forge-*.jar (older), which the server then runs.
 */
async function runInstaller(
  staging: string,
  installerPath: string,
  javaPath: string,
  javaMajor: number,
  resolved: ResolvedDownload,
  report: InstallReporter,
): Promise<StagedBinaries> {
  const installer = resolved.installer as NonNullable<ResolvedDownload["installer"]>;
  const name = resolved.software === "neoforge" ? "NeoForge" : "Forge";
  report(
    "configure",
    `Running the ${name} ${resolved.build} installer (downloads the libraries)`,
    null,
  );
  await runJava(
    javaPath,
    ["-jar", path.basename(installerPath), "--installServer"],
    staging,
    (line) =>
      // Shown as progress, not logged to the console: the installer prints hundreds of lines.
      report("configure", `${name} installer: ${line.slice(0, 160)}`, 50),
  );
  for (const f of await fs.promises.readdir(staging)) {
    if (f === path.basename(installerPath) || /installer.*\.log$/i.test(f)) {
      await fs.promises.rm(path.join(staging, f), { force: true });
    }
  }
  let jarFile: string;
  let launch: "jar" | "argsFile";
  if (fs.existsSync(path.join(staging, installer.argsDir, "unix_args.txt"))) {
    jarFile = installer.argsDir;
    launch = "argsFile";
  } else {
    const jar = (await fs.promises.readdir(staging)).find(
      (f) => !!installer.jarPrefix && f.startsWith(installer.jarPrefix) && f.endsWith(".jar"),
    );
    if (!jar) throw new Error(`The ${name} installer finished but wrote no server to launch`);
    jarFile = jar;
    launch = "jar";
  }
  report("configure", `${name} ${resolved.build} installed`, null);
  return {
    javaMajor,
    jarFile,
    launch,
    stagedPath: installerPath,
    entries: await fs.promises.readdir(staging),
    build: resolved.build,
    recommendedJvmFlags: null,
  };
}

function runJava(
  javaPath: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail: string[] = [];
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 15) tail.shift();
        onLine(line.trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    // Installers download a few hundred MB at worst; give up after 30 minutes.
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`the installer failed (exit ${code}): ${tail.slice(-3).join(" / ")}`));
    });
  });
}

/**
 * Replace the server's binaries with the staged ones: remove the old jar and
 * everything it unpacked (libraries, versions, caches), then move the new jar
 * into place. Worlds, plugins, mods and configs are not touched.
 */
export async function commitServerBinaries(
  directory: string,
  staged: StagedBinaries,
  previousJar: string | undefined,
): Promise<void> {
  const staging = path.resolve(directory, STAGING_DIR);
  if (path.dirname(path.resolve(staged.stagedPath)) !== staging) {
    throw new Error("staged file is not in this server's staging folder");
  }
  const entries = staged.entries ?? [path.basename(staged.stagedPath)];
  for (const e of entries) {
    if (e !== path.basename(e) || e === "." || e === "..") throw new Error(`bad staged entry ${e}`);
  }
  const toRemove = new Set([...versionArtifacts(previousJar), ...entries]);
  for (const rel of toRemove) {
    await fs.promises.rm(path.join(directory, rel), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
  for (const e of entries) {
    await renameWithRetry(path.join(staging, e), path.join(directory, e));
  }
  await discardStaging(directory);
}

export async function discardStaging(directory: string): Promise<void> {
  await fs.promises.rm(path.join(directory, STAGING_DIR), { recursive: true, force: true });
}

/** EULA (the user consented in the wizard) and server.properties for a new server. */
export async function writeInitialFiles(t: InitialFiles): Promise<void> {
  await fs.promises.mkdir(t.directory, { recursive: true });
  await fs.promises.writeFile(
    path.join(t.directory, "eula.txt"),
    `#By changing the setting below to TRUE you are indicating your agreement to Mojang's EULA (https://aka.ms/MinecraftEULA).\n#Accepted via cubehold on ${new Date().toISOString()}\neula=true\n`,
    "utf8",
  );
  const propsPath = path.join(t.directory, "server.properties");
  if (!fs.existsSync(propsPath)) {
    await fs.promises.writeFile(
      propsPath,
      defaultPropertiesText({ port: t.port, motd: t.name, onlineMode: t.onlineMode }),
      "utf8",
    );
  }
}

/**
 * Remove Java runtimes under javaDir that are not in `keep` and that no
 * running process uses. Returns what was removed.
 */
export async function gcJavaRuntimes(
  javaDir: string,
  keep: number[],
  inUse: string[],
): Promise<Array<{ major: number; sizeBytes: number }>> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(javaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: Array<{ major: number; sizeBytes: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const major = Number(e.name);
    if (keep.includes(major)) continue;
    const dir = path.join(javaDir, e.name);
    if (inUse.some((p) => path.resolve(p).startsWith(path.resolve(dir) + path.sep))) continue;
    const sizeBytes = await treeSize(dir);
    try {
      await removeTree(dir);
      removed.push({ major, sizeBytes });
    } catch (err) {
      console.warn(`could not remove Java ${major}:`, err);
    }
  }
  return removed;
}

async function treeSize(p: string): Promise<number> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await fs.promises.readdir(p)) total += await treeSize(path.join(p, name));
  return total;
}

/** "Ubuntu 24.04.1 LTS" from /etc/os-release, or a generic name elsewhere. */
export function osName(): string | null {
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync("/etc/os-release", "utf8");
      const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text);
      if (m?.[1]) return m[1];
    } catch {
      // not there
    }
    return "Linux";
  }
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "macOS";
  return process.platform;
}

/** Total and free space on the disk holding `dir`, in MB. */
export async function diskSpace(dir: string): Promise<{ totalMb: number; freeMb: number } | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return {
      totalMb: Math.round((s.blocks * s.bsize) / 1024 / 1024),
      freeMb: Math.round((s.bavail * s.bsize) / 1024 / 1024),
    };
  } catch {
    return null;
  }
}
