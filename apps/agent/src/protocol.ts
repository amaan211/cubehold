import type { AgentApi, AgentEvent } from "./types.js";

/** Methods callable over the wire. Everything else on AgentApi is local-only. */
export const RPC_METHODS = [
  "hostInfo",
  "start",
  "stop",
  "kill",
  "send",
  "command",
  "status",
  "players",
  "running",
  "setPolicy",
  "sleep",
  "snapshot",
  "busyPorts",
  "readFile",
  "readBinary",
  "readFiles",
  "writeFile",
  "listDir",
  "stat",
  "copyInto",
  "removePaths",
  "removeDir",
  "makeDir",
  "rename",
  "zip",
  "unzip",
  "zipEntries",
  "inspectJars",
  "stageBinaries",
  "commitBinaries",
  "discardStaging",
  "writeInitialFiles",
  "ensureJava",
  "gcJava",
  "fetchUrl",
  "networkInfo",
  "setPortMappings",
  "portMappings",
  "setTunnel",
  "tunnelStatus",
  "probe",
  "firewall",
  "fixFirewall",
  "tailscaleStatus",
  "tailscaleLogin",
  "tailscaleFunnel",
  "tailscaleInstall",
] as const satisfies ReadonlyArray<keyof AgentApi>;

export type RpcMethod = (typeof RPC_METHODS)[number];

/** Daemon-level control calls that are not part of AgentApi. */
export type ControlMethod = "agent.shutdown";

export interface RpcRequest {
  type: "req";
  id: number;
  method: RpcMethod | ControlMethod;
  params: unknown[];
}

export type RpcResponse =
  | { type: "res"; id: number; ok: true; result: unknown }
  | { type: "res"; id: number; ok: false; error: string };

export interface RpcEventMessage {
  type: "event";
  event: AgentEvent;
}

/** First message the daemon sends on every connection. */
export interface RpcHello {
  type: "hello";
  build: string;
  pid: number;
  startedAt: string;
  running: string[];
  /** Servers waiting for a player to join (wake-on-join). */
  sleeping?: string[];
  /** Node.js version the daemon runs on. */
  node?: string;
  /** True when a service manager (systemd) runs the daemon: it never exits on its own. */
  service?: boolean;
  /** The Node.js binary it runs on: an installed app replaces an agent left in an older version's folder. */
  execPath?: string;
}

/**
 * HTTP endpoints on the daemon's port, for streams that do not belong in
 * JSON-RPC. Same bearer token as the WebSocket.
 *   GET /files?root=&path=        download a file
 *   PUT /files?root=&path=&overwrite=1   upload a file (request body)
 *   GET /zip?root=&paths=<json>   download paths as a zip, streamed
 */
export const AGENT_HTTP = { files: "/files", zip: "/zip" } as const;

export type DaemonMessage = RpcResponse | RpcEventMessage | RpcHello;

/** One-shot file the panel writes and the daemon reads (then deletes) at startup. */
export interface AgentLaunchSpec {
  token: string;
  port: number;
  stateFile: string;
  build: string;
  logFile: string;
  /** Where servers, backups and Java live on this host. */
  dataDir?: string;
  /** Address to listen on; 127.0.0.1 unless the panel reaches the agent over a container network. */
  listen?: string;
}

/** Written by the daemon once it is listening; read by the panel to connect. */
export interface AgentStateFile {
  port: number;
  pid: number;
  token: string;
  build: string;
  startedAt: string;
}
