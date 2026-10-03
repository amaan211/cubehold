import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { downloadFile, ensureJava, parseProperties, propertiesToMap } from "@cubehold/mc";
import type { ServerStatus } from "@cubehold/shared";
import {
  classifyWan,
  defaultRouteAddress,
  externalIp,
  type FirewallFix,
  type FirewallSnapshot,
  isPrivateIPv4,
  lanAddresses,
  type MappingRequest,
  type MappingState,
  PortMapper,
  publicAddresses,
  readWindowsFirewall,
  runElevated,
  tailscaleAddress,
} from "@cubehold/tunnels";
import { createZip, extractZip, hashFile, inspectJar, zipTopLevel } from "./archive.js";
import {
  copyInto,
  listDirSafe,
  readFileSafe,
  removePaths,
  removeTree,
  renameWithRetry,
  safeResolve,
  statPaths,
  writeFileSafe,
} from "./files.js";
import {
  commitServerBinaries,
  discardStaging,
  diskSpace,
  gcJavaRuntimes,
  osName,
  stageServerBinaries,
  writeInitialFiles,
} from "./install.js";
import { ProcessSampler } from "./metrics.js";
import { Sleeper } from "./sleeper.js";
import { ServerProcess } from "./supervisor.js";
import { tailscaleFunnel, tailscaleInstall, tailscaleLogin, tailscaleStatus } from "./tailscale.js";
import { TunnelProcess } from "./tunnel-process.js";
import type {
  AgentApi,
  AgentEvent,
  AgentEventHandler,
  AgentLogLine,
  AgentPolicy,
  AgentSnapshot,
  ArchiveResult,
  CopyResult,
  DirEntry,
  FetchRequest,
  HostInfo,
  InitialFiles,
  InstallStep,
  JarInfo,
  LaunchRequest,
  NetworkInfo,
  PathStat,
  ProbeRequest,
  StagedBinaries,
  StageRequest,
  TailscaleStatus,
  TunnelKind,
  TunnelSpec,
  TunnelStatus,
  ZipOptions,
} from "./types.js";

/** True when `child` is `parent` or inside it. Case-insensitive on Windows. */
function isInside(parent: string, child: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a + path.sep);
}

const METRICS_INTERVAL_MS = 2_000;
const IDLE_CHECK_MS = 30_000;
const HISTORY_LINES = 500;
const LOGFILE_TAIL_BYTES = 64 * 1024;
const LOGFILE_TAIL_LINES = 200;

/** Crashes the agent restarts from on its own, and how long it waits before each attempt. */
const RESTART_WINDOW_MS = 10 * 60_000;
const RESTART_DELAYS_MS = [10_000, 30_000, 60_000];
/** Exit reasons a restart cannot fix. */
const NO_RESTART = new Set(["eula", "port_in_use", "outdated_java"]);

const TUNNEL_KINDS: TunnelKind[] = ["playit", "ngrok", "cloudflared"];

/** Reachability probes close by themselves after at most this long. */
const MAX_PROBE_MS = 3 * 60_000;
const NETWORK_TTL_MS = 60_000;

const DEFAULT_POLICY: AgentPolicy = { autoRestart: false, idleStopMinutes: 0, wakeOnJoin: false };

/** Per-server state that outlives a single process: policy, restarts, sleeping. */
interface Managed {
  req: LaunchRequest;
  proc: ServerProcess | null;
  crashes: number[];
  restartTimer: NodeJS.Timeout | null;
  sleeper: Sleeper | null;
  /** When the player count last dropped to zero while running. */
  emptySince: number | null;
}

/**
 * Runs Minecraft processes on this machine. Hosted by the agent daemon so
 * servers outlive panel restarts.
 */
export interface LocalAgentOptions {
  /** Waits before each automatic restart; the count is the restart budget. Tests shorten these. */
  restartDelaysMs?: number[];
  idleCheckMs?: number;
  /** Router port forwarding; tests pass a mapper with a fake router. */
  portMapper?: PortMapper;
  /** Where Java runtimes live (`<dataDir>/java`); reported to the panel in hostInfo. */
  dataDir?: string;
}

