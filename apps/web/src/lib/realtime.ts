import type {
  ClientMessage,
  ConsoleLine,
  InstallProgress,
  MetricsTick,
  ServerMessage,
  ServerStatus,
  TaskProgress,
} from "@cubehold/shared";
import { useSyncExternalStore } from "react";

const CONSOLE_CAP = 1000;
const METRICS_CAP = 150;

export interface ServerLive {
  status: ServerStatus;
  players: string[];
  console: ConsoleLine[];
  metrics: MetricsTick[];
  install: InstallProgress | null;
  /** Background jobs in progress (backups, restores, archives, plugin installs). */
  tasks: TaskProgress[];
  /** True once the first snapshot arrived. */
  ready: boolean;
}

export type ConnectionState = "connecting" | "open" | "closed";

const EMPTY: ServerLive = {
  status: "stopped",
  players: [],
  console: [],
  metrics: [],
  install: null,
  tasks: [],
  ready: false,
};

type Listener = () => void;

/**
 * One WebSocket for the whole app. Components subscribe to server ids; the
 * store keeps per-server state and notifies React through useSyncExternalStore.
 */
class RealtimeStore {
  #ws: WebSocket | null = null;
  #state: ConnectionState = "closed";
  #servers = new Map<string, ServerLive>();
  #refs = new Map<string, number>();
  #listeners = new Map<string, Set<Listener>>();
  #connListeners = new Set<Listener>();
  #retry = 0;
  #lineListeners = new Map<string, Set<(line: ConsoleLine) => void>>();
  #taskListeners = new Set<(task: TaskProgress) => void>();

  get connection(): ConnectionState {
    return this.#state;
  }

  get(serverId: string): ServerLive {
    return this.#servers.get(serverId) ?? EMPTY;
  }

  subscribe(serverId: string, listener: Listener): () => void {
    let set = this.#listeners.get(serverId);
    if (!set) {
      set = new Set();
      this.#listeners.set(serverId, set);
    }
    set.add(listener);
    const refs = (this.#refs.get(serverId) ?? 0) + 1;
    this.#refs.set(serverId, refs);
    if (refs === 1) this.#send({ type: "subscribe", serverId });
    this.#ensure();
    return () => {
      set?.delete(listener);
      const n = (this.#refs.get(serverId) ?? 1) - 1;
      if (n <= 0) {
        this.#refs.delete(serverId);
        this.#send({ type: "unsubscribe", serverId });
        // Keep the cached state so navigating back is instant.
      } else {
        this.#refs.set(serverId, n);
      }
    };
  }

  onConnection(listener: Listener): () => void {
    this.#connListeners.add(listener);
    return () => this.#connListeners.delete(listener);
  }

  /** Streaming console consumers (xterm) want lines as they arrive, not re-renders. */
  onLine(serverId: string, cb: (line: ConsoleLine) => void): () => void {
    let set = this.#lineListeners.get(serverId);
    if (!set) {
      set = new Set();
      this.#lineListeners.set(serverId, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  /** Every task update for subscribed servers, including the final done/failed one. */
  onTask(cb: (task: TaskProgress) => void): () => void {
    this.#taskListeners.add(cb);
    return () => this.#taskListeners.delete(cb);
  }

  #ensure(): void {
    if (
      this.#ws &&
      (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)
    )
      return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.#ws = ws;
    this.#setState("connecting");
    ws.onopen = () => {
      this.#retry = 0;
      this.#setState("open");
      for (const serverId of this.#refs.keys()) this.#send({ type: "subscribe", serverId });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.#handle(msg);
    };
    ws.onclose = (ev) => {
      this.#ws = null;
      this.#setState("closed");
      if (ev.code === 4401) return; // not logged in; the router will redirect
      if (this.#refs.size === 0) return;
      const delay = Math.min(15_000, 500 * 2 ** this.#retry++);
      window.setTimeout(() => this.#ensure(), delay);
    };
    ws.onerror = () => ws.close();
  }

  #send(msg: ClientMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #handle(msg: ServerMessage): void {
    if (msg.type === "pong") return;
    const serverId = msg.data.serverId;
    const prev = this.get(serverId);
    let next: ServerLive;
    switch (msg.type) {
      case "snapshot":
        next = {
          status: msg.data.status,
          players: msg.data.players,
          console: msg.data.console.slice(-CONSOLE_CAP),
          metrics: msg.data.metrics.slice(-METRICS_CAP),
          install: prev.install,
          tasks: msg.data.tasks,
          ready: true,
        };
        break;
      case "task.progress": {
        const others = prev.tasks.filter((t) => t.taskId !== msg.data.taskId);
        next = {
          ...prev,
          tasks: msg.data.state === "running" ? [...others, msg.data] : others,
        };
        for (const cb of this.#taskListeners) cb(msg.data);
        break;
      }
      case "console.line":
        next = { ...prev, console: append(prev.console, msg.data, CONSOLE_CAP) };
        for (const cb of this.#lineListeners.get(serverId) ?? []) cb(msg.data);
        break;
      case "metrics.tick":
        next = { ...prev, metrics: append(prev.metrics, msg.data, METRICS_CAP) };
        break;
      case "status.changed":
        next = {
          ...prev,
          status: msg.data.status,
          players:
            msg.data.status === "running" || msg.data.status === "starting" ? prev.players : [],
          metrics:
            msg.data.status === "stopped" || msg.data.status === "crashed" ? [] : prev.metrics,
        };
        break;
      case "players.changed":
        next = { ...prev, players: msg.data.players };
        break;
      case "install.progress":
        next = { ...prev, install: msg.data.step === "done" ? null : msg.data };
        break;
      default:
        return;
    }
    this.#servers.set(serverId, next);
    for (const l of this.#listeners.get(serverId) ?? []) l();
  }

  #setState(s: ConnectionState): void {
    this.#state = s;
    for (const l of this.#connListeners) l();
  }
}

function append<T>(arr: T[], item: T, cap: number): T[] {
  const out = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice();
  out.push(item);
  return out;
}

export const realtime = new RealtimeStore();

export function useServerLive(serverId: string): ServerLive {
  return useSyncExternalStore(
    (cb) => realtime.subscribe(serverId, cb),
    () => realtime.get(serverId),
    () => EMPTY,
  );
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (cb) => realtime.onConnection(cb),
    () => realtime.connection,
    () => "closed",
  );
}
