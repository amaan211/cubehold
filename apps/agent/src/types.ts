import type { ServerSoftware, ServerStatus } from "@cubehold/shared";
import type {
  FirewallFix,
  FirewallSnapshot,
  LanAddress,
  MappingRequest,
  MappingState,
  WanKind,
} from "@cubehold/tunnels";

/** What the agent does on its own for a server, even with the panel closed. */
export interface AgentPolicy {
  /** Restart after a crash, at most 3 times in 10 minutes. */
  autoRestart: boolean;
  /** Stop after this many minutes with nobody online; 0 = never. */
  idleStopMinutes: number;
  /** After an idle stop, listen on the port and start again when a player joins. */
  wakeOnJoin: boolean;
}

/** Everything the agent needs to launch one server process. */
export interface LaunchRequest {
  serverId: string;
  directory: string;
  javaPath: string;
  args: string[];
  software: ServerSoftware;
  memoryMb: number;
  mcVersion?: string;
  /** Game port, for the wake-on-join listener. */
  port?: number;
  /** RCON on 127.0.0.1, used for commands with replies, TPS and the player list. */
  rcon?: { port: number; password: string } | null;
  /** Command that reports tick performance ("tps" on Paper, "tick query" on vanilla 1.20.3+). */
  tpsCommand?: "tps" | "tick query" | null;
  /** GC log (relative to directory) the agent reads for heap usage. */
  gcLog?: string | null;
  policy?: AgentPolicy;
}

export type AgentEvent =
  | {
      type: "line";
      serverId: string;
      at: number;
      line: string;
      /** "system" lines come from the agent itself (restarts, sleeping, idle stops). */
      stream: "stdout" | "stderr" | "system";
    }
  | { type: "status"; serverId: string; at: number; status: ServerStatus }
  | {
      type: "exit";
      serverId: string;
      at: number;
      code: number | null;
      signal: string | null;
      /** True when the exit followed a stop/kill request. */
      expected: boolean;
      /** Best-effort reason detected from the log (eula, port_in_use, outdated_java, crash). */
      reason: string | null;
      /** Crash report or JVM error log written by this run, relative to the server folder. */
      crashReport: string | null;
      /** Set when the agent will start the server again by itself. */
      restartInMs: number | null;
      /** Why the agent stopped it, when it did so on its own. */
      stoppedBy: "idle" | null;
    }
  | {
      type: "metrics";
      serverId: string;
      at: number;
      cpuPercent: number;
      memRssMb: number;
      heapUsedMb: number | null;
      tps: number | null;
      mspt: number | null;
    }
  | { type: "players"; serverId: string; at: number; players: string[] }
  | {
      type: "progress";
      taskId: string;
      at: number;
      done: number;
      total: number | null;
    }
  | {
      /** Java and jar downloads for a server, as they happen on its host. */
      type: "install";
      serverId: string;
      at: number;
      step: InstallStep;
      message: string;
      percent: number | null;
    };

export type InstallStep = "java" | "download" | "configure" | "done";

/** A server's jar and Java, resolved and downloaded into its staging folder. */
export interface StagedBinaries {
  javaMajor: number;
  /** What to launch: a jar, or (launch "argsFile") the folder holding win_args.txt / unix_args.txt. */
  jarFile: string;
  launch?: "jar" | "argsFile";
  /** Absolute path on the host, inside the server's staging folder. */
  stagedPath: string;
  /** Top-level names in the staging folder to move into the server (Forge writes several). */
  entries?: string[];
  build: string | null;
  recommendedJvmFlags: string[] | null;
}

export interface StageRequest {
  serverId: string;
  directory: string;
  software: ServerSoftware;
  mcVersion: string;
  /** A modpack's Fabric, Forge or NeoForge version; the newest stable one otherwise. */
  loaderVersion?: string;
}

export interface InitialFiles {
  directory: string;
  port: number;
  name: string;
  onlineMode: boolean;
}

