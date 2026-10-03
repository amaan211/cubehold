/**
 * The `cubehold` command (server.mjs in a release build).
 *
 *   cubehold                 run the panel
 *   cubehold agent           run the agent in the foreground under a service manager
 *                        (the Docker image's agent container, a systemd unit)
 *   cubehold agent status    show the local agent's state (--json for scripts)
 *   cubehold agent stop      stop every server gracefully, then the agent
 *   cubehold --version
 *
 * Every command uses DATA_DIR (or the per-user default), so the panel, the
 * agent and these tools agree on where agent.json lives.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { distFile, VERSION } from "./dist.js";

const [cmd, sub] = process.argv.slice(2);

if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h") {
  usage();
} else if (cmd === "agent" && (sub === "status" || sub === "stop")) {
  const { config } = await import("./config.js");
  const { agentCtl } = await import("./agent-ctl.js");
  await agentCtl(sub, config.DATA_DIR, { json: process.argv.includes("--json") });
} else if (cmd === "agent" && sub === undefined) {
  await runAgentService();
} else if (cmd === undefined || cmd === "panel") {
  await import("./index.js");
} else {
  usage();
  process.exitCode = 1;
}

/**
 * The daemon in service mode: no idle exit, output to stdout for the service
 * manager's log, a token of its own choosing written to DATA_DIR/agent.json,
 * where a panel started with CUBEHOLD_AGENT=external picks it up.
 */
async function runAgentService(): Promise<void> {
  const { config } = await import("./config.js");
  const { computeBuildId } = await import("./hosts/local-daemon.js");
  process.env.CUBEHOLD_AGENT_SERVICE = "1";
  process.env.CUBEHOLD_AGENT_DATA ??= config.DATA_DIR;
  process.env.CUBEHOLD_AGENT_STATE ??= path.join(config.DATA_DIR, "agent.json");
  process.env.CUBEHOLD_AGENT_BUILD ??= computeBuildId();
  const shipped = distFile("agent.mjs");
  // A variable specifier, so a release bundle does not swallow the agent.
  const entry = shipped ? pathToFileURL(shipped).href : "@cubehold/agent/daemon";
  await import(entry);
}

function usage(): void {
  console.log(`cubehold ${VERSION}

Usage:
  cubehold                 run the panel (http://127.0.0.1:4000 unless HOST/PORT say otherwise)
  cubehold agent           run the agent in the foreground (for Docker or systemd)
  cubehold agent status    show the local agent and its servers
  cubehold agent stop      stop every server gracefully, then the agent
  cubehold --version

Environment: DATA_DIR, HOST, PORT, SECURE_COOKIES=true (behind HTTPS), CUBEHOLD_AGENT=external.`);
}