export class LocalAgent implements AgentApi {
  #servers = new Map<string, Managed>();
  #history = new Map<string, AgentLogLine[]>();
  #handlers = new Set<AgentEventHandler>();
  #sampler = new ProcessSampler();
  #timers: NodeJS.Timeout[] = [];
  #restartDelays: number[];
  #mapper: PortMapper;
  #tunnels = new Map<TunnelKind, TunnelProcess>();
  #probes = new Map<number, { sleeper: Sleeper; timer: NodeJS.Timeout }>();
  #network: { at: number; info: NetworkInfo } | null = null;
  #dataDir: string | null;

  constructor(opts: LocalAgentOptions = {}) {
    this.#dataDir = opts.dataDir ? path.resolve(opts.dataDir) : null;
    this.#restartDelays = opts.restartDelaysMs ?? RESTART_DELAYS_MS;
    this.#mapper = opts.portMapper ?? new PortMapper({ log: (m) => console.log(`[upnp] ${m}`) });
    const metrics = setInterval(() => void this.#tick(), METRICS_INTERVAL_MS);
    const idle = setInterval(() => void this.#checkIdle(), opts.idleCheckMs ?? IDLE_CHECK_MS);
    metrics.unref();
    idle.unref();
    this.#timers.push(metrics, idle);
  }

  async hostInfo(): Promise<HostInfo> {
    const disk = this.#dataDir ? await diskSpace(this.#dataDir) : null;
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      os: osName(),
      dataDir: this.#dataDir,
      diskTotalMb: disk?.totalMb ?? null,
      diskFreeMb: disk?.freeMb ?? null,
      uptimeSec: Math.round(os.uptime()),
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    };
  }

  // --- lifecycle ---------------------------------------------------------------

  async start(req: LaunchRequest): Promise<void> {
    const existing = this.#servers.get(req.serverId);
    if (existing?.proc && existing.proc.pid !== null) throw new Error("server is already running");
    await fs.promises.access(req.directory);
    const m = existing ?? this.#manage(req);
    m.req = req;
    this.#cancelRestart(m);
    await this.#closeSleeper(m);
    if (req.port) await this.#closeProbe(req.port);
    this.#history.set(req.serverId, []);
    this.#spawn(m);
  }

  async stop(serverId: string, timeoutMs = 60_000): Promise<void> {
    const m = this.#servers.get(serverId);
    if (!m) return;
    if (this.#cancelRestart(m)) this.#system(serverId, "Automatic restart cancelled.");
    if (m.sleeper) {
      await this.#closeSleeper(m);
      this.#emitStatus(serverId, "stopped");
    }
    await m.proc?.stop(timeoutMs);
  }

  async kill(serverId: string): Promise<void> {
    const m = this.#servers.get(serverId);
    if (!m) return;
    this.#cancelRestart(m);
    if (m.sleeper) {
      await this.#closeSleeper(m);
      this.#emitStatus(serverId, "stopped");
    }
    await m.proc?.kill();
  }

  async send(serverId: string, command: string): Promise<void> {
    const proc = this.#live(serverId);
    if (!proc) throw new Error("server is not running");
    proc.send(command);
  }

  async command(serverId: string, command: string): Promise<string | null> {
    const proc = this.#live(serverId);
    if (!proc) throw new Error("server is not running");
    return proc.command(command);
  }

  async status(serverId: string): Promise<ServerStatus> {
    const m = this.#servers.get(serverId);
    if (!m) return "stopped";
    if (m.sleeper) return "sleeping";
    return m.proc?.status ?? "stopped";
  }

  async players(serverId: string): Promise<string[]> {
    return this.#servers.get(serverId)?.proc?.players ?? [];
  }

  async running(): Promise<string[]> {
    return [...this.#servers.values()]
      .filter((m) => m.proc?.pid != null)
      .map((m) => m.req.serverId);
  }

  /** Servers waiting on their port for a player; they keep the daemon alive too. */
  sleeping(): string[] {
    return [...this.#servers.values()].filter((m) => m.sleeper).map((m) => m.req.serverId);
  }

  /** Anything that needs the daemon to stay up: processes, sleepers, pending restarts. */
  busy(): boolean {
    return [...this.#servers.values()].some(
      (m) => m.proc?.pid != null || m.sleeper !== null || m.restartTimer !== null,
    );
  }

  async setPolicy(serverId: string, policy: AgentPolicy): Promise<void> {
    const m = this.#servers.get(serverId);
    if (!m) return; // takes effect with the next start
    m.req = { ...m.req, policy };
    if (!policy.autoRestart && this.#cancelRestart(m)) {
      this.#system(serverId, "Automatic restart cancelled.");
    }
    if (!policy.wakeOnJoin && m.sleeper) {
      await this.#closeSleeper(m);
      this.#emitStatus(serverId, "stopped");
    }
    if (policy.idleStopMinutes <= 0) m.emptySince = null;
  }

  async sleep(req: LaunchRequest): Promise<void> {
    const existing = this.#servers.get(req.serverId);
    if (existing?.proc?.pid != null) throw new Error("server is running");
    const m = existing ?? this.#manage(req);
    m.req = req;
    await this.#armSleeper(m);
  }

  async snapshot(serverId: string, directory?: string): Promise<AgentSnapshot> {
    const status = await this.status(serverId);
    const players = await this.players(serverId);
    const lines = this.#history.get(serverId) ?? [];
    if (lines.length > 0) return { status, players, lines: [...lines], source: "memory" };
    if (directory) {
      const fromFile = await tailLogFile(path.join(directory, "logs", "latest.log"));
      if (fromFile.length > 0) return { status, players, lines: fromFile, source: "logfile" };
    }
    return { status, players, lines: [], source: "none" };
  }

  onEvent(handler: AgentEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async busyPorts(ports: number[]): Promise<number[]> {
    const own = new Set(
      [...this.#servers.values()].flatMap((m) => (m.sleeper ? [m.sleeper.port] : [])),
    );
    const busy: number[] = [];
    for (const port of ports) {
      if (own.has(port) || !(await portFree(port))) busy.push(port);
    }
    return busy;
  }

  // --- files -------------------------------------------------------------------

  readFile(directory: string, relPath: string, maxBytes?: number): Promise<string> {
    return readFileSafe(directory, relPath, maxBytes);
  }

  async readBinary(
    directory: string,
    relPath: string,
    maxBytes = 8 * 1024 * 1024,
  ): Promise<{ data: string; modifiedAt: string }> {
    const p = safeResolve(directory, relPath);
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new Error(`Not a file: ${relPath}`);
    if (st.size > maxBytes) throw new Error(`File too large (${st.size} bytes)`);
    const data = await fs.promises.readFile(p);
    return { data: data.toString("base64"), modifiedAt: st.mtime.toISOString() };
  }

  async readFiles(
    directory: string,
    relPaths: string[],
    maxBytes = 1024 * 1024,
  ): Promise<Array<{ path: string; content: string | null; modifiedAt: string | null }>> {
    const out: Array<{ path: string; content: string | null; modifiedAt: string | null }> = [];
    for (const rel of relPaths.slice(0, 5000)) {
      try {
        const p = safeResolve(directory, rel);
        const st = await fs.promises.stat(p);
        const content =
          st.isFile() && st.size <= maxBytes ? await fs.promises.readFile(p, "utf8") : null;
        out.push({ path: rel, content, modifiedAt: st.mtime.toISOString() });
      } catch {
        out.push({ path: rel, content: null, modifiedAt: null });
      }
    }
    return out;
  }

  writeFile(directory: string, relPath: string, content: string): Promise<void> {
    return writeFileSafe(directory, relPath, content);
  }

  listDir(directory: string, relPath: string): Promise<DirEntry[]> {
    return listDirSafe(directory, relPath);
  }

  stat(root: string, relPaths: string[]): Promise<PathStat[]> {
    return statPaths(root, relPaths);
  }

  copyInto(
    srcRoot: string,
    relPaths: string[],
    destDir: string,
    overwrite = false,
  ): Promise<CopyResult> {
    return copyInto(srcRoot, relPaths, destDir, overwrite);
  }

  removePaths(root: string, relPaths: string[]): Promise<void> {
    return removePaths(root, relPaths);
  }

  async removeDir(directory: string): Promise<void> {
    const running = [...this.#servers.values()].find(
      (m) => m.proc?.pid != null && isInside(directory, m.req.directory),
    );
    if (running) throw new Error("A running server uses files in this folder; stop it first");
    await removeTree(directory);
    for (const [id, m] of this.#servers) {
      if (!isInside(directory, m.req.directory)) continue;
      this.#cancelRestart(m);
      await this.#closeSleeper(m);
      this.#history.delete(id);
      this.#servers.delete(id);
    }
  }

  async makeDir(root: string, relPath: string): Promise<void> {
    await fs.promises.mkdir(safeResolve(root, relPath), { recursive: true });
  }

  async rename(root: string, from: string, to: string): Promise<void> {
    const src = safeResolve(root, from);
    const dest = safeResolve(root, to);
    if (src === path.resolve(root)) throw new Error("Cannot rename the server folder itself");
    // Case-only renames on Windows point at the same file; allow them.
    const sameFile = src.toLowerCase() === dest.toLowerCase() && process.platform === "win32";
    if (!sameFile && fs.existsSync(dest)) throw new Error(`${to} already exists`);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await renameWithRetry(src, dest);
  }

  zip(
    srcRoot: string,
    relPaths: string[],
    destFile: string,
    opts: ZipOptions = {},
  ): Promise<ArchiveResult> {
    return createZip(srcRoot, relPaths, destFile, {
      skipNames: opts.skipNames,
      onProgress: opts.taskId ? this.#progress(opts.taskId) : undefined,
    });
  }

  async unzip(
    zipFile: string,
    destDir: string,
    opts: { overwrite?: boolean; taskId?: string } = {},
  ): Promise<ArchiveResult> {
    const r = await extractZip(zipFile, destDir, {
      overwrite: opts.overwrite,
      onProgress: opts.taskId ? this.#progress(opts.taskId) : undefined,
    });
    return { ...r, zipBytes: 0 };
  }

  zipEntries(zipFile: string): Promise<string[]> {
    return zipTopLevel(zipFile);
  }

  async inspectJars(root: string, relDir: string): Promise<JarInfo[]> {
    const dir = safeResolve(root, relDir);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    const out: JarInfo[] = [];
    for (const file of names.sort((a, b) => a.localeCompare(b))) {
      const enabled = /\.jar$/i.test(file);
      if (!enabled && !/\.jar\.disabled$/i.test(file)) continue;
      const abs = path.join(dir, file);
      try {
        const st = await fs.promises.stat(abs);
        if (!st.isFile()) continue;
        const [hashes, meta] = await Promise.all([hashFile(abs), inspectJar(abs)]);
        out.push({
          file,
          enabled,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
          ...hashes,
          ...meta,
        });
      } catch {
        // unreadable jar; skip it
      }
    }
    return out;
  }

  /** Gracefully stop every running server and release timers. */
  // --- installs ------------------------------------------------------------------

  stageBinaries(req: StageRequest): Promise<StagedBinaries> {
    return stageServerBinaries(this.#javaDir(), req, this.#installReporter(req.serverId));
  }

  commitBinaries(directory: string, staged: StagedBinaries, previousJar?: string): Promise<void> {
    return commitServerBinaries(directory, staged, previousJar);
  }

  discardStaging(directory: string): Promise<void> {
    return discardStaging(directory);
  }

  writeInitialFiles(req: InitialFiles): Promise<void> {
    return writeInitialFiles(req);
  }

  async ensureJava(
    major: number,
    serverId?: string,
  ): Promise<{ javaPath: string; releaseName: string | null }> {
    const report = serverId ? this.#installReporter(serverId) : null;
    const rt = await ensureJava(this.#javaDir(), major, {
      onProgress: (message, percent) => report?.("java", message, percent),
    });
    return { javaPath: rt.javaPath, releaseName: rt.releaseName };
  }

  gcJava(keep: number[]): Promise<Array<{ major: number; sizeBytes: number }>> {
    const inUse = [...this.#servers.values()]
      .filter((m) => m.proc?.pid != null || m.sleeper || m.restartTimer)
      .map((m) => m.req.javaPath);
    return gcJavaRuntimes(this.#javaDir(), keep, inUse);
  }

  async fetchUrl(req: FetchRequest): Promise<{ sizeBytes: number }> {
    if (!req.url.startsWith("https://")) throw new Error("only https downloads are allowed");
    const target = safeResolve(req.root, req.relPath);
    if (target === path.resolve(req.root)) throw new Error("missing file name");
    await downloadFile(req.url, target, {
      sha1: req.sha1,
      sha256: req.sha256,
      sha512: req.sha512,
      onProgress: req.taskId ? this.#progress(req.taskId) : undefined,
    });
    return { sizeBytes: (await fs.promises.stat(target)).size };
  }

  // --- network -------------------------------------------------------------------

  async networkInfo(refresh = false): Promise<NetworkInfo> {
    if (!refresh && this.#network && Date.now() - this.#network.at < NETWORK_TTL_MS) {
      return this.#network.info;
    }
    const [route, pub, gw] = await Promise.all([
      defaultRouteAddress(),
      publicAddresses(),
      this.#mapper.gateway(refresh),
    ]);
    const lan = lanAddresses();
    const routerIp = gw ? (await externalIp(gw).catch(() => "")) || null : null;
    // Internet traffic leaving through a VPN makes the public IP the VPN's, not the router's.
    const routeAdapter = lan.find((a) => a.address === route);
    const vpn = !!route && (routeAdapter ? routeAdapter.virtual : !isPrivateIPv4(route));
    const info: NetworkInfo = {
      lan,
      primary: gw?.localAddress ?? lan.find((a) => !a.virtual)?.address ?? null,
      tailscale: tailscaleAddress(),
      publicIpv4: pub.ipv4,
      publicIpv6: pub.ipv6,
      vpn,
      router: gw
        ? {
            name: gw.friendlyName,
            manufacturer: gw.manufacturer,
            model: gw.modelName,
            host: new URL(gw.location).hostname,
            externalIp: routerIp,
          }
        : null,
      wan: gw ? classifyWan(routerIp, vpn ? null : pub.ipv4) : "unknown",
      checkedAt: new Date().toISOString(),
    };
    this.#network = { at: Date.now(), info };
    return info;
  }

  setPortMappings(mappings: MappingRequest[]): Promise<MappingState[]> {
    return this.#mapper.set(mappings);
  }

  async portMappings(): Promise<MappingState[]> {
    return this.#mapper.states();
  }

  setTunnel(kind: TunnelKind, spec: TunnelSpec | null): Promise<TunnelStatus> {
    if (!TUNNEL_KINDS.includes(kind)) throw new Error(`Unknown tunnel ${kind}`);
    let t = this.#tunnels.get(kind);
    if (!t) {
      t = new TunnelProcess(kind);
      this.#tunnels.set(kind, t);
    }
    return t.set(spec);
  }

  async tunnelStatus(kind: TunnelKind): Promise<TunnelStatus> {
    return (this.#tunnels.get(kind) ?? new TunnelProcess(kind)).status();
  }

  tailscaleStatus(): Promise<TailscaleStatus> {
    return tailscaleStatus();
  }

  tailscaleLogin(): Promise<{ authUrl: string | null; output: string }> {
    return tailscaleLogin();
  }

  tailscaleFunnel(
    publicPort: number,
    localPort: number | null,
  ): Promise<{ ok: boolean; enableUrl: string | null; output: string }> {
    return tailscaleFunnel(publicPort, localPort);
  }

  tailscaleInstall(): Promise<{ ok: boolean; output: string }> {
    return tailscaleInstall();
  }

  async probe(req: ProbeRequest): Promise<{ listening: boolean; reason: string | null }> {
    if (req.ttlMs <= 0) {
      await this.#closeProbe(req.port);
      return { listening: false, reason: "closed" };
    }
    const owner = [...this.#servers.values()].find(
      (m) => m.req.port === req.port && (m.proc?.pid != null || m.sleeper !== null),
    );
    if (owner) return { listening: false, reason: owner.sleeper ? "sleeping" : "running" };
    await this.#closeProbe(req.port);
    if (!(await portFree(req.port))) return { listening: false, reason: "busy" };
    const sleeper = new Sleeper({
      port: req.port,
      host: req.host,
      motd: req.text,
      maxPlayers: 0,
      probe: true,
    });
    await sleeper.listen();
    const timer = setTimeout(
      () => void this.#closeProbe(req.port),
      Math.min(Math.max(req.ttlMs, 1_000), MAX_PROBE_MS),
    );
    timer.unref();
    this.#probes.set(req.port, { sleeper, timer });
    return { listening: true, reason: null };
  }

  async firewall(programs: string[]): Promise<FirewallSnapshot | null> {
    if (process.platform !== "win32") return null;
    return readWindowsFirewall(programs);
  }

  fixFirewall(fixes: FirewallFix[]): Promise<void> {
    return runElevated(fixes);
  }

  async shutdown(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    for (const port of [...this.#probes.keys()]) await this.#closeProbe(port);
    for (const t of this.#tunnels.values()) await t.stop().catch(() => {});
    // Close the router ports now rather than leaving them open until the lease ends.
    await this.#mapper.clear().catch(() => {});
    this.#mapper.dispose();
    await Promise.all(
      [...this.#servers.values()].map(async (m) => {
        this.#cancelRestart(m);
        await this.#closeSleeper(m);
        await m.proc?.stop(60_000);
      }),
    );
    this.#sampler.dispose();
  }

  // --- internals -----------------------------------------------------------------

  #manage(req: LaunchRequest): Managed {
    const m: Managed = {
      req,
      proc: null,
      crashes: [],
      restartTimer: null,
      sleeper: null,
      emptySince: null,
    };
    this.#servers.set(req.serverId, m);
    return m;
  }

  #live(serverId: string): ServerProcess | null {
    const proc = this.#servers.get(serverId)?.proc;
    return proc && proc.pid !== null ? proc : null;
  }

  #policy(m: Managed): AgentPolicy {
    return m.req.policy ?? DEFAULT_POLICY;
  }

  #spawn(m: Managed): void {
    const proc = new ServerProcess(m.req);
    m.proc = proc;
    m.emptySince = null;
    proc.on("event", (ev) => {
      if (m.proc !== proc) return; // an older process of the same server
      if (ev.type === "exit") this.#dispatch(this.#afterExit(m, ev));
      else {
        if (ev.type === "status" && ev.status === "running") m.emptySince = Date.now();
        if (ev.type === "players") m.emptySince = ev.players.length === 0 ? Date.now() : null;
        this.#dispatch(ev);
      }
    });
    proc.start();
  }

  /** Decide whether to restart after an exit, and say so in the exit event. */
  #afterExit(m: Managed, ev: Extract<AgentEvent, { type: "exit" }>): AgentEvent {
    const crashed = !ev.expected && ev.code !== 0;
    const policy = this.#policy(m);
    if (!crashed || !policy.autoRestart) return ev;
    const id = m.req.serverId;
    if (ev.reason && NO_RESTART.has(ev.reason)) {
      this.#system(id, "Not restarting automatically: this problem needs fixing first.");
      return ev;
    }
    const now = Date.now();
    m.crashes = m.crashes.filter((t) => now - t < RESTART_WINDOW_MS);
    m.crashes.push(now);
    const delay = this.#restartDelays[m.crashes.length - 1];
    if (delay === undefined) {
      this.#system(
        id,
        `Crashed ${m.crashes.length} times in ${RESTART_WINDOW_MS / 60_000} minutes; not restarting automatically.`,
      );
      return ev;
    }
    this.#system(
      id,
      `Crashed; restarting automatically in ${Math.round(delay / 1000)}s (attempt ${m.crashes.length} of ${this.#restartDelays.length}).`,
    );
    m.restartTimer = setTimeout(() => {
      m.restartTimer = null;
      if (m.proc?.pid != null) return;
      this.#system(id, "Restarting after the crash.");
      this.#history.set(id, []);
      this.#spawn(m);
    }, delay);
    return { ...ev, restartInMs: delay };
  }

  #cancelRestart(m: Managed): boolean {
    if (!m.restartTimer) return false;
    clearTimeout(m.restartTimer);
    m.restartTimer = null;
    return true;
  }

  async #checkIdle(): Promise<void> {
    const now = Date.now();
    for (const m of this.#servers.values()) {
      const policy = this.#policy(m);
      const proc = m.proc;
      if (policy.idleStopMinutes <= 0 || !proc || proc.status !== "running") continue;
      if (proc.players.length > 0) {
        m.emptySince = null;
        continue;
      }
      m.emptySince ??= now;
      if (now - m.emptySince < policy.idleStopMinutes * 60_000) continue;
      m.emptySince = null;
      void this.#idleStop(m, policy);
    }
  }

  async #idleStop(m: Managed, policy: AgentPolicy): Promise<void> {
    const id = m.req.serverId;
    this.#system(
      id,
      `Nobody online for ${policy.idleStopMinutes} minute${policy.idleStopMinutes === 1 ? "" : "s"}; stopping to save resources.`,
    );
    await m.proc?.stop(60_000, "idle");
    if (policy.wakeOnJoin && m.proc?.pid == null) await this.#armSleeper(m);
  }

