import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentLaunchSpec,
  type AgentStateFile,
  RemoteAgent,
  type RpcHello,
} from "@cubehold/agent";
import { distFile } from "../dist.js";
import { agentBuildId } from "./bundle.js";

export interface DaemonLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface LocalDaemonOptions {
  dataDir: string;
  log: DaemonLogger;
}

/**
 * Connect to the local agent daemon, starting it if needed.
 *
 * The daemon must outlive the panel, including hard kills of the panel's
 * whole process tree (dev tooling, `taskkill /T`, a closed terminal). On
 * Windows that also means escaping any job object the panel runs in, since
 * tools like Turbo kill every job member on exit; there the daemon is created
 * through WMI so its parent is the WMI service. Elsewhere a detached
 * double-spawn puts it in its own session.
 */
export async function connectLocalAgent(opts: LocalDaemonOptions): Promise<RemoteAgent> {
  const stateFile = path.join(opts.dataDir, "agent.json");
  const logFile = path.join(opts.dataDir, "agent.log");
  const build = computeBuildId();

  const existing = await tryExisting(stateFile);
  if (existing) {
    const hello = existing.hello;
    if (hello && !isStale(hello, build)) {
      opts.log.info(`connected to running agent (pid ${hello.pid})`);
      return existing;
    }
    const running = await existing.running().catch(() => ["?"]);
    if (running.length > 0) {
      opts.log.warn(
        `agent pid ${hello?.pid} runs older code but ${running.length} server(s) are running; keeping it until they stop.`,
      );
      return existing;
    }
    opts.log.info(
      `agent pid ${hello?.pid} is outdated or runs from an older install; replacing it`,
    );
    await existing.shutdownDaemon().catch(() => {});
    existing.close();
    await waitFor(() => !fs.existsSync(stateFile), 10_000);
  }

  const launchFile = path.join(opts.dataDir, `agent.launch-${randomBytes(6).toString("hex")}.json`);
  const spec: AgentLaunchSpec = {
    token: randomBytes(32).toString("hex"),
    port: 0,
    stateFile,
    build,
    logFile,
    dataDir: path.resolve(opts.dataDir),
  };
  fs.writeFileSync(launchFile, JSON.stringify(spec), { mode: 0o600 });

  const { command, args } = daemonCommand();
  const fullArgs = [...args, "--launch", launchFile];
  let pid: number;
  try {
    pid =
      process.platform === "win32"
        ? await launchViaWmi(command, fullArgs, opts.dataDir)
        : await launchDoubleFork(command, fullArgs);
  } catch (err) {
    fs.rmSync(launchFile, { force: true });
    throw err;
  }
  opts.log.info(`started agent daemon pid ${pid}; log: ${logFile}`);

  const ok = await waitFor(() => readState(stateFile)?.pid === pid, 20_000);
  if (!ok) {
    fs.rmSync(launchFile, { force: true });
    throw new Error(`agent daemon did not start; see ${logFile}`);
  }
  const agent = await tryExisting(stateFile);
  if (!agent) throw new Error(`could not connect to the agent daemon; see ${logFile}`);
  return agent;
}

/**
 * Connect to an agent that a service manager runs (the Docker image's agent
 * container). The panel never starts or replaces it. Its port and token come
 * from the state file it writes to the shared data folder, read again before
 * every attempt: a restarted agent listens on a new port with a new token.
 */
