import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pingJava } from "@cubehold/tunnels";
import { afterAll, describe, expect, it } from "vitest";
import { LocalAgent } from "./local-agent.js";
import { parseFunnelStatus, parseTailscaleStatus } from "./tailscale.js";
import { TunnelProcess } from "./tunnel-process.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-m3-"));
// Windows holds files of just-stopped child processes for a moment.
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
});

/** Stands in for playitd: behaves according to the secret it is given. */
const fakePlayit = path.join(tmp, "fake-playitd.mjs");
fs.writeFileSync(
  fakePlayit,
  `const secret = process.argv[process.argv.indexOf("--secret") + 1];
if (secret === "bad") {
  console.error("\\u001b[33mWARN\\u001b[0m configured agent secret is no longer valid");
  process.exit(1);
}
if (secret === "crash") setTimeout(() => process.exit(3), 100);
setTimeout(() => console.log("INFO playit connected; tunnels loaded agent_id=abc tunnel_count=1"), 150);
setInterval(() => {}, 1000);
`,
);

const spec = (secret: string) => ({
  binary: process.execPath,
  args: [fakePlayit, "--secret", secret, "--socket-path", path.join(tmp, "sock")],
  pidFile: path.join(tmp, `playitd-${secret}.pid`),
  redact: [secret],
});

/** Stands in for ngrok: JSON logs, and the agent API with its endpoints. */
const fakeNgrok = path.join(tmp, "fake-ngrok.mjs");
fs.writeFileSync(
  fakeNgrok,
  `import http from "node:http";
const token = process.env.NGROK_AUTHTOKEN;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
if (token === "nocard") {
  log({ lvl: "eror", msg: "failed to start tunnel", err: "TCP tunnels are only available after you sign up.\\nYour authtoken: " + token + "\\n\\nERR_NGROK_8013\\n" });
  process.exit(1);
}
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/endpoints") res.end(JSON.stringify({ endpoints: [{ name: "cubehold-a", url: "tcp://0.tcp.eu.ngrok.io:12345", upstream: { url: "127.0.0.1:25565" } }] }));
  else { res.statusCode = 404; res.end("{}"); }
}).listen(port, "127.0.0.1", () => log({ lvl: "info", msg: "client session established" }));
`,
);

/** Stands in for cloudflared: its metrics server with /ready and /config. */
const fakeCloudflared = path.join(tmp, "fake-cloudflared.mjs");
fs.writeFileSync(
  fakeCloudflared,
  `import http from "node:http";
const port = Number(process.argv[2]);
let ready = false;
setTimeout(() => { ready = true; console.error("2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0"); }, 300);
http.createServer((req, res) => {
  if (req.url === "/ready") { res.statusCode = ready ? 200 : 503; res.end("{}"); return; }
  if (req.url === "/config") { res.end(JSON.stringify({ version: 3, config: { ingress: [{ hostname: "mc.example.com", service: "tcp://localhost:25565" }, { service: "http_status:404" }] } })); return; }
  res.statusCode = 404; res.end();
}).listen(port, "127.0.0.1");
`,
);

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("playit daemon supervision", () => {
  it("runs playitd, notices when it connects, and stops it", async () => {
    const t = new TunnelProcess("playit");
    const s = spec("good");
    await t.set(s);
    await until(() => t.status().state === "connected");
    const st = t.status();
    expect(st.pid).toBeGreaterThan(0);
    expect(st.connectedAt).not.toBeNull();
    expect(st.lines.some((l) => l.includes("playit connected"))).toBe(true);
    expect(fs.existsSync(s.pidFile)).toBe(true);
    // Same secret and binary: nothing restarts.
    const pid = st.pid;
    await t.set(s);
    expect(t.status().pid).toBe(pid);
    await t.stop();
    expect(t.status().state).toBe("stopped");
    expect(t.running).toBe(false);
  });

  it("gives up on a rejected secret instead of restarting forever", async () => {
    const t = new TunnelProcess("playit");
    await t.set(spec("bad"));
    await until(() => t.status().pid === null && t.status().state === "error");
    await new Promise((r) => setTimeout(r, 300));
    const st = t.status();
    expect(st.error).toMatch(/no longer accepts this agent/);
    expect(st.restarts).toBe(0);
    // Colour codes are stripped from the log.
    expect(st.lines.join("\n")).not.toContain("\u001b[");
    await t.stop();
  });

  it("restarts a daemon that exits on its own", async () => {
    const t = new TunnelProcess("playit");
    await t.set(spec("crash"));
    await until(() => t.status().restarts === 1);
    expect(t.status().error).toMatch(/restarting in 5 s/);
    await t.stop();
  });
});