  async #armSleeper(m: Managed): Promise<void> {
    const id = m.req.serverId;
    if (m.sleeper) return;
    const props = await readProps(m.req.directory);
    const port = Number(props.get("server-port")) || m.req.port;
    if (!port) {
      this.#system(id, "Cannot wait for players: the server port is unknown.");
      return;
    }
    await this.#closeProbe(port);
    const sleeper = new Sleeper({
      port,
      host: props.get("server-ip")?.trim() || undefined,
      motd: props.get("motd") ?? "A Minecraft Server",
      maxPlayers: Number(props.get("max-players")) || 20,
      onWake: (player) => {
        if (m.sleeper !== sleeper) return;
        m.sleeper = null;
        this.#system(id, `${player ?? "A player"} tried to join; starting the server.`);
        this.#history.set(id, []);
        try {
          this.#spawn(m);
        } catch (err) {
          this.#system(id, `Could not start: ${err instanceof Error ? err.message : err}`);
          this.#emitStatus(id, "stopped");
        }
      },
    });
    try {
      await sleeper.listen();
    } catch (err) {
      this.#system(
        id,
        `Cannot wait for players on port ${port}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    m.sleeper = sleeper;
    this.#emitStatus(id, "sleeping");
    this.#system(id, `Sleeping on port ${port}. It starts again when a player joins.`);
  }

  async #closeProbe(port: number): Promise<void> {
    const p = this.#probes.get(port);
    if (!p) return;
    this.#probes.delete(port);
    clearTimeout(p.timer);
    await p.sleeper.close();
  }

  async #closeSleeper(m: Managed): Promise<void> {
    const s = m.sleeper;
    m.sleeper = null;
    await s?.close();
  }

  #progress(taskId: string) {
    return (done: number, total: number | null) =>
      this.#dispatch({ type: "progress", taskId, at: Date.now(), done, total });
  }

  #javaDir(): string {
    if (!this.#dataDir) throw new Error("this agent was started without a data folder");
    return path.join(this.#dataDir, "java");
  }

  #installReporter(serverId: string) {
    return (step: InstallStep, message: string, percent: number | null) =>
      this.#dispatch({ type: "install", serverId, at: Date.now(), step, message, percent });
  }

  #system(serverId: string, line: string): void {
    this.#dispatch({ type: "line", serverId, at: Date.now(), line, stream: "system" });
  }

  #emitStatus(serverId: string, status: ServerStatus): void {
    this.#dispatch({ type: "status", serverId, at: Date.now(), status });
  }

  async #tick(): Promise<void> {
    const live = [...this.#servers.values()]
      .map((m) => m.proc)
      .filter((p): p is ServerProcess => p !== null && p.pid !== null);
    if (live.length === 0) return;
    const byPid = new Map(live.map((p) => [p.pid as number, p]));
    let usage: Awaited<ReturnType<ProcessSampler["sample"]>>;
    try {
      usage = await this.#sampler.sample([...byPid.keys()]);
    } catch {
      return;
    }
    const at = Date.now();
    for (const u of usage) {
      const proc = byPid.get(u.pid);
      if (!proc) continue;
      const heapUsedMb = await proc.readHeap();
      this.#dispatch({
        type: "metrics",
        serverId: proc.serverId,
        at,
        cpuPercent: u.cpuPercent,
        memRssMb: u.memRssMb,
        heapUsedMb,
        tps: proc.tickStats.tps,
        mspt: proc.tickStats.mspt,
      });
    }
  }

  #dispatch(ev: AgentEvent): void {
    if (ev.type === "line") {
      let h = this.#history.get(ev.serverId);
      if (!h) {
        h = [];
        this.#history.set(ev.serverId, h);
      }
      h.push({ at: ev.at, line: ev.line, stream: ev.stream });
      if (h.length > HISTORY_LINES) h.splice(0, h.length - HISTORY_LINES);
    }
    for (const handler of this.#handlers) {
      try {
        handler(ev);
      } catch (err) {
        console.error("agent event handler failed", err);
      }
    }
  }
}

async function readProps(directory: string): Promise<Map<string, string>> {
  try {
    const text = await fs.promises.readFile(path.join(directory, "server.properties"), "utf8");
    return propertiesToMap(parseProperties(text));
  } catch {
    return new Map();
  }
}

/**
 * Whether a TCP port can be bound. Java binds the wildcard address, IPv4 or
 * dual-stack IPv6 depending on the system, so both are tried; an IPv6 error
 * other than "in use" just means there is no IPv6.
 */
async function portFree(port: number): Promise<boolean> {
  const tryBind = (host: string) =>
    new Promise<string | null>((resolve) => {
      const server = net.createServer();
      server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "ERROR"));
      server.listen({ port, host }, () => server.close(() => resolve(null)));
    });
  const v4 = await tryBind("0.0.0.0");
  if (v4 !== null) return false;
  const v6 = await tryBind("::");
  return v6 !== "EADDRINUSE" && v6 !== "EACCES";
}

/** Last lines of a log file, read from the end so huge logs stay cheap. */
async function tailLogFile(file: string): Promise<AgentLogLine[]> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r");
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, LOGFILE_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    let lines = buf.toString("utf8").split(/\r?\n/);
    if (size > length) lines = lines.slice(1); // first line is probably partial
    lines = lines.filter((l) => l.length > 0).slice(-LOGFILE_TAIL_LINES);
    const at = Math.round(mtimeMs);
    return lines.map((line) => ({ at, line, stream: "stdout" as const }));
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}