export async function connectExternalAgent(
  opts: LocalDaemonOptions & { host: string; timeoutMs?: number },
): Promise<RemoteAgent> {
  const stateFile = path.join(opts.dataDir, "agent.json");
  let state = readState(stateFile);
  const agent = new RemoteAgent(
    () => {
      state = readState(stateFile) ?? state;
      return `ws://${opts.host}:${state?.port ?? 0}`;
    },
    () => state?.token ?? "",
    { unavailable: () => "The agent is not running. Check the agent container's log." },
  );
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let lastLog = 0;
  for (;;) {
    try {
      const hello = await agent.connect(2_000);
      opts.log.info(`connected to agent pid ${hello.pid} (build ${hello.build})`);
      return agent;
    } catch (err) {
      if (Date.now() > deadline) {
        agent.close();
        throw new Error(
          `The agent did not answer (${err instanceof Error ? err.message : err}). It must run with the same data folder (${opts.dataDir}).`,
        );
      }
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        opts.log.info(
          `waiting for the agent (${state ? `port ${state.port}` : "no agent.json yet"})`,
        );
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/**
 * An agent needs replacing when its code differs, or when it runs from
 * another install's folder (Windows keeps each version in its own folder,
 * which an old agent would otherwise hold on to).
 */
export function isStale(hello: RpcHello, build: string): boolean {
  if (hello.build !== build) return true;
  return (
    hello.execPath !== undefined && path.resolve(hello.execPath) !== path.resolve(process.execPath)
  );
}

async function tryExisting(stateFile: string): Promise<RemoteAgent | null> {
  const state = readState(stateFile);
  if (!state) return null;
  const agent = new RemoteAgent(`ws://127.0.0.1:${state.port}`, state.token);
  try {
    await agent.connect(2_000);
    return agent;
  } catch {
    agent.close();
    // Stale file from a daemon that died; remove it so we start fresh.
    fs.rmSync(stateFile, { force: true });
    return null;
  }
}

function readState(file: string): AgentStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as AgentStateFile;
  } catch {
    return null;
  }
}

/**
 * Windows: ask WMI to create the process. It becomes a child of WmiPrvSE.exe,
 * outside the panel's process tree and outside any job object, runs hidden,
 * as the same user, in the same session. No admin rights needed.
 */
async function launchViaWmi(command: string, args: string[], cwd: string): Promise<number> {
  const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CUBEHOLD_CMDLINE; CurrentDirectory = $env:CUBEHOLD_CWD; ProcessStartupInformation = $startup }",
    'Write-Output "$($r.ReturnValue) $($r.ProcessId)"',
  ].join("; ");
  const { code, stdout, stderr } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { CUBEHOLD_CMDLINE: commandLine, CUBEHOLD_CWD: cwd },
  );
  const [ret, pid] = stdout.trim().split(/\s+/).map(Number);
  if (code !== 0 || ret !== 0 || !pid) {
    throw new Error(
      `WMI could not start the agent (exit ${code}, return ${ret}): ${stderr.trim()}`,
    );
  }
  return pid;
}

/**
 * Unix: a throwaway process starts the daemon detached (new session) and
 * exits, so the daemon has no living parent in the panel's tree.
 */
async function launchDoubleFork(command: string, args: string[]): Promise<number> {
  const launcher = `
const { spawn } = require("node:child_process");
const [command, ...args] = JSON.parse(process.env.CUBEHOLD_LAUNCH_ARGV);
const child = spawn(command, args, { detached: true, stdio: "ignore" });
child.unref();
process.stdout.write(String(child.pid));
`;
  const { code, stdout } = await run(process.execPath, ["-e", launcher], {
    CUBEHOLD_LAUNCH_ARGV: JSON.stringify([command, ...args]),
  });
  const pid = Number.parseInt(stdout.trim(), 10);
  if (code !== 0 || !Number.isFinite(pid)) throw new Error(`agent launcher failed (exit ${code})`);
  return pid;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** How to launch the daemon: the shipped bundle in a release, TypeScript through tsx from source. */
function daemonCommand(): { command: string; args: string[] } {
  const shipped = distFile("agent.mjs");
  if (shipped) return { command: process.execPath, args: [shipped] };
  const entry = fileURLToPath(import.meta.resolve("@cubehold/agent/daemon"));
  if (entry.endsWith(".ts")) {
    return { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), entry] };
  }
  return { command: process.execPath, args: [entry] };
}

/**
 * Identify the agent's code so a stale daemon gets replaced after edits or
 * an update. A release uses the hash of agent.mjs, the same build id remote
 * hosts get; from source it hashes the sources the daemon runs.
 */
export function computeBuildId(): string {
  const shipped = distFile("agent.mjs");
  if (shipped) return agentBuildId(fs.readFileSync(shipped));
  const roots = ["@cubehold/agent", "@cubehold/mc", "@cubehold/shared"].map((spec) =>
    path.dirname(fileURLToPath(import.meta.resolve(spec))),
  );
  const hash = createHash("sha256");
  for (const root of roots) {
    for (const file of listFiles(root)) {
      if (file.endsWith(".test.ts")) continue;
      hash.update(path.relative(root, file));
      hash.update(fs.readFileSync(file));
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}
