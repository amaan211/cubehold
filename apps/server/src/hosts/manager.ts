import path from "node:path";
import type { AgentApi, AgentEvent, RemoteAgent, RpcHello } from "@cubehold/agent";
import { LOCAL_HOST_ID } from "@cubehold/shared";
import {
  computeBuildId,
  connectExternalAgent,
  connectLocalAgent,
  type DaemonLogger,
  isStale,
} from "./local-daemon.js";
import type { LinkStatus, RemoteHostLink } from "./remote-host.js";

type PathApi = typeof path.posix;

/**
 * Where a host keeps things, with the path functions of that host's OS. A
 * Windows panel managing a Linux VPS must build Linux paths.
 */
export interface HostLayout {
  path: PathApi;
  dataDir: string;
  serversDir: string;
  backupsDir: string;
  javaDir: string;
  /** Delete-time exports of servers on hosts other than the panel's machine. */
  exportsDir: string;
}

export function layoutFor(dataDir: string, pathApi: PathApi): HostLayout {
  return {
    path: pathApi,
    dataDir,
    serversDir: pathApi.join(dataDir, "servers"),
    backupsDir: pathApi.join(dataDir, "backups"),
    javaDir: pathApi.join(dataDir, "java"),
    exportsDir: pathApi.join(dataDir, "exports"),
  };
}

export class HostUnavailableError extends Error {}

export interface LocalAgentOptions {
  dataDir: string;
  log: DaemonLogger;
  /** "daemon": the panel runs the local agent itself. "external": a service manager does (Docker). */
  mode?: "daemon" | "external";
  /** External mode: where the agent listens. */
  agentHost?: string;
}

/** How long the local agent may be unreachable before the panel starts a new one. */
const RELAUNCH_AFTER_MS = 5_000;

interface Remote {
  link: RemoteHostLink;
  layout: HostLayout;
  unsubscribe: Array<() => void>;
}

/**
 * Resolves a host id to the agent that manages it: the local daemon, or an
 * agent on an SSH host reached through its link. Services subscribe here once
 * and hear from every host, including ones added later.
 */
export class HostManager {
  #local: RemoteAgent | null = null;
  #localLayout: HostLayout | null = null;
  #localOpts: LocalAgentOptions | null = null;
  #localUnsubscribe: Array<() => void> = [];
  #relaunchTimer: NodeJS.Timeout | null = null;
  #relaunching = false;
  #disposed = false;
  #remotes = new Map<string, Remote>();
  #eventHandlers = new Set<(hostId: string, ev: AgentEvent) => void>();
  #connectListeners = new Set<(hostId: string, hello: RpcHello) => void>();
  #statusListeners = new Set<(hostId: string, status: LinkStatus) => void>();

  async init(opts: LocalAgentOptions): Promise<void> {
    this.#localOpts = opts;
    const agent =
      opts.mode === "external"
        ? await connectExternalAgent({ ...opts, host: opts.agentHost ?? "127.0.0.1" })
        : await connectLocalAgent(opts);
    this.#localLayout = layoutFor(path.resolve(opts.dataDir), path);
    this.#setLocal(agent);
  }

