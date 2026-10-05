import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { createZip, extractZip, inspectJar, zipTopLevel } from "./archive.js";
import { LocalAgent } from "./local-agent.js";
import { RconClient } from "./rcon.js";
import { Sleeper } from "./sleeper.js";
import type { AgentEvent, LaunchRequest } from "./types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-m2-test-"));
// Windows holds files of just-stopped child processes for a moment.
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// --- RCON ----------------------------------------------------------------------------

function rconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

/**
 * Behaves like Minecraft's RconClient: auth reply type 2, 4096-char chunks,
 * and it hangs up when one read holds anything but exactly one packet (so a
 * client that pipelines commands fails here as it does against a real server).
 */
function fakeRconServer(password: string, reply: (cmd: string) => string): net.Server {
  return net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (chunk) => {
      if (chunk.length < 4 || chunk.readInt32LE(0) !== chunk.length - 4) {
        socket.destroy();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + len - 2).toString("utf8");
        buf = buf.subarray(4 + len);
        if (type === 3) {
          authed = body === password;
          socket.write(rconPacket(authed ? id : -1, 2, ""));
        } else if (type === 2 && authed) {
          const text = reply(body);
          let offset = 0;
          do {
            socket.write(rconPacket(id, 0, text.slice(offset, offset + 4096)));
            offset += 4096;
          } while (offset < text.length);
        } else {
          socket.write(rconPacket(id, 0, `Unknown request ${type.toString(16)}`));
        }
      }
    });
  });
}

describe("RconClient", () => {
  it("logs in, runs commands one at a time and joins multi-packet replies", async () => {
    const long = `${"x".repeat(4096 * 2)}tail`;
    const exact = "y".repeat(4096); // a full chunk: ended by the short wait
    const server = fakeRconServer("secret", (cmd) =>
      cmd === "long"
        ? long
        : cmd === "exact"
          ? exact
          : cmd === "list"
            ? "There are 0 of a max of 20 players online: "
            : `ran ${cmd}`,
    );
    const port = await freePort();
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const client = new RconClient("127.0.0.1", port, "secret");
      await client.connect();
      expect(client.connected).toBe(true);
      expect(await client.command("list")).toBe("There are 0 of a max of 20 players online: ");
      expect(await client.command("long")).toBe(long);
      expect(await client.command("exact")).toBe(exact);
      // Fired together, still sent one by one.
      const many = await Promise.all(["a", "b", "c", "d"].map((c) => client.command(c)));
      expect(many).toEqual(["ran a", "ran b", "ran c", "ran d"]);
      expect(client.connected).toBe(true);
      await expect(client.command("x".repeat(2000))).rejects.toThrow(/too long/);
      client.close();

      const bad = new RconClient("127.0.0.1", port, "wrong");
      await expect(bad.connect()).rejects.toThrow(/password/);
    } finally {
      server.close();
    }
  });
});

// --- Sleeper -------------------------------------------------------------------------

function varInt(v: number): Buffer {
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const str = (s: string) => Buffer.concat([varInt(Buffer.byteLength(s)), Buffer.from(s)]);
const packet = (id: number, ...parts: Buffer[]) => {
  const body = Buffer.concat([varInt(id), ...parts]);
  return Buffer.concat([varInt(body.length), body]);
};
const handshake = (port: number, next: number) =>
  packet(0x00, varInt(772), str("localhost"), Buffer.from([port >> 8, port & 0xff]), varInt(next));

async function exchange(port: number, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = net.connect(port, "127.0.0.1", () => s.write(data));
    s.on("data", (c) => chunks.push(c));
    s.on("end", () => resolve(Buffer.concat(chunks)));
    s.on("error", reject);
  });
}

