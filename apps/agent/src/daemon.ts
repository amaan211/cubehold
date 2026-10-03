/**
 * Agent daemon: a long-lived process that owns the Minecraft server processes
 * on this machine. The panel connects to it over a token-authenticated
 * WebSocket on 127.0.0.1, so restarting or crashing the panel never takes
 * running servers down with it.
 *
 * Configuration comes from a one-shot launch file (`--launch <path>`), which
 * the daemon deletes after reading so the token does not linger on disk or in
 * the environment. Env vars CUBEHOLD_AGENT_TOKEN / _PORT / _STATE / _BUILD / _LOG
 * / _DATA / _LISTEN are accepted instead; that is how systemd runs it on
 * remote hosts (CUBEHOLD_AGENT_SERVICE=1), reached by the panel through an SSH
 * port-forward, and how the Docker image runs it next to the panel. Without a
 * token but with a state file, the daemon picks a random token and the panel
 * reads it from that file.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { format } from "node:util";
import { type WebSocket, WebSocketServer } from "ws";
import { streamZip } from "./archive.js";
import { renameWithRetry, safeResolve } from "./files.js";
import { LocalAgent } from "./local-agent.js";
import {
  AGENT_HTTP,
  type AgentLaunchSpec,
  type AgentStateFile,
  type DaemonMessage,
  type RpcRequest,
} from "./protocol.js";
import { dispatchRpc } from "./rpc-handler.js";

function readLaunchSpec(): Partial<AgentLaunchSpec> {
  const i = process.argv.indexOf("--launch");
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  if (file) {
    const spec = JSON.parse(fs.readFileSync(file, "utf8")) as AgentLaunchSpec;
    fs.rmSync(file, { force: true });
    return spec;
  }
  return {
    token: process.env.CUBEHOLD_AGENT_TOKEN,
    port: Number(process.env.CUBEHOLD_AGENT_PORT ?? 0),
    stateFile: process.env.CUBEHOLD_AGENT_STATE,
    build: process.env.CUBEHOLD_AGENT_BUILD,
    logFile: process.env.CUBEHOLD_AGENT_LOG,
    dataDir: process.env.CUBEHOLD_AGENT_DATA,
    listen: process.env.CUBEHOLD_AGENT_LISTEN,
  };
}

/** Run by a service manager: stay up when idle and let it handle restarts. */
const serviceMode = process.env.CUBEHOLD_AGENT_SERVICE === "1";

const spec = readLaunchSpec();

// The daemon has no terminal; send console output to its log file when given one.
if (spec.logFile) {
  const out = fs.createWriteStream(spec.logFile, { flags: "a" });
  const write = (...args: unknown[]) => out.write(`${format(...args)}\n`);
  console.log = write;
  console.info = write;
  console.warn = write;
  console.error = write;
}

// Only whoever can read the state file (the panel, sharing DATA_DIR) learns a picked token.
const token = spec.token ?? (spec.stateFile ? randomBytes(32).toString("hex") : undefined);
if (!token || token.length < 32) {
  console.error("agent token missing or shorter than 32 characters");
  process.exit(2);
}
const port = spec.port ?? 0;
const stateFile = spec.stateFile ?? null;
const build = spec.build ?? "dev";
const startedAt = new Date().toISOString();
const tokenBuf = Buffer.from(token);

