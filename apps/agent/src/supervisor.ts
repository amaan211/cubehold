import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  parseGcLog,
  parseListOutput,
  parseLogLine,
  parseMsptOutput,
  parseTickQuery,
  parseTpsOutput,
  type TickStats,
} from "@cubehold/mc";
import type { ServerStatus } from "@cubehold/shared";
import { RconClient } from "./rcon.js";
import type { AgentEvent, LaunchRequest } from "./types.js";

const RCON_RETRY_MS = 3_000;
const RCON_ATTEMPTS = 40; // two minutes: big modpacks open RCON well after "Done"
const POLL_MS = 10_000;
const LIST_SYNC_MS = 60_000;
const GC_TAIL_BYTES = 8 * 1024;
/** How long a stop waits for a server that is still loading (big modpacks are slow). */
const STARTUP_WAIT_MS = 5 * 60_000;

/**
 * Supervises a single Minecraft server process: spawns java, streams its
 * output line by line, tracks status from the log, handles graceful stop,
 * and keeps an RCON connection for commands with replies and TPS.
 */
export class ServerProcess extends EventEmitter<{ event: [AgentEvent] }> {
  readonly serverId: string;
  #child: ChildProcess | null = null;
  #status: ServerStatus = "stopped";
  #players = new Set<string>();
  #stopRequested = false;
  #stoppedBy: "idle" | null = null;
  #lastReason: string | null = null;
  #exitPromise: Promise<void> | null = null;
  #startedAt = 0;
  #rcon: RconClient | null = null;
  #timer: NodeJS.Timeout | null = null;
  #tick: TickStats = { tps: null, mspt: null };
  #heapUsedMb: number | null = null;
  #lastListSync = 0;
  /** "Done" was logged: the server accepts commands. */
  #loaded = false;
  #loadedWaiters: Array<() => void> = [];

  constructor(readonly req: LaunchRequest) {
    super();
    this.serverId = req.serverId;
  }

  get status(): ServerStatus {
    return this.#status;
  }

