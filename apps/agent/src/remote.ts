import http from "node:http";
import type { Readable } from "node:stream";
import type { ServerStatus } from "@cubehold/shared";
import type {
  FirewallFix,
  FirewallSnapshot,
  MappingRequest,
  MappingState,
} from "@cubehold/tunnels";
import WebSocket from "ws";
import {
  AGENT_HTTP,
  type ControlMethod,
  type DaemonMessage,
  type RpcHello,
  type RpcMethod,
  type RpcRequest,
} from "./protocol.js";
import type {
  AgentApi,
  AgentEventHandler,
  AgentPolicy,
  AgentSnapshot,
  ArchiveResult,
  CopyResult,
  DirEntry,
  FetchRequest,
  HostInfo,
  InitialFiles,
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

/** A streamed download from the agent. */
export interface AgentDownload {
  body: Readable;
  /** Null for streamed zips, whose size is not known in advance. */
  sizeBytes: number | null;
}

const LONG = 6 * 60 * 60_000; // archive jobs on big worlds

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** A call could not be made because the agent is not connected (e.g. its host is offline). */
export class AgentUnavailableError extends Error {}

/**
 * AgentApi over a WebSocket to an agent daemon. Reconnects automatically and
 * tells listeners when a (re)connection completes so callers can resync.
 */
export class RemoteAgent implements AgentApi {
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Set<AgentEventHandler>();
  #connectListeners = new Set<(hello: RpcHello) => void>();
  #closed = false;
  #retry = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  #disconnectListeners = new Set<() => void>();
  #hello: RpcHello | null = null;

  #token: string | (() => string);

  constructor(
    /** A function when the address is only known later (a tunnel's local port). */
    private readonly url: string | (() => string),
    /** A function when the agent may come back with a new token (a restarted agent container). */
    token: string | (() => string),
    private readonly opts: {
      /** Error message for calls while disconnected, e.g. "the VPS is offline". */
      unavailable?: () => string;
    } = {},
  ) {
    this.#token = token;
  }

  #url(): string {
    return typeof this.url === "function" ? this.url() : this.url;
  }

  #currentToken(): string {
    return typeof this.#token === "function" ? this.#token() : this.#token;
  }

  /** Use another token from the next connection on (remote hosts learn it when the vault unlocks). */
  setToken(token: string): void {
    this.#token = token;
  }

  get hello(): RpcHello | null {
    return this.#hello;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN && this.#hello !== null;
  }

  #connecting: Promise<RpcHello> | null = null;

  /**
   * Open the connection. Rejects if the daemon is unreachable. Concurrent
   * calls share one attempt, and an open connection is reused.
   */
  connect(timeoutMs = 3_000): Promise<RpcHello> {
    if (this.connected && this.#hello) return Promise.resolve(this.#hello);
    if (!this.#connecting) {
      this.#connecting = this.#open(timeoutMs).finally(() => {
        this.#connecting = null;
      });
    }
    return this.#connecting;
  }

  /**
   * Connect now, and keep retrying in the background until closed if that
   * fails. For agents behind a tunnel that may not be up yet.
   */
  keepConnecting(): void {
    if (this.#closed || this.connected || this.#connecting) return;
    this.connect().catch(() => this.#onClose());
  }

  #open(timeoutMs: number): Promise<RpcHello> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#url(), {
        headers: {
          authorization: `Bearer ${this.#currentToken()}`,
        },
        handshakeTimeout: timeoutMs,
      });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners();
        ws.terminate();
        reject(err);
      };
      ws.once("error", fail);
      ws.once("unexpected-response", (_req, res) =>
        fail(new Error(`agent refused connection: HTTP ${res.statusCode}`)),
      );
      ws.once("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as DaemonMessage;
        if (msg.type !== "hello") return fail(new Error("agent did not say hello"));
        settled = true;
        ws.removeAllListeners("error");
        this.#attach(ws, msg);
        resolve(msg);
      });
    });
  }

  onConnect(listener: (hello: RpcHello) => void): () => void {
    this.#connectListeners.add(listener);
    return () => this.#connectListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#ws?.close();
    this.#failPending(new Error("agent connection closed"));
  }

  // --- AgentApi --------------------------------------------------------------

  hostInfo(): Promise<HostInfo> {
    return this.#call("hostInfo", []);
  }
  start(req: LaunchRequest): Promise<void> {
    return this.#call("start", [req]);
  }
  stop(serverId: string, timeoutMs = 60_000): Promise<void> {
    // A server still loading is stopped once it has loaded, which can take minutes.
    return this.#call("stop", [serverId, timeoutMs], timeoutMs + 6 * 60_000);
  }
  kill(serverId: string): Promise<void> {
    return this.#call("kill", [serverId]);
  }
  send(serverId: string, command: string): Promise<void> {
    return this.#call("send", [serverId, command]);
  }
  command(serverId: string, command: string): Promise<string | null> {
    // "save-all flush" on a big world can take a while.
    return this.#call("command", [serverId, command], 150_000);
  }
  status(serverId: string): Promise<ServerStatus> {
    return this.#call("status", [serverId]);
  }
  players(serverId: string): Promise<string[]> {
    return this.#call("players", [serverId]);
  }
  running(): Promise<string[]> {
    return this.#call("running", []);
  }
  setPolicy(serverId: string, policy: AgentPolicy): Promise<void> {
    return this.#call("setPolicy", [serverId, policy]);
  }
  sleep(req: LaunchRequest): Promise<void> {
    return this.#call("sleep", [req]);
  }
  snapshot(serverId: string, directory?: string): Promise<AgentSnapshot> {
    return this.#call("snapshot", [serverId, directory]);
  }
  onEvent(handler: AgentEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  busyPorts(ports: number[]): Promise<number[]> {
    return this.#call("busyPorts", [ports]);
  }
  readFile(directory: string, relPath: string, maxBytes?: number): Promise<string> {
    return this.#call("readFile", [directory, relPath, maxBytes]);
  }
  readBinary(
    directory: string,
    relPath: string,
    maxBytes?: number,
  ): Promise<{ data: string; modifiedAt: string }> {
    return this.#call("readBinary", [directory, relPath, maxBytes]);
  }
  readFiles(
    directory: string,
    relPaths: string[],
    maxBytes?: number,
  ): Promise<Array<{ path: string; content: string | null; modifiedAt: string | null }>> {
    return this.#call("readFiles", [directory, relPaths, maxBytes], 120_000);
  }
  writeFile(directory: string, relPath: string, content: string): Promise<void> {
    return this.#call("writeFile", [directory, relPath, content]);
  }
  listDir(directory: string, relPath: string): Promise<DirEntry[]> {
    return this.#call("listDir", [directory, relPath]);
  }
  stat(root: string, relPaths: string[]): Promise<PathStat[]> {
    return this.#call("stat", [root, relPaths], 5 * 60_000);
  }
  copyInto(
    srcRoot: string,
    relPaths: string[],
    destDir: string,
    overwrite = false,
  ): Promise<CopyResult> {
    // Worlds can be many gigabytes; allow a long copy.
    return this.#call("copyInto", [srcRoot, relPaths, destDir, overwrite], 60 * 60_000);
  }
  removePaths(root: string, relPaths: string[]): Promise<void> {
    return this.#call("removePaths", [root, relPaths], 10 * 60_000);
  }
  removeDir(directory: string): Promise<void> {
    return this.#call("removeDir", [directory], 10 * 60_000);
  }
  makeDir(root: string, relPath: string): Promise<void> {
    return this.#call("makeDir", [root, relPath]);
  }
  rename(root: string, from: string, to: string): Promise<void> {
    return this.#call("rename", [root, from, to]);
  }
  zip(
    srcRoot: string,
    relPaths: string[],
    destFile: string,
    opts?: ZipOptions,
  ): Promise<ArchiveResult> {
    return this.#call("zip", [srcRoot, relPaths, destFile, opts], LONG);
  }
  unzip(
    zipFile: string,
    destDir: string,
    opts?: { overwrite?: boolean; taskId?: string },
  ): Promise<ArchiveResult> {
    return this.#call("unzip", [zipFile, destDir, opts], LONG);
  }
  zipEntries(zipFile: string): Promise<string[]> {
    return this.#call("zipEntries", [zipFile], 5 * 60_000);
  }
  inspectJars(root: string, relDir: string): Promise<JarInfo[]> {
    return this.#call("inspectJars", [root, relDir], 5 * 60_000);
  }
  stageBinaries(req: StageRequest): Promise<StagedBinaries> {
    // Java (~50 MB) and the jar download on the host itself.
    return this.#call("stageBinaries", [req], 30 * 60_000);
  }
  commitBinaries(directory: string, staged: StagedBinaries, previousJar?: string): Promise<void> {
    return this.#call("commitBinaries", [directory, staged, previousJar], 5 * 60_000);
  }
  discardStaging(directory: string): Promise<void> {
    return this.#call("discardStaging", [directory], 60_000);
  }
  writeInitialFiles(req: InitialFiles): Promise<void> {
    return this.#call("writeInitialFiles", [req]);
  }
  ensureJava(
    major: number,
    serverId?: string,
  ): Promise<{ javaPath: string; releaseName: string | null }> {
    return this.#call("ensureJava", [major, serverId], 30 * 60_000);
  }
  gcJava(keep: number[]): Promise<Array<{ major: number; sizeBytes: number }>> {
    return this.#call("gcJava", [keep], 5 * 60_000);
  }
  fetchUrl(req: FetchRequest): Promise<{ sizeBytes: number }> {
    return this.#call("fetchUrl", [req], 30 * 60_000);
  }
  networkInfo(refresh = false): Promise<NetworkInfo> {
    return this.#call("networkInfo", [refresh], 60_000);
  }
  setPortMappings(mappings: MappingRequest[]): Promise<MappingState[]> {
    return this.#call("setPortMappings", [mappings], 120_000);
  }
  portMappings(): Promise<MappingState[]> {
    return this.#call("portMappings", []);
  }
  setTunnel(kind: TunnelKind, spec: TunnelSpec | null): Promise<TunnelStatus> {
    return this.#call("setTunnel", [kind, spec], 60_000);
  }
  tunnelStatus(kind: TunnelKind): Promise<TunnelStatus> {
    return this.#call("tunnelStatus", [kind]);
  }
  tailscaleStatus(): Promise<TailscaleStatus> {
    return this.#call("tailscaleStatus", [], 40_000);
  }
  tailscaleLogin(): Promise<{ authUrl: string | null; output: string }> {
    return this.#call("tailscaleLogin", [], 40_000);
  }
  tailscaleFunnel(
    publicPort: number,
    localPort: number | null,
  ): Promise<{ ok: boolean; enableUrl: string | null; output: string }> {
    return this.#call("tailscaleFunnel", [publicPort, localPort], 40_000);
  }
  tailscaleInstall(): Promise<{ ok: boolean; output: string }> {
    return this.#call("tailscaleInstall", [], 16 * 60_000);
  }
  probe(req: ProbeRequest): Promise<{ listening: boolean; reason: string | null }> {
    return this.#call("probe", [req]);
  }
  firewall(programs: string[]): Promise<FirewallSnapshot | null> {
    return this.#call("firewall", [programs], 60_000);
  }
  fixFirewall(fixes: FirewallFix[]): Promise<void> {
    // Waits for the person at the computer to answer the UAC prompt.
    return this.#call("fixFirewall", [fixes], 6 * 60_000);
  }

  // --- streams (HTTP on the same port) -------------------------------------------

  /** Stream one file from the host. */
  async download(root: string, relPath: string): Promise<AgentDownload> {
    const res = await this.#http("GET", AGENT_HTTP.files, { root, path: relPath });
    const len = Number(res.headers["content-length"]);
    return { body: res, sizeBytes: Number.isFinite(len) ? len : null };
  }

  /** Stream paths as a zip built on the fly. */
  async downloadZip(root: string, relPaths: string[]): Promise<AgentDownload> {
    const res = await this.#http("GET", AGENT_HTTP.zip, { root, paths: JSON.stringify(relPaths) });
    return { body: res, sizeBytes: null };
  }

  /** Write a stream to a file on the host (via a temp file, renamed when complete). */
  async upload(root: string, relPath: string, body: Readable, overwrite = false): Promise<number> {
    const res = await this.#http(
      "PUT",
      AGENT_HTTP.files,
      { root, path: relPath, overwrite: overwrite ? "1" : "0" },
      body,
    );
    const text = await readAll(res);
    return (JSON.parse(text) as { sizeBytes: number }).sizeBytes;
  }

  #http(
    method: "GET" | "PUT",
    pathname: string,
    query: Record<string, string>,
    body?: Readable,
  ): Promise<http.IncomingMessage> {
    const url = new URL(this.#url().replace(/^ws/, "http"));
    url.pathname = pathname;
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return new Promise((resolve, reject) => {
      const req = http.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.#currentToken()}`,
            ...(body ? { "content-type": "application/octet-stream" } : {}),
          },
        },
        (res) => {
          if ((res.statusCode ?? 500) >= 400) {
            void readAll(res).then((text) => {
              let message = `agent HTTP ${res.statusCode}`;
              try {
                message = (JSON.parse(text) as { error?: string }).error ?? message;
              } catch {
                // not JSON
              }
              reject(new Error(message));
            }, reject);
            return;
          }
          resolve(res);
        },
      );
      req.on("error", reject);
      if (body) {
        body.on("error", (err) => req.destroy(err));
        body.pipe(req);
      } else {
        req.end();
      }
    });
  }

  /** Ask the daemon to exit. Fails if servers are running unless stopServers is set. */
  shutdownDaemon(opts: { stopServers?: boolean } = {}): Promise<{ stopping: string[] }> {
    return this.#call("agent.shutdown", [opts], 180_000);
  }

  // --- internals -------------------------------------------------------------

  #attach(ws: WebSocket, hello: RpcHello): void {
    this.#ws = ws;
    this.#hello = hello;
    this.#retry = 0;
    ws.on("message", (raw) => this.#onMessage(raw.toString()));
    ws.on("close", () => this.#onClose());
    ws.on("error", () => {
      // "close" follows and handles reconnection
    });
    for (const l of this.#connectListeners) l(hello);
  }

  #onMessage(raw: string): void {
    let msg: DaemonMessage;
    try {
      msg = JSON.parse(raw) as DaemonMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "res": {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else if (msg.error.startsWith("unknown method")) {
          // The panel kept an older daemon because servers were running when it started.
          p.reject(
            new Error(
              "The agent that runs your servers is an older version and cannot do this yet. Stop all servers (or run pnpm agent:stop), then restart the panel to update it.",
            ),
          );
        } else p.reject(new Error(msg.error));
        break;
      }
      case "event":
        for (const h of this.#handlers) {
          try {
            h(msg.event);
          } catch (err) {
            console.error("agent event handler failed", err);
          }
        }
        break;
      case "hello":
        this.#hello = msg;
        break;
    }
  }

  #onClose(): void {
    this.#ws = null;
    this.#hello = null;
    this.#failPending(new Error("lost connection to the agent"));
    for (const l of this.#disconnectListeners) l();
    if (this.#closed || this.#retryTimer) return;
    const delay = Math.min(10_000, 250 * 2 ** this.#retry++);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#closed || this.connected) return;
      this.connect().catch(() => this.#onClose());
    }, delay);
    this.#retryTimer.unref();
  }

  /** Skip the backoff wait, e.g. right after the tunnel to the agent came back. */
  retryNow(): void {
    if (this.#closed || this.connected) return;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#retry = 0;
    this.connect().catch(() => this.#onClose());
  }

  onDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  #failPending(err: Error): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.#pending.delete(id);
    }
  }

  #call<T>(
    method: RpcMethod | ControlMethod,
    params: unknown[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new AgentUnavailableError(this.opts.unavailable?.() ?? "agent is not connected"),
      );
    }
    const id = this.#nextId++;
    // Drop trailing undefined arguments; JSON would turn them into null.
    const args = [...params];
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    const req: RpcRequest = { type: "req", id, method, params: args };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`agent call ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify(req));
    });
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
