import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import type { TunnelEndpoint, TunnelKind, TunnelSpec, TunnelStatus } from "./types.js";

const MAX_LINES = 200;
/** Waits before restarting a tunnel program that exited on its own. */
const RESTART_DELAYS_MS = [5_000, 15_000, 60_000];
const POLL_MS = 4_000;
/** Terminal colour codes (ESC [ ... letter). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** What a log line means for the tunnel. `fatal`: restarting cannot help. */
interface LineVerdict {
  state?: TunnelStatus["state"];
  error?: string;
  fatal?: boolean;
  endpoint?: TunnelEndpoint;
}

const PLAYIT_RULES: Array<{ re: RegExp; verdict: LineVerdict }> = [
  {
    re: /playit connected; tunnels loaded|playit tunnel state updated/i,
    verdict: { state: "connected" },
  },
  {
    re: /secret is no longer valid|Invalid secret passed|InvalidAgentKey/i,
    verdict: {
      state: "error",
      error:
        "playit.gg no longer accepts this agent (it may have been deleted on playit.gg). Link playit.gg again.",
      fatal: true,
    },
  },
  {
    re: /over the agent limit/i,
    verdict: {
      state: "error",
      error:
        "Your playit.gg account has reached its agent limit. Remove an old agent on playit.gg.",
    },
  },
  {
    re: /Could not open a required network socket/i,
    verdict: {
      state: "error",
      error: "playit could not open a network socket; another playit may be running.",
    },
  },
];

/** ngrok error codes worth explaining. https://ngrok.com/docs/errors/ */
const NGROK_ERRORS: Record<string, { error: string; fatal: boolean }> = {
  "105": {
    error: "ngrok rejected the authtoken. Copy it again from the ngrok dashboard.",
    fatal: true,
  },
  "106": {
    error: "ngrok rejected the authtoken. Copy it again from the ngrok dashboard.",
    fatal: true,
  },
  "107": {
    error: "ngrok rejected the authtoken. Copy it again from the ngrok dashboard.",
    fatal: true,
  },
  "108": {
    error:
      "Your ngrok account is already connected somewhere else. Free accounts allow one ngrok at a time.",
    fatal: false,
  },
  "8013": {
    error:
      "ngrok needs a card on your account before it gives out TCP addresses (it is not charged). Add one in the ngrok dashboard.",
    fatal: true,
  },
  "324": { error: "Your ngrok plan does not allow this many endpoints at once.", fatal: true },
};

function ngrokLine(line: string): LineVerdict | null {
  let j: { lvl?: string; msg?: string; err?: string; url?: string; name?: string; addr?: string };
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  const code = /ERR_NGROK_(\d+)/.exec(j.err ?? j.msg ?? "")?.[1];
  if (code && NGROK_ERRORS[code]) return { state: "error", ...NGROK_ERRORS[code] };
  if ((j.lvl === "eror" || j.lvl === "crit") && j.err) {
    return { state: "error", error: (j.err.split("\n")[0] ?? j.err).trim() };
  }
  if (j.url && /^tcp:\/\//.test(j.url)) {
    return {
      state: "connected",
      endpoint: { name: j.name ?? null, url: j.url, target: j.addr ?? null },
    };
  }
  if (/client session established/i.test(j.msg ?? "")) return { state: "connected" };
  return null;
}

function cloudflaredLine(line: string): LineVerdict | null {
  if (/Registered tunnel connection/.test(line)) return { state: "connected" };
  if (
    /Failed to get tunnel|Unauthorized|invalid tunnel secret|Provided Tunnel token is not valid/i.test(
      line,
    )
  ) {
    return {
      state: "error",
      error:
        "Cloudflare does not accept this tunnel token. Copy it again from the Cloudflare dashboard.",
    };
  }
  return null;
}

function playitLine(line: string): LineVerdict | null {
  return PLAYIT_RULES.find((r) => r.re.test(line))?.verdict ?? null;
}

const INTERPRET: Record<TunnelKind, (line: string) => LineVerdict | null> = {
  playit: playitLine,
  ngrok: ngrokLine,
  cloudflared: cloudflaredLine,
};

/**
 * Runs one tunnel program (playitd, ngrok or cloudflared) and keeps it
 * running: restarts it if it exits, except after an error a restart cannot
 * fix (a rejected key). Keeps a log with secrets removed, and reads public
 * addresses from the program's log or local status server.
 */