/** Download a URL straight onto the host, checked against a digest. */
export interface FetchRequest {
  url: string;
  root: string;
  relPath: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  /** Emit "progress" events under this id. */
  taskId?: string;
}

export type AgentEventHandler = (event: AgentEvent) => void;

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
  sizeBytes: number;
  modifiedAt: string;
}

export interface HostInfo {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  cpus: number;
  totalMemMb: number;
  freeMemMb: number;
  /** Operating system, e.g. "Ubuntu 24.04.1 LTS". */
  os?: string | null;
  /** Where this agent keeps servers, backups and Java. */
  dataDir?: string | null;
  /** Disk holding dataDir. */
  diskTotalMb?: number | null;
  diskFreeMb?: number | null;
  uptimeSec?: number;
  /** 1, 5 and 15 minute load averages (zeros on Windows). */
  loadAvg?: number[];
}

export interface PathStat {
  path: string;
  exists: boolean;
  kind: "file" | "dir" | null;
  sizeBytes: number;
  files: number;
}

export interface CopyResult {
  files: number;
  sizeBytes: number;
}

export interface ArchiveResult {
  files: number;
  /** Uncompressed bytes. */
  sizeBytes: number;
  /** Size of the archive written (0 for extraction). */
  zipBytes: number;
}

export interface JarInfo {
  file: string;
  enabled: boolean;
  sizeBytes: number;
  modifiedAt: string;
  sha1: string;
  sha512: string;
  kind: "plugin" | "mod" | null;
  id: string | null;
  name: string | null;
  version: string | null;
  description: string | null;
}

export interface AgentLogLine {
  at: number;
  line: string;
  stream: "stdout" | "stderr" | "system";
}

export interface AgentSnapshot {
  status: ServerStatus;
  players: string[];
  lines: AgentLogLine[];
  /** Where `lines` came from: the live process, the last run's log file, or nothing. */
  source: "memory" | "logfile" | "none";
}

export interface ZipOptions {
  /** File or folder names skipped anywhere in the tree (e.g. session.lock). */
  skipNames?: string[];
  /** Emit "progress" events under this id. */
  taskId?: string;
}

/** Tunnel programs the agent can keep running for its host. */
export type TunnelKind = "playit" | "ngrok" | "cloudflared";

/** How the agent runs one tunnel program. The panel builds the command line. */
export interface TunnelSpec {
  binary: string;
  args: string[];
  /** Extra environment, e.g. tokens, so they stay off the command line. */
  env?: Record<string, string>;
  /** Where the program's pid is kept, to clean up after an agent that crashed. */
  pidFile?: string;
  /** Secrets the program may echo in its log; replaced before the log is kept. */
  redact?: string[];
  /** The program's local status server (ngrok web_addr, cloudflared metrics), polled for state. */
  statusAddr?: string;
}

/** A public address a tunnel program reports, and where it leads on this machine. */
export interface TunnelEndpoint {
  /** ngrok endpoint name, or the Cloudflare hostname. */
  name: string | null;
  url: string;
  /** Local target, e.g. "tcp://localhost:25565". */
  target: string | null;
}

export interface TunnelStatus {
  state: "stopped" | "starting" | "connected" | "error";
  pid: number | null;
  startedAt: string | null;
  connectedAt: string | null;
  error: string | null;
  restarts: number;
  /** Recent log lines, secrets removed. */
  lines: string[];
  endpoints: TunnelEndpoint[];
}

/** What `tailscale status` says about this machine. */
export interface TailscaleStatus {
  installed: boolean;
  /** Running, NeedsLogin, Stopped, Starting, NoState. */
  state: string | null;
  /** Login link while Tailscale waits for sign-in. */
  authUrl: string | null;
  ips: string[];
  /** MagicDNS name, e.g. "pc.tail1234.ts.net". */
  dnsName: string | null;
  tailnet: string | null;
  /** Public TCP forwards through Funnel: public port -> local target. */
  funnel: Array<{ port: number; target: string; public: boolean }>;
  error: string | null;
}