  #setLocal(agent: RemoteAgent): void {
    for (const u of this.#localUnsubscribe) u();
    this.#local = agent;
    this.#localUnsubscribe = this.#wire(LOCAL_HOST_ID, agent);
    // A service manager restarts an external agent; the panel's own daemon is the panel's job.
    if (this.#localOpts?.mode === "external") return;
    this.#localUnsubscribe.push(
      agent.onDisconnect(() => this.#scheduleRelaunch(RELAUNCH_AFTER_MS)),
      agent.onEvent((ev) => {
        if (ev.type === "exit" && ev.restartInMs === null) void this.#updateIdleAgent(agent);
      }),
    );
  }

  /**
   * The daemon died (crash, killed from Task Manager): start a fresh one, as
   * the panel would at boot. Servers it ran were already gone with it.
   */
  #scheduleRelaunch(delayMs: number): void {
    if (this.#disposed || this.#relaunchTimer || this.#relaunching) return;
    this.#relaunchTimer = setTimeout(() => {
      this.#relaunchTimer = null;
      void this.#relaunch();
    }, delayMs);
    this.#relaunchTimer.unref();
  }

  async #relaunch(): Promise<void> {
    const opts = this.#localOpts;
    const old = this.#local;
    if (!opts || this.#disposed || old?.connected) return;
    this.#relaunching = true;
    try {
      opts.log.warn("lost the local agent; starting it again");
      const next = await connectLocalAgent(opts);
      if (this.#disposed) {
        next.close();
        return;
      }
      // Swap first so closing the old connection does not count as losing the agent.
      this.#setLocal(next);
      old?.close();
      // It said hello before anyone listened: tell services now so they resync.
      const hello = next.hello;
      if (hello) for (const l of this.#connectListeners) l(LOCAL_HOST_ID, hello);
    } catch (err) {
      opts.log.warn(`could not start the local agent: ${err instanceof Error ? err.message : err}`);
      this.#relaunching = false;
      this.#scheduleRelaunch(30_000);
      return;
    }
    this.#relaunching = false;
  }

  /**
   * After an update the old agent keeps running while it hosts servers. Once
   * the last one stops, replace it with the current build.
   */
  async #updateIdleAgent(agent: RemoteAgent): Promise<void> {
    if (agent !== this.#local || !agent.hello || !isStale(agent.hello, computeBuildId())) return;
    try {
      if ((await agent.running()).length > 0) return;
      this.#localOpts?.log.info(`agent pid ${agent.hello.pid} is idle and outdated; updating it`);
      // Refuses if a server started meanwhile. Disconnecting starts the new build.
      await agent.shutdownDaemon();
    } catch {
      // Busy again, or already gone; the next stop tries again.
    }
  }

  get local(): RemoteAgent {
    if (!this.#local) throw new Error("HostManager.init() has not run");
    return this.#local;
  }

  agentFor(hostId: string): AgentApi {
    return this.remoteFor(hostId);
  }

  /** The connection itself, for file streams that go over HTTP rather than RPC. */
  remoteFor(hostId: string): RemoteAgent {
    if (hostId === LOCAL_HOST_ID) return this.local;
    const remote = this.#remotes.get(hostId);
    if (!remote) throw new HostUnavailableError(`Host ${hostId} does not exist`);
    return remote.link.agent;
  }

  layout(hostId: string): HostLayout {
    if (hostId === LOCAL_HOST_ID) {
      if (!this.#localLayout) throw new Error("HostManager.init() has not run");
      return this.#localLayout;
    }
    const remote = this.#remotes.get(hostId);
    if (!remote) throw new HostUnavailableError(`Host ${hostId} does not exist`);
    return remote.layout;
  }

  link(hostId: string): RemoteHostLink | null {
    return this.#remotes.get(hostId)?.link ?? null;
  }

  isConnected(hostId: string): boolean {
    if (hostId === LOCAL_HOST_ID) return this.#local?.connected ?? false;
    return this.#remotes.get(hostId)?.link.agent.connected ?? false;
  }

  /** Every host with an agent, local first. */
  hostIds(): string[] {
    return [LOCAL_HOST_ID, ...this.#remotes.keys()];
  }

  /** Start managing an SSH host. Its agent events reach every subscriber from now on. */
  async attach(hostId: string, link: RemoteHostLink, dataDir: string): Promise<void> {
    this.detach(hostId);
    const unsubscribe = this.#wire(hostId, link.agent);
    unsubscribe.push(
      link.onStatus((status) => {
        for (const l of this.#statusListeners) l(hostId, status);
      }),
    );
    this.#remotes.set(hostId, { link, layout: layoutFor(dataDir, path.posix), unsubscribe });
    await link.start();
  }

  detach(hostId: string): void {
    const remote = this.#remotes.get(hostId);
    if (!remote) return;
    for (const u of remote.unsubscribe) u();
    remote.link.stop();
    this.#remotes.delete(hostId);
  }

  /** Agent events from every host. */
  onAgentEvent(handler: (hostId: string, ev: AgentEvent) => void): () => void {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  /** Called whenever an agent (re)connects, so callers can resync state. */
  onAgentConnect(listener: (hostId: string, hello: RpcHello) => void): () => void {
    this.#connectListeners.add(listener);
    return () => this.#connectListeners.delete(listener);
  }

  /** Link state changes of SSH hosts (online, offline, locked, ...). */
  onHostStatus(listener: (hostId: string, status: LinkStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** Disconnect from agents. Servers keep running; that is the point of the daemons. */
  dispose(): void {
    this.#disposed = true;
    if (this.#relaunchTimer) clearTimeout(this.#relaunchTimer);
    this.#local?.close();
    for (const id of [...this.#remotes.keys()]) this.detach(id);
  }

  #wire(hostId: string, agent: RemoteAgent): Array<() => void> {
    return [
      agent.onEvent((ev) => {
        for (const h of this.#eventHandlers) h(hostId, ev);
      }),
      agent.onConnect((hello) => {
        for (const l of this.#connectListeners) l(hostId, hello);
      }),
    ];
  }
}
