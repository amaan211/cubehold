import { EventEmitter } from "node:events";
import type {
  ConsoleLine,
  MetricsTick,
  RealtimeEvent,
  ServerSnapshot,
  ServerStatus,
  TaskProgress,
} from "@cubehold/shared";

const CONSOLE_HISTORY = 500;
const METRICS_HISTORY = 150; // 5 minutes at one tick per 2 seconds

class Ring<T> {
  #items: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.cap) this.#items.splice(0, this.#items.length - this.cap);
  }
  all(): T[] {
    return [...this.#items];
  }
  clear(): void {
    this.#items = [];
  }
}

interface ServerState {
  status: ServerStatus;
  players: string[];
  console: Ring<ConsoleLine>;
  metrics: Ring<MetricsTick>;
  /** Running background tasks by id. */
  tasks: Map<string, TaskProgress>;
}

/**
 * Process-wide event bus for realtime updates. Keeps a short history per
 * server so a freshly opened dashboard can show the recent console and
 * charts without waiting for new data.
 */
export class RealtimeBus extends EventEmitter<{ event: [RealtimeEvent] }> {
  #servers = new Map<string, ServerState>();

  #state(serverId: string): ServerState {
    let s = this.#servers.get(serverId);
    if (!s) {
      s = {
        status: "stopped",
        players: [],
        console: new Ring(CONSOLE_HISTORY),
        metrics: new Ring(METRICS_HISTORY),
        tasks: new Map(),
      };
      this.#servers.set(serverId, s);
    }
    return s;
  }

  publish(event: RealtimeEvent): void {
    const s = this.#state(event.data.serverId);
    switch (event.type) {
      case "console.line":
        s.console.push(event.data);
        break;
      case "metrics.tick":
        s.metrics.push(event.data);
        break;
      case "status.changed":
        s.status = event.data.status;
        if (event.data.status === "stopped" || event.data.status === "crashed") {
          s.players = [];
          s.metrics.clear();
        }
        break;
      case "players.changed":
        s.players = event.data.players;
        break;
      case "install.progress":
        break;
      case "task.progress":
        if (event.data.state === "running") s.tasks.set(event.data.taskId, event.data);
        else s.tasks.delete(event.data.taskId);
        break;
    }
    this.emit("event", event);
  }

  /** Convenience for panel-generated console lines (install steps, errors). */
  system(serverId: string, line: string): void {
    this.publish({
      type: "console.line",
      data: { serverId, at: Date.now(), line, stream: "system" },
    });
  }

  setStatus(serverId: string, status: ServerStatus): void {
    if (this.#state(serverId).status === status) return;
    this.publish({ type: "status.changed", data: { serverId, at: Date.now(), status } });
  }

  /**
   * Adopt state reported by an agent. Console history is only filled when the
   * panel has none yet, so live lines and panel messages are never discarded.
   */
  seed(
    serverId: string,
    data: { status: ServerStatus; players: string[]; console: ConsoleLine[] },
  ): void {
    const s = this.#state(serverId);
    if (s.console.all().length === 0) for (const line of data.console) s.console.push(line);
    this.setStatus(serverId, data.status);
    if (s.players.join("\n") !== data.players.join("\n")) {
      this.publish({
        type: "players.changed",
        data: { serverId, at: Date.now(), players: data.players },
      });
    }
  }

  snapshot(serverId: string): ServerSnapshot {
    const s = this.#state(serverId);
    return {
      serverId,
      status: s.status,
      players: s.players,
      console: s.console.all(),
      metrics: s.metrics.all(),
      tasks: [...s.tasks.values()],
    };
  }

  /** Resolve when a console line matches, or with null after the timeout. */
  waitForLine(serverId: string, pattern: RegExp, timeoutMs: number): Promise<ConsoleLine | null> {
    return new Promise((resolve) => {
      const onEvent = (event: RealtimeEvent) => {
        if (
          event.type === "console.line" &&
          event.data.serverId === serverId &&
          pattern.test(event.data.line)
        ) {
          done(event.data);
        }
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (line: ConsoleLine | null) => {
        clearTimeout(timer);
        this.off("event", onEvent);
        resolve(line);
      };
      this.on("event", onEvent);
    });
  }

  forget(serverId: string): void {
    this.#servers.delete(serverId);
  }
}