const log = (msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} [agent ${process.pid}] ${msg}`, extra ?? "");

const agent = new LocalAgent({ dataDir: spec.dataDir });
const clients = new Set<WebSocket>();

agent.onEvent((event) => {
  const msg = JSON.stringify({ type: "event", event } satisfies DaemonMessage);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
});

function authorized(header: string | undefined): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
}

const httpServer = http.createServer((req, res) => void handleHttp(req, res));

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 16 * 1024 * 1024,
  verifyClient: ({ req }, done) => {
    const ok = authorized(req.headers.authorization);
    done(ok, ok ? undefined : 401, ok ? undefined : "unauthorized");
  },
});

/** File streams that do not fit JSON-RPC: downloads, uploads and zipped folders. */
async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!authorized(req.headers.authorization)) return reply(401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const root = url.searchParams.get("root") ?? "";
  if (!path.isAbsolute(root)) return reply(400, { error: "root must be an absolute path" });
  let tmp: string | null = null;
  try {
    if (url.pathname === AGENT_HTTP.files && req.method === "GET") {
      const file = safeResolve(root, url.searchParams.get("path") ?? "");
      const st = await fs.promises.stat(file);
      if (!st.isFile()) return reply(400, { error: "not a file" });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(st.size),
      });
      await pipeline(fs.createReadStream(file), res);
    } else if (url.pathname === AGENT_HTTP.files && req.method === "PUT") {
      const target = safeResolve(root, url.searchParams.get("path") ?? "");
      if (target === path.resolve(root)) return reply(400, { error: "missing file name" });
      if (url.searchParams.get("overwrite") !== "1" && fs.existsSync(target)) {
        return reply(409, { error: `${path.basename(target)} already exists` });
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      tmp = `${target}.upload-${randomBytes(4).toString("hex")}`;
      await pipeline(req, fs.createWriteStream(tmp));
      await renameWithRetry(tmp, target);
      tmp = null;
      reply(200, { sizeBytes: (await fs.promises.stat(target)).size });
    } else if (url.pathname === AGENT_HTTP.zip && req.method === "GET") {
      const paths = JSON.parse(url.searchParams.get("paths") ?? "[]") as string[];
      if (!Array.isArray(paths) || paths.length === 0) return reply(400, { error: "no paths" });
      for (const p of paths) safeResolve(root, p); // validate before sending headers
      res.writeHead(200, { "content-type": "application/zip" });
      await streamZip(root, paths, res, { skipNames: ["session.lock"] });
    } else {
      reply(404, { error: "not found" });
    }
  } catch (err) {
    if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      const code = (err as NodeJS.ErrnoException).code;
      reply(code === "ENOENT" ? 404 : 400, { error: message });
    } else {
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
}

// Loopback only, unless a container setup without shared networking asks otherwise.
const listenHost = spec.listen ?? "127.0.0.1";
httpServer.listen(port, listenHost);
httpServer.on("listening", () => {
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  log(`listening on ${listenHost}:${actualPort} (build ${build})`);
  if (stateFile) {
    const state: AgentStateFile = { port: actualPort, pid: process.pid, token, build, startedAt };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
});

wss.on("connection", async (ws) => {
  clients.add(ws);
  log(`client connected (${clients.size} total)`);
  const hello: DaemonMessage = {
    type: "hello",
    build,
    pid: process.pid,
    startedAt,
    running: await agent.running(),
    sleeping: agent.sleeping(),
    node: process.version,
    service: serviceMode,
    execPath: process.execPath,
  };
  ws.send(JSON.stringify(hello));

  ws.on("message", async (raw) => {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw.toString()) as RpcRequest;
    } catch {
      return;
    }
    if (req?.type !== "req" || typeof req.id !== "number") return;
    const reply = (msg: DaemonMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    try {
      const result = await dispatch(req);
      reply({ type: "res", id: req.id, ok: true, result: result ?? null });
    } catch (err) {
      reply({
        type: "res",
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    log(`client disconnected (${clients.size} left)`);
  });
  ws.on("error", () => clients.delete(ws));
});

async function dispatch(req: RpcRequest): Promise<unknown> {
  if (req.method === "agent.shutdown") {
    const opts = (req.params[0] ?? {}) as { stopServers?: boolean };
    const running = await agent.running();
    if (running.length > 0 && !opts.stopServers) {
      throw new Error(`${running.length} server(s) still running`);
    }
    setImmediate(() => void shutdown("rpc"));
    return { stopping: running };
  }
  return dispatchRpc(agent, req);
}

let shuttingDown = false;
async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason}); stopping servers gracefully`);
  await agent.shutdown().catch((err) => log("error while stopping servers", err));
  for (const ws of clients) ws.close(1001, "agent shutting down");
  wss.close();
  httpServer.close();
  if (stateFile) {
    try {
      const current = JSON.parse(fs.readFileSync(stateFile, "utf8")) as AgentStateFile;
      if (current.pid === process.pid) fs.rmSync(stateFile, { force: true });
    } catch {
      // already gone
    }
  }
  process.exit(0);
}

// Exit on our own once nothing needs us: no servers running or sleeping, no
// restart pending, and no panel connected for a while. The panel starts a
// fresh daemon the next time it boots.
const IDLE_EXIT_MS = 10 * 60_000;
let idleSince = Date.now();
setInterval(() => {
  const busy = serviceMode || clients.size > 0 || agent.busy();
  if (busy) idleSince = Date.now();
  else if (Date.now() - idleSince > IDLE_EXIT_MS) void shutdown("idle");
}, 30_000).unref();

// Keep the event loop alive: the WebSocket server alone would, but be explicit.
setInterval(() => {}, 1 << 30);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(sig, () => void shutdown(sig));
}
process.on("uncaughtException", (err) => log("uncaught exception", err));
process.on("unhandledRejection", (err) => log("unhandled rejection", err));
