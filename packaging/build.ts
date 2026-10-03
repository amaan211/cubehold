/**
 * Release builds of cubehold.
 *
 *   pnpm dist                        build/app: the panel as a plain Node package
 *                                    (server.mjs, agent.mjs, web/, drizzle/, package.json).
 *                                    The Docker image installs its native modules itself.
 *   pnpm dist --target win-x64       plus Node.js and the native modules for Windows:
 *                                    build/win-x64/cubehold (the installed layout: cubehold.exe
 *                                    and app-<version>/), a zip of it, and the installer
 *                                    build/cubehold-setup-<version>.exe (Windows only).
 *   pnpm dist --target linux-x64     build/cubehold-<version>-linux-x64.tar.gz; also
 *                                    linux-arm64 and darwin-arm64.
 *
 * Downloads (Node.js, Inno Setup) are verified and cached in .cache/.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import { build } from "esbuild";
import yazl from "yazl";
import { AGENT_BUNDLE_OPTIONS } from "../apps/server/src/hosts/bundle.ts";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "build");
const cache = path.join(root, ".cache");
const appDir = path.join(out, "app");
const version: string = readJson(path.join(root, "package.json")).version;
const nodeVersion = process.versions.node;
/** The installer compiler; its download is checked by its Authenticode signature. */
const INNO_SETUP = "6.7.3";

interface Target {
  os: "win32" | "linux" | "darwin";
  cpu: "x64" | "arm64";
  libc?: "glibc";
  /** Node.js download name, e.g. "linux-x64". */
  node: string;
}

const TARGETS: Record<string, Target> = {
  "win-x64": { os: "win32", cpu: "x64", node: "win-x64" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc", node: "linux-x64" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc", node: "linux-arm64" },
  // argon2 ships no prebuilt module for Intel Macs, so there is no darwin-x64.
  "darwin-arm64": { os: "darwin", cpu: "arm64", node: "darwin-arm64" },
};

const { values: args } = parseArgs({
  options: {
    target: { type: "string", multiple: true, default: [] },
    "no-installer": { type: "boolean", default: false },
  },
});

for (const t of args.target ?? []) {
  if (!TARGETS[t]) fail(`unknown target ${t}; one of ${Object.keys(TARGETS).join(", ")}`);
}

await buildApp();
for (const name of args.target ?? []) await buildTarget(name, TARGETS[name] as Target);
log("done");

// --- the app ------------------------------------------------------------------