describe("ngrok and cloudflared supervision", () => {
  it("reads ngrok's public TCP address from its agent API", async () => {
    const port = await freePort();
    const t = new TunnelProcess("ngrok");
    await t.set({
      binary: process.execPath,
      args: [fakeNgrok, String(port)],
      env: { NGROK_AUTHTOKEN: "good-token" },
      statusAddr: `127.0.0.1:${port}`,
      redact: ["good-token"],
    });
    await until(() => t.status().endpoints.length > 0, 8_000);
    expect(t.status()).toMatchObject({
      state: "connected",
      endpoints: [
        { name: "cubehold-a", url: "tcp://0.tcp.eu.ngrok.io:12345", target: "127.0.0.1:25565" },
      ],
    });
    await t.stop();
  });

  it("explains ngrok's card requirement, stops retrying and hides the token", async () => {
    const t = new TunnelProcess("ngrok");
    await t.set({
      binary: process.execPath,
      args: [fakeNgrok, "0"],
      env: { NGROK_AUTHTOKEN: "nocard" },
      redact: ["nocard"],
    });
    await until(() => t.status().pid === null && t.status().state === "error");
    await new Promise((r) => setTimeout(r, 300));
    const st = t.status();
    expect(st.error).toMatch(/needs a card/);
    expect(st.restarts).toBe(0);
    expect(st.lines.join("\n")).not.toContain("nocard");
    expect(st.lines.join("\n")).toContain("[hidden]");
    await t.stop();
  });

  it("reads cloudflared's readiness and hostnames from its metrics server", async () => {
    const port = await freePort();
    const t = new TunnelProcess("cloudflared");
    await t.set({
      binary: process.execPath,
      args: [fakeCloudflared, String(port)],
      statusAddr: `127.0.0.1:${port}`,
    });
    await until(() => t.status().state === "connected" && t.status().endpoints.length > 0, 10_000);
    expect(t.status().endpoints).toEqual([
      { name: "mc.example.com", url: "mc.example.com", target: "tcp://localhost:25565" },
    ]);
    await t.stop();
  });
});

describe("Tailscale status", () => {
  it("reads the machine's state, name and Funnel forwards", () => {
    expect(
      parseTailscaleStatus({
        BackendState: "Running",
        AuthURL: "",
        Self: { DNSName: "pc.tail1234.ts.net.", TailscaleIPs: ["100.101.1.2", "fd7a::1"] },
        CurrentTailnet: { Name: "me@example.com" },
      }),
    ).toEqual({
      state: "Running",
      authUrl: null,
      ips: ["100.101.1.2", "fd7a::1"],
      dnsName: "pc.tail1234.ts.net",
      tailnet: "me@example.com",
    });
    expect(
      parseFunnelStatus({
        TCP: {
          "10000": { TCPForward: "localhost:25565" },
          "443": { TCPForward: "localhost:25570" },
        },
        AllowFunnel: { "pc.tail1234.ts.net:10000": true },
      }),
    ).toEqual([
      { port: 443, target: "localhost:25570", public: false },
      { port: 10000, target: "localhost:25565", public: true },
    ]);
  });
});

describe("reachability probe", () => {
  it("answers pings with the test code on a free port, then frees it", async () => {
    const agent = new LocalAgent();
    try {
      const port = await freePort();
      const r = await agent.probe({ port, text: "cubehold connection test abc123", ttlMs: 10_000 });
      expect(r).toEqual({ listening: true, reason: null });
      const status = await pingJava(`127.0.0.1:${port}`);
      expect(status.motd).toBe("cubehold connection test abc123");
      expect(status.version).toBe("Connection test");
      expect(await agent.busyPorts([port])).toEqual([port]);

      const closed = await agent.probe({ port, text: "", ttlMs: 0 });
      expect(closed.listening).toBe(false);
      expect(await agent.busyPorts([port])).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  it("does not take a port another program uses", async () => {
    const agent = new LocalAgent();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "0.0.0.0", r));
    try {
      const { port } = blocker.address() as net.AddressInfo;
      expect(await agent.probe({ port, text: "x", ttlMs: 5_000 })).toEqual({
        listening: false,
        reason: "busy",
      });
    } finally {
      blocker.close();
      await agent.shutdown();
    }
  });
});