/**
 * The agent surface. The panel only ever talks to this interface: the local
 * host runs it in a detached daemon on 127.0.0.1, and remote hosts
 * (milestone 4) run the same daemon behind an SSH port-forward.
 */

/** How this host connects to its network and the internet. */
export interface NetworkInfo {
  lan: LanAddress[];
  /** The LAN address with the default route: what players on the same network use. */
  primary: string | null;
  tailscale: string | null;
  publicIpv4: string | null;
  publicIpv6: string | null;
  /** Internet traffic leaves through a VPN, so the public IP is the VPN's. */
  vpn: boolean;
  router: {
    name: string | null;
    manufacturer: string | null;
    model: string | null;
    /** Router address, for its admin page. */
    host: string;
    /** What the router believes its internet address is. */
    externalIp: string | null;
  } | null;
  wan: WanKind;
  checkedAt: string;
}

/** A temporary listener that answers server-list pings, for reachability tests. */
export interface ProbeRequest {
  port: number;
  host?: string;
  /** Shown as the MOTD so a checker's answer can be matched to this test. */
  text: string;
  /** How long to listen; 0 closes a probe early. */
  ttlMs: number;
}

export interface AgentApi {
  hostInfo(): Promise<HostInfo>;
  start(req: LaunchRequest): Promise<void>;
  /** Graceful stop: sends `stop`, waits up to timeoutMs, then kills. Also ends sleeping and pending restarts. */
  stop(serverId: string, timeoutMs?: number): Promise<void>;
  kill(serverId: string): Promise<void>;
  /** Write a line to the server console (stdin). Output appears in the console stream. */
  send(serverId: string, command: string): Promise<void>;
  /**
   * Run a command and return its reply, over RCON when connected. Falls back
   * to the console and returns null when RCON is not available.
   */
  command(serverId: string, command: string): Promise<string | null>;
  status(serverId: string): Promise<ServerStatus>;
  players(serverId: string): Promise<string[]>;
  running(): Promise<string[]>;
  /** Update restart/idle/wake behaviour without restarting the server. */
  setPolicy(serverId: string, policy: AgentPolicy): Promise<void>;
  /** Listen on the server's port and start it when a player joins. */
  sleep(req: LaunchRequest): Promise<void>;
  /**
   * Recent console history. For a server that has not run since the agent
   * started, falls back to the tail of `<directory>/logs/latest.log`.
   */
  snapshot(serverId: string, directory?: string): Promise<AgentSnapshot>;
  onEvent(handler: AgentEventHandler): () => void;
  /** Which of these TCP ports are taken on this host. */
  busyPorts(ports: number[]): Promise<number[]>;

  readFile(directory: string, relPath: string, maxBytes?: number): Promise<string>;
  /** A binary file as base64, with its modification time. */
  readBinary(
    directory: string,
    relPath: string,
    maxBytes?: number,
  ): Promise<{ data: string; modifiedAt: string }>;
  /** Several small text files at once; missing or unreadable ones come back with content null. */
  readFiles(
    directory: string,
    relPaths: string[],
    maxBytes?: number,
  ): Promise<Array<{ path: string; content: string | null; modifiedAt: string | null }>>;
  writeFile(directory: string, relPath: string, content: string): Promise<void>;
  listDir(directory: string, relPath: string): Promise<DirEntry[]>;
  /** Size, file count and kind of paths relative to root. */
  stat(root: string, relPaths: string[]): Promise<PathStat[]>;
  /** Copy relative paths from srcRoot into destDir (absolute). */
  copyInto(
    srcRoot: string,
    relPaths: string[],
    destDir: string,
    overwrite?: boolean,
  ): Promise<CopyResult>;
  removePaths(root: string, relPaths: string[]): Promise<void>;
  /** Delete a whole directory and verify nothing is left. */
  removeDir(directory: string): Promise<void>;
  makeDir(root: string, relPath: string): Promise<void>;
  /** Rename or move within root. Fails if the target exists. */
  rename(root: string, from: string, to: string): Promise<void>;
  /** Zip relative paths of srcRoot into destFile (absolute). */
  zip(
    srcRoot: string,
    relPaths: string[],
    destFile: string,
    opts?: ZipOptions,
  ): Promise<ArchiveResult>;
  /** Extract zipFile (absolute) into destDir (absolute). */
  unzip(
    zipFile: string,
    destDir: string,
    opts?: { overwrite?: boolean; taskId?: string },
  ): Promise<ArchiveResult>;
  /** Top-level names inside a zip. */
  zipEntries(zipFile: string): Promise<string[]>;
  /** Hash and read metadata of every .jar (and .jar.disabled) in a folder. */
  inspectJars(root: string, relDir: string): Promise<JarInfo[]>;

