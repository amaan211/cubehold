import { randomBytes } from "node:crypto";
import type { TaskProgress } from "@cubehold/shared";
import type { RealtimeBus } from "../realtime/bus.js";

export type TaskKind = TaskProgress["kind"];

/**
 * One background job on a server, reported to the browser as task.progress
 * events. Agent progress events for the job arrive under the same id.
 */
export class Task {
  #percent: number | null = null;
  #message: string | null = null;
  #lastSent = 0;

  constructor(
    private readonly tasks: Tasks,
    readonly id: string,
    readonly serverId: string,
    readonly kind: TaskKind,
    readonly label: string,
  ) {}

  progress(percent: number | null, message?: string | null): void {
    this.#percent = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
    if (message !== undefined) this.#message = message;
    const now = Date.now();
    if (now - this.#lastSent < 250) return; // plenty for a progress bar
    this.#lastSent = now;
    this.#send("running");
  }

  /** Agent progress in bytes. */
  bytes(done: number, total: number | null): void {
    this.progress(total ? (done / total) * 100 : null);
  }

  done(message: string | null = null): void {
    this.#message = message;
    this.#percent = 100;
    this.#send("done");
    this.tasks.forget(this.id);
  }

  fail(message: string): void {
    this.#message = message;
    this.#send("failed");
    this.tasks.forget(this.id);
  }

  #send(state: TaskProgress["state"]): void {
    this.tasks.bus.publish({
      type: "task.progress",
      data: {
        serverId: this.serverId,
        at: Date.now(),
        taskId: this.id,
        kind: this.kind,
        label: this.label,
        state,
        percent: this.#percent,
        message: this.#message,
      },
    });
  }
}

/** Anything agent "progress" events can be routed to by id. */
interface ProgressSink {
  bytes(done: number, total: number | null): void;
}

export class Tasks {
  #byId = new Map<string, ProgressSink>();

  constructor(readonly bus: RealtimeBus) {}

  start(serverId: string, kind: TaskKind, label: string): Task {
    const task = new Task(this, `${kind}-${randomBytes(6).toString("hex")}`, serverId, kind, label);
    this.#byId.set(task.id, task);
    task.progress(null);
    return task;
  }

  get(id: string): ProgressSink | undefined {
    return this.#byId.get(id);
  }

  /**
   * An id for agent progress that reaches `onBytes` instead of the browser,
   * for jobs that are one phase of a bigger task.
   */
  relay(onBytes: (done: number, total: number | null) => void): { id: string; dispose(): void } {
    const id = `relay-${randomBytes(6).toString("hex")}`;
    this.#byId.set(id, { bytes: onBytes });
    return { id, dispose: () => this.#byId.delete(id) };
  }

  forget(id: string): void {
    this.#byId.delete(id);
  }

  /** Run fn as a task: done on success, failed (and rethrown) on error. */
  async run<T>(
    serverId: string,
    kind: TaskKind,
    label: string,
    fn: (task: Task) => Promise<T>,
    doneMessage?: (result: T) => string | null,
  ): Promise<T> {
    const task = this.start(serverId, kind, label);
    try {
      const result = await fn(task);
      task.done(doneMessage ? doneMessage(result) : null);
      return result;
    } catch (err) {
      task.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
