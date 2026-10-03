/**
 * Manage the local agent daemon from the command line.
 *
 *   cubehold agent status   show whether the daemon runs and which servers it hosts
 *                       (--json for scripts: {"pid","build","running":[...],"sleeping":[...]})
 *   cubehold agent stop     stop every server gracefully, then stop the daemon
 *
 * From source: `pnpm agent:status` / `pnpm agent:stop`.
 */
import fs from "node:fs";
import path from "node:path";
import { type AgentStateFile, RemoteAgent } from "@cubehold/agent";

export async function agentCtl(
  cmd: "status" | "stop",
  dataDir: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const stateFile = path.join(dataDir, "agent.json");
  let state: AgentStateFile | null = null;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as AgentStateFile;
  } catch {
    state = null;
  }
  if (!state) {
    console.log(
      opts.json
        ? JSON.stringify({ pid: null, running: [], sleeping: [] })
        : "Agent is not running.",
    );
    return;
  }

  const agent = new RemoteAgent(`ws://127.0.0.1:${state.port}`, state.token);
  try {
    const hello = await agent.connect(2_000);
    if (cmd === "stop") {
      if (hello.running.length > 0) {
        console.log(`Stopping ${hello.running.length} server(s) gracefully…`);
      }
      await agent.shutdownDaemon({ stopServers: true });
      console.log(`Agent pid ${hello.pid} is shutting down.`);
    } else if (opts.json) {
      const { pid, build, running, sleeping } = hello;
      console.log(JSON.stringify({ pid, build, running, sleeping: sleeping ?? [] }));
    } else {
      console.log(`Agent pid ${hello.pid}, build ${hello.build}, up since ${hello.startedAt}`);
      console.log(`Running servers: ${hello.running.length ? hello.running.join(", ") : "none"}`);
      if (hello.sleeping?.length) {
        console.log(`Sleeping (wake on join): ${hello.sleeping.join(", ")}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      opts.json ? JSON.stringify({ error: message }) : `Agent is not reachable (${message}).`,
    );
    process.exitCode = 1;
  } finally {
    agent.close();
  }
}