  get directory(): string {
    return this.req.directory;
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  get players(): string[] {
    return [...this.#players];
  }

  get tickStats(): TickStats {
    return this.#tick;
  }

  get heapUsedMb(): number | null {
    return this.#heapUsedMb;
  }

  get rconConnected(): boolean {
    return this.#rcon?.connected ?? false;
  }

  start(): void {
    if (this.#child) throw new Error("process already started");
    this.#stopRequested = false;
    this.#stoppedBy = null;
    this.#lastReason = null;
    this.#loaded = false;
    this.#players.clear();
    this.#tick = { tps: null, mspt: null };
    this.#heapUsedMb = null;
    this.#startedAt = Date.now();
    this.#prepareGcLog();

    const child = spawn(this.req.javaPath, this.req.args, {
      cwd: this.req.directory,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, JAVA_TOOL_OPTIONS: undefined },
    });
    this.#child = child;
    this.#setStatus("starting");

    this.#pipe(child.stdout, "stdout");
    this.#pipe(child.stderr, "stderr");

    this.#exitPromise = new Promise<void>((resolve) => {
      child.once("error", (err) => {
        this.#line(`Failed to start java: ${err.message}`, "stderr");
      });
      child.once("exit", (code, signal) => {
        const pid = child.pid ?? null;
        const expected = this.#stopRequested;
        this.#child = null;
        this.#players.clear();
        this.#stopRcon();
        void (async () => {
          const crashReport =
            expected && code === 0
              ? null
              : await findCrashReport(this.req.directory, this.#startedAt, pid);
          this.#setStatus(expected || code === 0 ? "stopped" : "crashed");
          this.#emit({
            type: "exit",
            serverId: this.serverId,
            at: Date.now(),
            code,
            signal,
            expected,
            reason: this.#lastReason,
            crashReport,
            restartInMs: null,
            stoppedBy: this.#stoppedBy,
          });
          resolve();
        })();
      });
    });
  }

  send(command: string): void {
    const child = this.#child;
    if (!child?.stdin || child.stdin.destroyed) throw new Error("server is not running");
    child.stdin.write(`${command.replace(/\r?\n/g, " ")}\n`);
  }

  /** Run a command and return its reply over RCON; falls back to stdin (reply null). */
  async command(command: string): Promise<string | null> {
    const cmd = command.replace(/^\//, "").replace(/\r?\n/g, " ");
    // No fallback after an RCON failure: the command may already have run.
    if (this.#rcon?.connected) return this.#rcon.command(cmd, 120_000);
    this.send(cmd);
    return null;
  }

  /**
   * Send `stop`, wait for exit, escalate to kill after the timeout. A
   * server that is still loading is stopped the moment it has finished:
   * Paper runs a `stop` it received during startup too early and fails it,
   * then keeps running.
   */
  async stop(timeoutMs = 60_000, by: "idle" | null = null): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const stillLoading = !this.#loaded;
    this.#stopRequested = true;
    this.#stoppedBy = by;
    this.#setStatus("stopping");
    if (stillLoading) {
      this.#line(
        `The server is still starting. It stops as soon as it has finished loading (killed if that takes more than ${Math.round(STARTUP_WAIT_MS / 60_000)} minutes).`,
        "system",
      );
      const outcome = await Promise.race([
        this.#whenLoaded().then(() => "loaded" as const),
        this.waitForExit().then(() => "exited" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), STARTUP_WAIT_MS).unref()),
      ]);
      if (outcome === "exited" || !this.#child) return;
      if (outcome === "timeout") {
        this.#line("Still not loaded; killing it.", "stderr");
        await this.kill();
        return;
      }
    }
    this.#line(
      `Asked the server to stop; it is killed if it has not stopped within ${Math.round(timeoutMs / 1000)}s.`,
      "system",
    );
    let sent = false;
    try {
      this.send("stop");
      sent = true;
    } catch {
      // stdin gone; RCON below, or the kill after the timeout
    }
    // Also over RCON: if console input is not reaching the server (a wrapper, a
    // stuck console thread), RCON still does. A second "stop" is ignored.
    if (this.#rcon?.connected) {
      this.#rcon.command("stop", 10_000).catch(() => {});
      sent = true;
    }
    if (!sent) this.#line("Could not send stop to the server; killing it.", "system");
    const exited = sent ? await this.#waitForExit(timeoutMs) : false;
    if (!exited) {
      this.#line(
        `Server did not stop within ${Math.round(timeoutMs / 1000)}s, killing it.`,
        "stderr",
      );
      await this.kill();
    }
  }

  async kill(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopRequested = true;
    child.kill("SIGKILL");
    await this.#waitForExit(10_000);
  }

  waitForExit(): Promise<void> {
    return this.#exitPromise ?? Promise.resolve();
  }

  #whenLoaded(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    return new Promise((resolve) => this.#loadedWaiters.push(resolve));
  }

  /** Refresh the heap figure from the GC log tail. Cheap: reads the last few KB. */
  async readHeap(): Promise<number | null> {
    if (!this.req.gcLog) return null;
    const tail = await readTail(path.join(this.req.directory, this.req.gcLog), GC_TAIL_BYTES);
    const reading = tail ? parseGcLog(tail) : null;
    if (reading) this.#heapUsedMb = reading.usedMb;
    return this.#heapUsedMb;
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.#exitPromise) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    });
    const result = await Promise.race([this.#exitPromise.then(() => true as const), timeout]);
    clearTimeout(timer);
    return result;
  }

  #prepareGcLog(): void {
    if (!this.req.gcLog) return;
    const file = path.join(this.req.directory, this.req.gcLog);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A stale log from the last run would show its heap until the first GC.
      for (const name of fs.readdirSync(path.dirname(file))) {
        if (name.startsWith(path.basename(file)))
          fs.rmSync(path.join(path.dirname(file), name), { force: true });
      }
    } catch {
      // heap figure is best effort
    }
  }

  // --- RCON ------------------------------------------------------------------

  #startRcon(): void {
    const cfg = this.req.rcon;
    if (!cfg || this.#timer) return;
    let attempts = 0;
    const tryConnect = async () => {
      this.#timer = null;
      if (!this.#child || this.#status !== "running") return;
      const client = new RconClient("127.0.0.1", cfg.port, cfg.password);
      try {
        await client.connect(3_000);
      } catch (err) {
        client.close();
        const message = err instanceof Error ? err.message : String(err);
        if (/password/i.test(message) || ++attempts >= RCON_ATTEMPTS) {
          this.#line(
            `RCON unavailable (${message}); player actions fall back to the console and TPS is not shown.`,
            "system",
          );
          return;
        }
        this.#timer = setTimeout(() => void tryConnect(), RCON_RETRY_MS);
        return;
      }
      if (!this.#child) {
        client.close();
        return;
      }
      this.#rcon = client;
      await this.#poll();
    };
    this.#timer = setTimeout(() => void tryConnect(), 500);
  }

  async #poll(): Promise<void> {
    this.#timer = null;
    const rcon = this.#rcon;
    if (!rcon?.connected || !this.#child) return;
    try {
      if (this.req.tpsCommand === "tps") {
        const tps = parseTpsOutput(await rcon.command("tps"));
        const mspt = parseMsptOutput(await rcon.command("mspt").catch(() => ""));
        this.#tick = { tps, mspt };
      } else if (this.req.tpsCommand === "tick query") {
        this.#tick = parseTickQuery(await rcon.command("tick query"));
      }
      if (Date.now() - this.#lastListSync >= LIST_SYNC_MS) {
        this.#lastListSync = Date.now();
        const list = parseListOutput(await rcon.command("list"));
        if (list) this.#syncPlayers(list.players);
      }
    } catch {
      // a slow tick or dropped connection; try again next round
    }
    if (!rcon.connected && this.#child) {
      this.#rcon = null;
      this.#startRcon(); // reconnect
      return;
    }
    if (this.#child) this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  /** The log is the fast path for joins and leaves; `list` corrects anything it missed. */
  #syncPlayers(players: string[]): void {
    const next = new Set(players);
    const same = next.size === this.#players.size && [...next].every((p) => this.#players.has(p));
    if (same) return;
    this.#players = next;
    this.#emitPlayers();
  }

  #stopRcon(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#rcon?.close();
    this.#rcon = null;
    this.#tick = { tps: null, mspt: null };
  }

  // --- output ------------------------------------------------------------------

  #pipe(stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr"): void {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      this.#emit({ type: "line", serverId: this.serverId, at: Date.now(), line, stream: name });
      this.#inspect(line);
    });
  }

  #inspect(line: string): void {
    const ev = parseLogLine(line);
    if (!ev) return;
    switch (ev.type) {
      case "done":
        this.#loaded = true;
        for (const resolve of this.#loadedWaiters.splice(0)) resolve();
        if (this.#status === "starting") {
          this.#setStatus("running");
          this.#startRcon();
        }
        break;
      case "join":
        this.#players.add(ev.player);
        this.#emitPlayers();
        break;
      case "leave":
        if (this.#players.delete(ev.player)) this.#emitPlayers();
        break;
      case "stopping":
        if (this.#status === "running" || this.#status === "starting") this.#setStatus("stopping");
        break;
      case "eula":
      case "port_in_use":
      case "outdated_java":
      case "crash":
        this.#lastReason = ev.type;
        break;
      default:
        break;
    }
  }

  #line(line: string, stream: "stderr" | "system"): void {
    this.#emit({ type: "line", serverId: this.serverId, at: Date.now(), line, stream });
  }

  #emitPlayers(): void {
    this.#emit({ type: "players", serverId: this.serverId, at: Date.now(), players: this.players });
  }

  #setStatus(status: ServerStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit({ type: "status", serverId: this.serverId, at: Date.now(), status });
  }

  #emit(event: AgentEvent): void {
    this.emit("event", event);
  }
}

/**
 * The crash report this run wrote, if any: a JVM error log for this pid, or
 * the newest file in crash-reports/ written after the process started.
 */
async function findCrashReport(
  directory: string,
  startedAt: number,
  pid: number | null,
): Promise<string | null> {
  if (pid !== null) {
    const hsErr = `hs_err_pid${pid}.log`;
    if (fs.existsSync(path.join(directory, hsErr))) return hsErr;
  }
  try {
    const dir = path.join(directory, "crash-reports");
    let newest: { name: string; mtime: number } | null = null;
    for (const name of await fs.promises.readdir(dir)) {
      if (!name.endsWith(".txt")) continue;
      const { mtimeMs } = await fs.promises.stat(path.join(dir, name));
      if (mtimeMs >= startedAt - 1000 && (!newest || mtimeMs > newest.mtime)) {
        newest = { name, mtime: mtimeMs };
      }
    }
    return newest ? `crash-reports/${newest.name}` : null;
  } catch {
    return null;
  }
}

async function readTail(file: string, bytes: number): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