export class TunnelProcess {
  #spec: TunnelSpec | null = null;
  #child: ChildProcess | null = null;
  #lines: string[] = [];
  #restartTimer: NodeJS.Timeout | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #restarts = 0;
  #stopping = false;
  #fatal = false;
  #status: TunnelStatus = emptyStatus();

  constructor(readonly kind: TunnelKind) {}

  status(): TunnelStatus {
    return { ...this.#status, lines: [...this.#lines], endpoints: [...this.#status.endpoints] };
  }

  get running(): boolean {
    return this.#child !== null;
  }

  /** Start, restart with a new command line, or stop (null). */
  async set(spec: TunnelSpec | null): Promise<TunnelStatus> {
    const same =
      spec &&
      this.#spec &&
      JSON.stringify(spec) === JSON.stringify(this.#spec) &&
      (this.#child !== null || this.#restartTimer !== null);
    if (same) return this.status();
    await this.stop();
    this.#spec = spec;
    this.#restarts = 0;
    if (spec) await this.#start();
    return this.status();
  }

  async stop(): Promise<void> {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#stopPolling();
    const child = this.#child;
    this.#spec = null;
    if (child) {
      this.#stopping = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
      this.#stopping = false;
    }
    this.#child = null;
    this.#status = emptyStatus();
  }

  async #start(): Promise<void> {
    const spec = this.#spec;
    if (!spec) return;
    if (!fs.existsSync(spec.binary)) {
      this.#status = {
        ...emptyStatus(),
        state: "error",
        error: `${this.kind} is not installed (${spec.binary})`,
      };
      return;
    }
    await killLeftover(spec);
    this.#fatal = false;
    this.#push(`Starting ${this.kind}`);
    const child = spawn(spec.binary, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PLAYIT_LOG: "info", NO_COLOR: "1", ...spec.env },
    });
    this.#child = child;
    this.#status = {
      ...emptyStatus(),
      state: "starting",
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      restarts: this.#restarts,
    };
    if (child.pid && spec.pidFile) {
      fs.writeFileSync(spec.pidFile, JSON.stringify({ pid: child.pid, binary: spec.binary }));
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on("line", (raw) => this.#onLine(raw));
    }
    child.on("error", (err) => {
      this.#push(`${this.kind} failed to start: ${err.message}`);
      this.#status = { ...this.#status, state: "error", error: err.message };
    });
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#stopPolling();
      if (spec.pidFile) fs.rmSync(spec.pidFile, { force: true });
      if (this.#stopping) return;
      this.#push(`${this.kind} exited (${signal ?? `code ${code}`})`);
      if ((this.#status.state === "error" && this.#fatal) || this.#spec !== spec) {
        this.#status = { ...this.#status, pid: null, endpoints: [] };
        return;
      }
      const delay =
        RESTART_DELAYS_MS[Math.min(this.#restarts, RESTART_DELAYS_MS.length - 1)] ?? 60_000;
      this.#restarts++;
      this.#status = {
        ...this.#status,
        state: "error",
        pid: null,
        endpoints: [],
        restarts: this.#restarts,
        error:
          this.#status.error ??
          `${this.kind} stopped unexpectedly; restarting in ${delay / 1000} s`,
      };
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        if (this.#spec === spec) void this.#start();
      }, delay);
      this.#restartTimer.unref();
    });
    if (spec.statusAddr) this.#schedulePoll(spec, 1_500);
  }

  #onLine(raw: string): void {
    let line = raw.replace(ANSI, "").trimEnd();
    for (const secret of this.#spec?.redact ?? []) {
      if (secret) line = line.split(secret).join("[hidden]");
    }
    if (!line) return;
    this.#push(line);
    const v = INTERPRET[this.kind](line);
    if (!v) return;
    if (v.state === "connected") {
      this.#fatal = false;
      const endpoints = v.endpoint
        ? [...this.#status.endpoints.filter((e) => e.url !== v.endpoint?.url), v.endpoint]
        : this.#status.endpoints;
      this.#status = {
        ...this.#status,
        state: "connected",
        error: null,
        endpoints,
        connectedAt: this.#status.connectedAt ?? new Date().toISOString(),
      };
      // A stable connection earns back the restart budget.
      this.#restarts = 0;
    } else if (v.state === "error") {
      this.#fatal = v.fatal === true;
      this.#status = { ...this.#status, state: "error", error: v.error ?? line };
    }
  }

  // --- local status servers ---------------------------------------------------------

  #schedulePoll(spec: TunnelSpec, delay = POLL_MS): void {
    this.#pollTimer = setTimeout(() => void this.#poll(spec), delay);
    this.#pollTimer.unref();
  }

  #stopPolling(): void {
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #poll(spec: TunnelSpec): Promise<void> {
    if (this.#spec !== spec || !this.#child || !spec.statusAddr) return;
    try {
      if (this.kind === "ngrok") await this.#pollNgrok(spec.statusAddr);
      else if (this.kind === "cloudflared") await this.#pollCloudflared(spec.statusAddr);
    } catch {
      // not listening yet, or restarting
    }
    if (this.#spec === spec && this.#child) this.#schedulePoll(spec);
  }

  /** ngrok's agent API lists running endpoints with their public URLs. */
  async #pollNgrok(addr: string): Promise<void> {
    const get = async (path: string) => {
      const res = await fetch(`http://${addr}${path}`, { signal: AbortSignal.timeout(3_000) });
      return res.ok ? ((await res.json()) as unknown) : null;
    };
    const eps = (await get("/api/endpoints")) as
      | { endpoints?: Array<{ name?: string; url?: string; upstream?: { url?: string } }> }
      | Array<{ name?: string; url?: string; upstream?: { url?: string } }>
      | null;
    let endpoints: TunnelEndpoint[] = (Array.isArray(eps) ? eps : (eps?.endpoints ?? []))
      .filter((e) => typeof e.url === "string")
      .map((e) => ({
        name: e.name ?? null,
        url: e.url as string,
        target: e.upstream?.url ?? null,
      }));
    if (endpoints.length === 0) {
      const t = (await get("/api/tunnels")) as {
        tunnels?: Array<{ name?: string; public_url?: string; config?: { addr?: string } }>;
      } | null;
      endpoints = (t?.tunnels ?? [])
        .filter((x) => typeof x.public_url === "string")
        .map((x) => ({
          name: x.name ?? null,
          url: x.public_url as string,
          target: x.config?.addr ?? null,
        }));
    }
    if (endpoints.length > 0) {
      this.#status = {
        ...this.#status,
        state: "connected",
        error: null,
        endpoints,
        connectedAt: this.#status.connectedAt ?? new Date().toISOString(),
      };
    }
  }

  /** cloudflared's metrics server: /ready says whether it is connected, /config which hostnames lead where. */
  async #pollCloudflared(addr: string): Promise<void> {
    const ready = await fetch(`http://${addr}/ready`, { signal: AbortSignal.timeout(3_000) });
    const config = (await fetch(`http://${addr}/config`, { signal: AbortSignal.timeout(3_000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as {
      config?: { ingress?: Array<{ hostname?: string; service?: string }> };
    } | null;
    const endpoints: TunnelEndpoint[] = (config?.config?.ingress ?? [])
      .filter((r) => r.hostname)
      .map((r) => ({
        name: r.hostname as string,
        url: r.hostname as string,
        target: r.service ?? null,
      }));
    if (ready.ok) {
      this.#status = {
        ...this.#status,
        state: "connected",
        error: null,
        endpoints,
        connectedAt: this.#status.connectedAt ?? new Date().toISOString(),
      };
    } else {
      this.#status = { ...this.#status, endpoints, connectedAt: null };
      if (this.#status.state === "connected") this.#status.state = "starting";
    }
  }

  #push(line: string): void {
    this.#lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (this.#lines.length > MAX_LINES) this.#lines.splice(0, this.#lines.length - MAX_LINES);
  }
}

function emptyStatus(): TunnelStatus {
  return {
    state: "stopped",
    pid: null,
    startedAt: null,
    connectedAt: null,
    error: null,
    restarts: 0,
    lines: [],
    endpoints: [],
  };
}

/**
 * A tunnel program from an earlier agent (one that crashed, say) would fight
 * the new one. Kill it, but only if that pid is still our binary: pids get
 * reused.
 */
async function killLeftover(spec: TunnelSpec): Promise<void> {
  if (!spec.pidFile || !fs.existsSync(spec.pidFile)) return;
  let pid = 0;
  try {
    pid = Number((JSON.parse(fs.readFileSync(spec.pidFile, "utf8")) as { pid: number }).pid);
  } catch {
    // unreadable; treat as gone
  }
  fs.rmSync(spec.pidFile, { force: true });
  if (!pid) return;
  const image = await processPath(pid);
  if (image && image.toLowerCase() === spec.binary.toLowerCase()) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}

function processPath(pid: number): Promise<string | null> {
  if (process.platform !== "win32") {
    return fs.promises.readlink(`/proc/${pid}/exe`).catch(() => null);
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`,
      ],
      { windowsHide: true, timeout: 15_000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}