describe("Sleeper", () => {
  it("answers pings and wakes on a login attempt", async () => {
    const port = await freePort();
    let woke: string | null | undefined;
    const sleeper = new Sleeper({
      port,
      host: "127.0.0.1",
      motd: "My World",
      maxPlayers: 10,
      onWake: (p) => {
        woke = p;
      },
    });
    await sleeper.listen();

    const ping = Buffer.alloc(8);
    ping.writeBigInt64BE(42n);
    const status = await exchange(
      port,
      Buffer.concat([handshake(port, 1), packet(0x00), packet(0x01, ping)]),
    );
    const text = status.toString("utf8");
    expect(text).toContain('"protocol":772');
    expect(text).toContain("My World");
    expect(text).toContain("Sleeping");
    expect(status.subarray(-8).readBigInt64BE()).toBe(42n); // pong echoes the payload
    expect(woke).toBeUndefined();

    const uuid = Buffer.alloc(16);
    const kick = await exchange(
      port,
      Buffer.concat([handshake(port, 2), packet(0x00, str("Steve"), uuid)]),
    );
    expect(kick.toString("utf8")).toContain("starting up");
    await waitFor(() => woke !== undefined);
    expect(woke).toBe("Steve");
    // The port is released so the real server can bind it.
    await expect(exchange(port, handshake(port, 1))).rejects.toThrow();
  });
});

// --- Archives ------------------------------------------------------------------------

describe("zip archives", () => {
  it("round-trips a folder, skipping session.lock and keeping empty dirs", async () => {
    const src = path.join(tmp, "zsrc");
    fs.mkdirSync(path.join(src, "world", "region"), { recursive: true });
    fs.mkdirSync(path.join(src, "world", "empty"), { recursive: true });
    fs.writeFileSync(path.join(src, "world", "level.dat"), "level");
    fs.writeFileSync(path.join(src, "world", "session.lock"), "lock");
    fs.writeFileSync(path.join(src, "world", "region", "r.0.0.mca"), Buffer.alloc(100_000, 7));
    fs.writeFileSync(path.join(src, "server.properties"), "motd=hi\n");

    const zipFile = path.join(tmp, "out", "backup.zip");
    const progress: number[] = [];
    const r = await createZip(src, ["world", "server.properties"], zipFile, {
      skipNames: ["session.lock"],
      onProgress: (done) => progress.push(done),
    });
    expect(r.files).toBe(3);
    expect(r.sizeBytes).toBe(5 + 100_000 + 8);
    expect(r.zipBytes).toBeGreaterThan(100_000); // .mca is stored, not deflated
    expect(progress.at(-1)).toBe(r.sizeBytes);
    expect(fs.existsSync(`${zipFile}.part`)).toBe(false);
    expect((await zipTopLevel(zipFile)).sort()).toEqual(["server.properties", "world"]);

    const dest = path.join(tmp, "zdest");
    const x = await extractZip(zipFile, dest);
    expect(x.files).toBe(3);
    expect(fs.readFileSync(path.join(dest, "world", "level.dat"), "utf8")).toBe("level");
    expect(fs.statSync(path.join(dest, "world", "region", "r.0.0.mca")).size).toBe(100_000);
    expect(fs.existsSync(path.join(dest, "world", "session.lock"))).toBe(false);
    expect(fs.statSync(path.join(dest, "world", "empty")).isDirectory()).toBe(true);

    await expect(extractZip(zipFile, dest)).rejects.toThrow(/already exists/);
    await expect(extractZip(zipFile, dest, { overwrite: true })).resolves.toMatchObject({
      files: 3,
    });
  });

  it("reads plugin and mod metadata from jars", async () => {
    const make = async (name: string, entry: string, text: string) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(text), entry);
      zip.end();
      const file = path.join(tmp, name);
      await new Promise<void>((resolve) =>
        zip.outputStream.pipe(fs.createWriteStream(file)).on("close", () => resolve()),
      );
      return file;
    };
    const plugin = await make(
      "p.jar",
      "plugin.yml",
      "name: LuckPerms\nversion: '5.5.71'\nmain: me.lucko.Main\ndescription: \"Permissions\"\n",
    );
    expect(await inspectJar(plugin)).toEqual({
      kind: "plugin",
      id: "LuckPerms",
      name: "LuckPerms",
      version: "5.5.71",
      description: "Permissions",
    });
    const mod = await make(
      "m.jar",
      "fabric.mod.json",
      JSON.stringify({ id: "lithium", name: "Lithium", version: "0.15.0" }),
    );
    expect(await inspectJar(mod)).toMatchObject({ kind: "mod", id: "lithium", name: "Lithium" });
    fs.writeFileSync(path.join(tmp, "junk.jar"), "not a zip");
    expect((await inspectJar(path.join(tmp, "junk.jar"))).kind).toBeNull();
  });
});

// --- Crash restart, idle stop and wake -------------------------------------------------