  // --- installs (M4: they run on the server's own host) ---
  /** Install Java if needed and download the jar into the staging folder; reports "install" events. */
  stageBinaries(req: StageRequest): Promise<StagedBinaries>;
  /** Swap the staged jar in, removing the previous jar's unpacked files. */
  commitBinaries(directory: string, staged: StagedBinaries, previousJar?: string): Promise<void>;
  discardStaging(directory: string): Promise<void>;
  /** eula.txt and a first server.properties. */
  writeInitialFiles(req: InitialFiles): Promise<void>;
  /** Find or download Java `major`; progress goes out as "install" events for serverId. */
  ensureJava(
    major: number,
    serverId?: string,
  ): Promise<{ javaPath: string; releaseName: string | null }>;
  /** Delete Java runtimes not in `keep` that nothing running uses. */
  gcJava(keep: number[]): Promise<Array<{ major: number; sizeBytes: number }>>;
  /** Download a file onto the host with digest verification. */
  fetchUrl(req: FetchRequest): Promise<{ sizeBytes: number }>;

  // --- network (M3) ---
  /** Addresses, router and public IP; cached for a minute unless refresh. */
  networkInfo(refresh?: boolean): Promise<NetworkInfo>;
  /** Replace the router port forwards this host keeps (UPnP), renewing their leases. */
  setPortMappings(mappings: MappingRequest[]): Promise<MappingState[]>;
  portMappings(): Promise<MappingState[]>;
  /** Run (or stop, with null) a tunnel program: playit.gg, ngrok or cloudflared. */
  setTunnel(kind: TunnelKind, spec: TunnelSpec | null): Promise<TunnelStatus>;
  tunnelStatus(kind: TunnelKind): Promise<TunnelStatus>;
  /** Tailscale on this host: installed, signed in, addresses, Funnel forwards. */
  tailscaleStatus(): Promise<TailscaleStatus>;
  /** Start signing in; returns the login link to open. */
  tailscaleLogin(): Promise<{ authUrl: string | null; output: string }>;
  /**
   * Share a local port publicly through Tailscale Funnel on 443, 8443 or
   * 10000 (localPort null removes it). Returns a link when the tailnet must
   * allow Funnel first.
   */
  tailscaleFunnel(
    publicPort: number,
    localPort: number | null,
  ): Promise<{ ok: boolean; enableUrl: string | null; output: string }>;
  /** Install Tailscale with winget (Windows; shows a UAC prompt). */
  tailscaleInstall(): Promise<{ ok: boolean; output: string }>;
  /** Answer pings on a free port for a while; false when something already listens there. */
  probe(req: ProbeRequest): Promise<{ listening: boolean; reason: string | null }>;
  /** Firewall rules that apply to these programs; null where not supported (non-Windows). */
  firewall(programs: string[]): Promise<FirewallSnapshot | null>;
  /** Change the firewall as administrator (shows a UAC prompt on Windows). */
  fixFirewall(fixes: FirewallFix[]): Promise<void>;
}