async function buildApp(): Promise<void> {
  log(`cubehold ${version}: building the app (Node ${nodeVersion})`);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  // Web app. Vite writes apps/web/dist; the route tree is generated on the way.
  const web = path.join(root, "apps/web");
  run(
    process.execPath,
    [path.join(web, "node_modules/vite/bin/vite.js"), "build", "--sourcemap", "false"],
    web,
  );
  fs.cpSync(path.join(web, "dist"), path.join(appDir, "web"), { recursive: true });

  // The panel. Native modules stay outside the bundle and are installed per platform.
  const serverDir = path.join(root, "apps/server");
  await build({
    entryPoints: [path.join(serverDir, "src/cli.ts")],
    outfile: path.join(appDir, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
    define: { __CUBEHOLD_DIST__: "true", __CUBEHOLD_VERSION__: JSON.stringify(version) },
    external: [
      "argon2",
      "libsql",
      // Only used when running from source.
      "esbuild",
      "tsx",
      "pino-pretty",
      // Optional native speedups; their packages fall back to JavaScript.
      "cpu-features",
      "bufferutil",
      "utf-8-validate",
      "*.node",
    ],
    // CommonJS dependencies call require() and read __dirname (ssh2 among them).
    banner: {
      js: [
        "import { createRequire as __cubeholdRequire } from 'node:module';",
        "const require = __cubeholdRequire(import.meta.url);",
        "const __filename = import.meta.filename;",
        "const __dirname = import.meta.dirname;",
      ].join(" "),
    },
  });

  // The agent: the same bundle remote hosts receive and the local daemon runs.
  await build({
    ...AGENT_BUNDLE_OPTIONS,
    external: [...AGENT_BUNDLE_OPTIONS.external],
    entryPoints: [path.join(root, "apps/agent/src/daemon.ts")],
    outfile: path.join(appDir, "agent.mjs"),
    logLevel: "warning",
  });

  fs.cpSync(path.join(serverDir, "drizzle"), path.join(appDir, "drizzle"), { recursive: true });

  const req = createRequire(path.join(serverDir, "package.json"));
  const libsqlFrom = createRequire(realPackageDir(serverDir, "@libsql/client"));
  const natives = {
    argon2: packageVersion(req, "argon2"),
    libsql: packageVersion(libsqlFrom, "libsql"),
  };
  writeJson(path.join(appDir, "package.json"), {
    name: "cubehold",
    version,
    description:
      "Self-hosted Minecraft server manager for this computer, any VPS, and your cloud accounts.",
    type: "module",
    bin: { cubehold: "server.mjs" },
    engines: { node: ">=24" },
    dependencies: natives,
  });
  writeNotices();
  // Runnable in place (`node build/app/server.mjs`, the e2e tests, the Docker image).
  installNatives(appDir, hostTarget());
  log(
    `app: ${path.relative(root, appDir)} (server.mjs ${size(path.join(appDir, "server.mjs"))}, agent.mjs ${size(path.join(appDir, "agent.mjs"))})`,
  );
}

/**
 * Licenses of everything the release contains: the bundled panel and agent,
 * the web app, and the native modules.
 */
function writeNotices(): void {
  const argv = [
    "licenses",
    "list",
    "--prod",
    "--json",
    "--filter",
    "@cubehold/server",
    "--filter",
    "@cubehold/web",
  ];
  // pnpm runs this script and says where it is; it may be a JS file or a native binary.
  const pnpm = process.env.npm_execpath;
  const res = spawnSync(
    pnpm ? (/\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm) : "pnpm",
    pnpm && /\.[cm]?js$/.test(pnpm) ? [pnpm, ...argv] : argv,
    { cwd: root, encoding: "utf8", shell: !pnpm, maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    log("warning: could not list licenses; THIRD-PARTY-NOTICES.txt left out");
    return;
  }
  const byLicense = JSON.parse(res.stdout) as Record<
    string,
    Array<{ name: string; versions: string[]; paths: string[]; license: string }>
  >;
  const parts: string[] = ["cubehold includes the following third-party software.\n"];
  const all = Object.values(byLicense)
    .flat()
    .filter((p) => !p.name.startsWith("@cubehold/"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const pkg of all) {
    const dir = pkg.paths[0];
    const file = dir
      ? fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
      : undefined;
    const text =
      dir && file
        ? fs.readFileSync(path.join(dir, file), "utf8").trim()
        : `License: ${pkg.license}`;
    parts.push(
      `${"-".repeat(72)}\n${pkg.name} ${pkg.versions.join(", ")} (${pkg.license})\n\n${text}\n`,
    );
  }
  fs.writeFileSync(path.join(appDir, "THIRD-PARTY-NOTICES.txt"), parts.join("\n"));
}

// --- platform builds -------------------------------------------------------------

async function buildTarget(name: string, t: Target): Promise<void> {
  log(`${name}: Node ${nodeVersion} and native modules`);
  const stage = path.join(out, name);
  fs.rmSync(stage, { recursive: true, force: true });
  // Windows installs keep each version in its own folder next to cubehold.exe, so an
  // update never replaces files an agent that still hosts servers is running from.
  const base =
    t.os === "win32"
      ? path.join(stage, "cubehold")
      : path.join(stage, `cubehold-${version}-${name}`);
  const dest = t.os === "win32" ? path.join(base, `app-${version}`) : base;
  fs.cpSync(appDir, dest, {
    recursive: true,
    filter: (src) => path.relative(appDir, src).split(path.sep)[0] !== "node_modules",
  });

  installNatives(dest, t);
  await addNode(dest, t);

  if (t.os === "win32") {
    fs.writeFileSync(
      path.join(dest, "cubehold.cmd"),
      '@echo off\r\n"%~dp0node\\node.exe" "%~dp0server.mjs" %*\r\n',
    );
    const tray = buildTray(base);
    if (!tray)
      log("warning: cubehold.exe (tray) needs Windows to build; the zip has cubehold.cmd only");
    await zipDir(base, path.join(out, `cubehold-${version}-${name}.zip`), "cubehold");
    if (tray && !args["no-installer"]) await buildInstaller(base);
  } else {
    const launcher = path.join(dest, "cubehold");
    fs.writeFileSync(
      launcher,
      '#!/bin/sh\nhere="$(cd "$(dirname "$0")" && pwd)"\nexec "$here/node/bin/node" "$here/server.mjs" "$@"\n',
      { mode: 0o755 },
    );
    if (t.os === "linux") {
      fs.cpSync(path.join(root, "packaging/linux"), path.join(dest, "extras"), { recursive: true });
    }
    const archive = path.join(out, `cubehold-${version}-${name}.tar.gz`);
    // Written here rather than with tar: a tar made on Windows loses the executable bits.
    await tarGz(base, archive, path.basename(base), new Set(["cubehold", "node/bin/node"]));
    log(`${name}: ${path.relative(root, archive)} (${size(archive)})`);
  }
}

function hostTarget(): Target {
  const os = process.platform as Target["os"];
  const cpu = process.arch as Target["cpu"];
  return { os, cpu, ...(os === "linux" ? { libc: "glibc" as const } : {}), node: `${os}-${cpu}` };
}

/** npm picks the platform's prebuilt argon2 and libsql modules for the target. */
function installNatives(dest: string, t: Target): void {
  const flags = [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    `--os=${t.os}`,
    `--cpu=${t.cpu}`,
    ...(t.libc ? [`--libc=${t.libc}`] : []),
  ];
  // npm's own script next to this Node (Windows: <node>/node_modules, Unix: <prefix>/lib/node_modules).
  const npmCli = [
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find((f) => fs.existsSync(f));
  if (!npmCli) fail("npm was not found next to this Node.js");
  run(process.execPath, [npmCli, ...flags], dest);
  const libsql = fs
    .readdirSync(path.join(dest, "node_modules/@libsql"))
    .filter((d) => d.startsWith(`${t.os}-`));
  if (libsql.length === 0) fail(`no libsql module for ${t.os}-${t.cpu} was installed`);
  const prebuild = path.join(dest, "node_modules/argon2/prebuilds", `${t.os}-${t.cpu}`);
  if (!fs.existsSync(prebuild)) fail(`argon2 has no prebuilt module for ${t.os}-${t.cpu}`);
}

/** The official Node.js build, checked against nodejs.org's SHASUMS256.txt. */
async function addNode(dest: string, t: Target): Promise<void> {
  const ext = t.os === "win32" ? "zip" : "tar.gz";
  const file = `node-v${nodeVersion}-${t.node}.${ext}`;
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const archive = await download(`${base}/${file}`, path.join(cache, "node", file), async () => {
    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${file}`));
    if (!line) fail(`${file} is not listed in SHASUMS256.txt`);
    return line.split(/\s+/)[0] as string;
  });
  const tmp = path.join(cache, "node", `x-${t.node}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // Only the runtime and its license: the rest includes symlinks Windows' tar cannot create.
  const top = path.join(tmp, `node-v${nodeVersion}-${t.node}`);
  const members = [t.os === "win32" ? "node.exe" : "bin/node", "LICENSE"].map(
    (m) => `node-v${nodeVersion}-${t.node}/${m}`,
  );
  run("tar", ["-xf", archive, "-C", tmp, ...members], root);
  const nodeDir = path.join(dest, "node");
  fs.mkdirSync(nodeDir, { recursive: true });
  if (t.os === "win32") {
    fs.copyFileSync(path.join(top, "node.exe"), path.join(nodeDir, "node.exe"));
  } else {
    fs.mkdirSync(path.join(nodeDir, "bin"));
    fs.copyFileSync(path.join(top, "bin/node"), path.join(nodeDir, "bin/node"));
    fs.chmodSync(path.join(nodeDir, "bin/node"), 0o755);
  }
  fs.copyFileSync(path.join(top, "LICENSE"), path.join(nodeDir, "LICENSE"));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Windows ----------------------------------------------------------------------

/**
 * The tray app, compiled with the C# compiler that ships with the .NET
 * Framework in every Windows 10/11, so it needs no SDK to build or runtime to
 * install. Returns false when not on Windows.
 */
function buildTray(base: string): boolean {
  const csc = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  );
  if (process.platform !== "win32" || !fs.existsSync(csc)) return false;
  const src = path.join(root, "packaging/windows");
  const tmp = path.join(out, "tray");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const numeric = `${version.replace(/[^0-9.].*$/, "")}.0`;
  fs.writeFileSync(
    path.join(tmp, "AssemblyInfo.cs"),
    [
      "using System.Reflection;",
      '[assembly: AssemblyTitle("cubehold")]',
      '[assembly: AssemblyProduct("cubehold")]',
      '[assembly: AssemblyDescription("Minecraft server manager")]',
      `[assembly: AssemblyVersion("${numeric}")]`,
      `[assembly: AssemblyFileVersion("${numeric}")]`,
      `[assembly: AssemblyInformationalVersion("${version}")]`,
      "",
    ].join("\r\n"),
  );
  run(
    csc,
    [
      "/nologo",
      "/target:winexe",
      "/optimize+",
      "/platform:anycpu",
      "/codepage:65001",
      `/out:${path.join(base, "cubehold.exe")}`,
      `/win32icon:${path.join(root, "packaging/assets/icon.ico")}`,
      // The tray icon, loaded at the small-icon size Windows asks for.
      `/resource:${path.join(root, "packaging/assets/icon.ico")},cubehold.ico`,
      `/win32manifest:${path.join(src, "app.manifest")}`,
      "/reference:System.dll",
      "/reference:System.Drawing.dll",
      "/reference:System.Windows.Forms.dll",
      path.join(src, "cubehold.cs"),
      path.join(tmp, "AssemblyInfo.cs"),
    ],
    root,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  return true;
}

async function buildInstaller(base: string): Promise<void> {
  const iscc = await innoSetup();
  run(
    iscc,
    [
      "/Q",
      `/DAppVersion=${version}`,
      `/DSourceDir=${base}`,
      `/DOutputDir=${out}`,
      `/DIconFile=${path.join(root, "packaging/assets/icon.ico")}`,
      path.join(root, "packaging/windows/cubehold.iss"),
    ],
    root,
  );
  const setup = path.join(out, `cubehold-setup-${version}.exe`);
  log(`installer: ${path.relative(root, setup)} (${size(setup)})`);
}

/**
 * Inno Setup's compiler, unpacked from the official, signed installer in its
 * portable mode (no Start menu entries, no uninstaller, nothing registered).
 */
async function innoSetup(): Promise<string> {
  const dir = path.join(cache, `innosetup-${INNO_SETUP}`);
  const iscc = path.join(dir, "ISCC.exe");
  if (fs.existsSync(iscc)) return iscc;
  const setup = path.join(cache, `innosetup-${INNO_SETUP}.exe`);
  if (!fs.existsSync(setup)) {
    log(`downloading Inno Setup ${INNO_SETUP}`);
    const tag = `is-${INNO_SETUP.replaceAll(".", "_")}`;
    const res = await fetch(
      `https://github.com/jrsoftware/issrc/releases/download/${tag}/innosetup-${INNO_SETUP}.exe`,
    );
    if (!res.ok) fail(`Inno Setup download failed: HTTP ${res.status}`);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(setup, Buffer.from(await res.arrayBuffer()));
  }
  const signer = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$s = Get-AuthenticodeSignature -LiteralPath '${setup}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
    ],
    { encoding: "utf8" },
  ).trim();
  // The publisher jrsoftware.org/isdl-verify.php names for Inno Setup 6.4.2 and later.
  if (!signer.startsWith("Valid|") || !/CN=Pyrsys B\.V\./.test(signer)) {
    fs.rmSync(setup, { force: true });
    fail(`Inno Setup installer signature is not valid: ${signer}`);
  }
  log(`installing Inno Setup portably into ${path.relative(root, dir)}`);
  run(
    setup,
    [
      "/PORTABLE=1",
      "/CURRENTUSER",
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/NOICONS",
      `/DIR=${dir}`,
    ],
    root,
  );
  if (!fs.existsSync(iscc)) fail("Inno Setup did not unpack ISCC.exe");
  return iscc;
}

// --- helpers ----------------------------------------------------------------------

async function download(url: string, file: string, sha256: () => Promise<string>): Promise<string> {
  const expected = (await sha256()).toLowerCase();
  if (fs.existsSync(file) && hashFile(file) === expected) return file;
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`download failed: HTTP ${res.status} for ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) fail(`checksum mismatch for ${url}: ${actual} != ${expected}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function zipDir(dir: string, file: string, prefix: string): Promise<void> {
  const zip = new yazl.ZipFile();
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(a, r);
      else zip.addFile(a, r);
    }
  };
  walk(dir, prefix);
  zip.end();
  fs.rmSync(file, { force: true });
  return new Promise((resolve, reject) => {
    zip.outputStream
      .pipe(fs.createWriteStream(file))
      .on("close", () => {
        log(`zip: ${path.relative(root, file)} (${size(file)})`);
        resolve();
      })
      .on("error", reject);
  });
}

/**
 * A .tar.gz with Unix permissions set explicitly: 0755 for folders and the
 * given executables (relative paths), 0644 for everything else, owned by root.
 */
async function tarGz(
  dir: string,
  file: string,
  prefix: string,
  executables: Set<string>,
): Promise<void> {
  fs.rmSync(file, { force: true });
  const gzip = zlib.createGzip({ level: 9 });
  const done = pipeline(gzip, fs.createWriteStream(file));
  const write = (b: Buffer) =>
    new Promise<void>((resolve) =>
      gzip.write(b) ? resolve() : gzip.once("drain", () => resolve()),
    );
  const mtime = Math.floor(Date.now() / 1000);
  const walk = async (abs: string, rel: string): Promise<void> => {
    await write(tarHeader(`${prefix}/${rel}${rel ? "/" : ""}`, 0o755, 0, "5", mtime));
    for (const e of fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(a, r);
        continue;
      }
      const data = fs.readFileSync(a);
      await write(
        tarHeader(`${prefix}/${r}`, executables.has(r) ? 0o755 : 0o644, data.length, "0", mtime),
      );
      await write(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) await write(Buffer.alloc(pad));
    }
  };
  await walk(dir, "");
  await write(Buffer.alloc(1024));
  gzip.end();
  await done;
}

/** A USTAR header; names up to 255 characters (split into prefix and name). */
function tarHeader(
  name: string,
  mode: number,
  bytes: number,
  type: "0" | "5",
  mtime: number,
): Buffer {
  const h = Buffer.alloc(512);
  let base = name;
  let pre = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", name.endsWith("/") ? name.length - 2 : name.length - 1);
    pre = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(pre) > 155)
      fail(`path too long for tar: ${name}`);
  }
  const put = (value: string, offset: number, length: number) =>
    h.write(value, offset, length, "utf8");
  put(base, 0, 100);
  put(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${bytes.toString(8).padStart(11, "0")}\0`, 124, 12);
  put(`${mtime.toString(8).padStart(11, "0")}\0`, 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put("root", 265, 32);
  put("root", 297, 32);
  put(pre, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

function realPackageDir(fromDir: string, name: string): string {
  return path.join(fs.realpathSync(path.join(fromDir, "node_modules", name)), "package.json");
}

function packageVersion(req: NodeJS.Require, name: string): string {
  // Some packages do not export package.json; find it from the entry point.
  let dir = path.dirname(req.resolve(name));
  while (
    !fs.existsSync(path.join(dir, "package.json")) ||
    readJson(path.join(dir, "package.json")).name !== name
  ) {
    const up = path.dirname(dir);
    if (up === dir) fail(`cannot find ${name}'s package.json`);
    dir = up;
  }
  return readJson(path.join(dir, "package.json")).version;
}

function run(cmd: string, argv: string[], cwd: string, opts: { shell?: boolean } = {}): void {
  const res = spawnSync(cmd, argv, { cwd, stdio: "inherit", shell: opts.shell ?? false });
  if (res.status !== 0)
    fail(`${path.basename(cmd)} ${argv[0] ?? ""} failed (exit ${res.status ?? res.error})`);
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function size(file: string): string {
  const bytes = fs.statSync(file).size;
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function log(msg: string): void {
  console.log(`[dist] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[dist] ${msg}`);
  process.exit(1);
}