const FAKE_SERVER = `
const fs = require("node:fs");
const path = require("node:path");
const counter = path.join(process.cwd(), "runs.txt");
const run = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(run));
const crashOn = Number(process.argv[2] || 0);
console.log("[12:00:00 INFO]: Starting minecraft server (run " + run + ")");
setTimeout(() => {
  console.log('[12:00:00 INFO]: Done (0.050s)! For help, type "help"');
  if (run <= crashOn) setTimeout(() => process.exit(1), 50);
}, 50);
process.stdin.on("data", (d) => {
  if (String(d).includes("stop")) {
    console.log("[12:00:01 INFO]: Stopping server");
    process.exit(0);
  }
});
setInterval(() => {}, 1000);
`;

function fakeServer(name: string, crashRuns: number, props = ""): LaunchRequest {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fake.cjs"), FAKE_SERVER);
  if (props) fs.writeFileSync(path.join(dir, "server.properties"), props);
  return {
    serverId: name,
    directory: dir,
    javaPath: process.execPath,
    args: ["fake.cjs", String(crashRuns)],
    software: "paper",
    memoryMb: 512,
  };
}

describe("LocalAgent automation", () => {
  it("restarts after a crash, within the restart budget", async () => {
    const agent = new LocalAgent({ restartDelaysMs: [50] });
    const events: AgentEvent[] = [];
    agent.onEvent((e) => events.push(e));
    try {
      const req = fakeServer("crashy", 1);
      await agent.start({
        ...req,
        policy: { autoRestart: true, idleStopMinutes: 0, wakeOnJoin: false },
      });
      await waitFor(() => events.some((e) => e.type === "exit"));
      const exit = events.find((e) => e.type === "exit");
      expect(exit).toMatchObject({ expected: false, code: 1, restartInMs: 50 });
      await waitFor(() => fs.readFileSync(path.join(req.directory, "runs.txt"), "utf8") === "2");
      await waitFor(
        () => events.filter((e) => e.type === "status" && e.status === "running").length === 2,
      );
      expect(await agent.status("crashy")).toBe("running");
    } finally {
      await agent.shutdown();
    }
  });

  it("gives up once the restart budget is spent", async () => {
    const agent = new LocalAgent({ restartDelaysMs: [30] });
    const lines: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "line" && e.stream === "system") lines.push(e.line);
    });
    try {
      const req = fakeServer("doomed", 99);
      await agent.start({
        ...req,
        policy: { autoRestart: true, idleStopMinutes: 0, wakeOnJoin: false },
      });
      await waitFor(() => lines.some((l) => /not restarting automatically/.test(l)));
      expect(await agent.status("doomed")).toBe("crashed");
      expect(agent.busy()).toBe(false);
    } finally {
      await agent.shutdown();
    }
  });

  it("stops an empty server, sleeps on its port, and wakes when a player joins", async () => {
    const port = await freePort();
    const agent = new LocalAgent({ idleCheckMs: 30 });
    const statuses: string[] = [];
    let idleExit: AgentEvent | undefined;
    agent.onEvent((e) => {
      if (e.type === "status") statuses.push(e.status);
      if (e.type === "exit" && e.stoppedBy === "idle") idleExit = e;
    });
    try {
      const req = fakeServer(
        "sleepy",
        0,
        `server-port=${port}\nserver-ip=127.0.0.1\nmotd=Sleepy\n`,
      );
      // 0.002 minutes = 120 ms without players.
      await agent.start({
        ...req,
        policy: { autoRestart: false, idleStopMinutes: 0.002, wakeOnJoin: true },
      });
      await waitFor(() => statuses.includes("sleeping"));
      expect(idleExit).toMatchObject({ expected: true, stoppedBy: "idle" });
      expect(await agent.status("sleepy")).toBe("sleeping");
      expect(agent.sleeping()).toEqual(["sleepy"]);
      expect(agent.busy()).toBe(true);
      expect(await agent.busyPorts([port])).toEqual([port]);

      await agent.setPolicy("sleepy", { autoRestart: false, idleStopMinutes: 0, wakeOnJoin: true });
      await exchange(
        port,
        Buffer.concat([handshake(port, 2), packet(0x00, str("Alex"), Buffer.alloc(16))]),
      );
      await waitFor(() => statuses.filter((s) => s === "running").length === 2);
      expect(await agent.status("sleepy")).toBe("running");
    } finally {
      await agent.shutdown();
    }
  });
});
