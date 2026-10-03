import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { LocalAgent } from "./local-agent.js";
import type { DaemonMessage, RpcRequest } from "./protocol.js";
import { RemoteAgent } from "./remote.js";
import { dispatchRpc } from "./rpc-handler.js";

/**
 * The panel only talks to agents over JSON, so exercise the real client
 * against the real dispatcher through a socket, not LocalAgent directly.
 */
const TOKEN = "t".repeat(64);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-rpc-test-"));
const local = new LocalAgent();
let wss: WebSocketServer;
let remote: RemoteAgent;

beforeAll(async () => {
  wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }, done) => done(req.headers.authorization === `Bearer ${TOKEN}`, 401),
  });
  wss.on("connection", (ws) => {
    const hello: DaemonMessage = {
      type: "hello",
      build: "test",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      running: [],
    };
    ws.send(JSON.stringify(hello));
    ws.on("message", async (raw) => {
      const req = JSON.parse(raw.toString()) as RpcRequest;
      try {
        const result = await dispatchRpc(local, req);
        ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, result: result ?? null }));
      } catch (err) {
        ws.send(
          JSON.stringify({ type: "res", id: req.id, ok: false, error: (err as Error).message }),
        );
      }
    });
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  remote = new RemoteAgent(`ws://127.0.0.1:${port}`, TOKEN);
  await remote.connect();

  fs.mkdirSync(path.join(tmp, "srv", "world"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "srv", "server.properties"), "motd=hello\nserver-port=25580\n");
  fs.writeFileSync(path.join(tmp, "srv", "world", "level.dat"), "abc");
});

afterAll(async () => {
  remote.close();
  wss.close();
  await local.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("agent RPC round trip", () => {
  it("reads a file when the optional size limit is omitted", async () => {
    const text = await remote.readFile(path.join(tmp, "srv"), "server.properties");
    expect(text).toContain("server-port=25580");
  });

  it("uses defaults for other omitted arguments", async () => {
    const snap = await remote.snapshot("nothing-running");
    expect(snap.source).toBe("none");
    await remote.copyInto(path.join(tmp, "srv"), ["world"], path.join(tmp, "out"));
    await expect(
      remote.copyInto(path.join(tmp, "srv"), ["world"], path.join(tmp, "out")),
    ).rejects.toThrow(/already exists/);
  });

  it("round-trips writes, stats and listings", async () => {
    await remote.writeFile(path.join(tmp, "srv"), "notes/a.txt", "hi");
    const [st] = await remote.stat(path.join(tmp, "srv"), ["notes"]);
    expect(st).toMatchObject({ exists: true, kind: "dir", files: 1, sizeBytes: 2 });
    const names = (await remote.listDir(path.join(tmp, "srv"), "")).map((e) => e.name);
    expect(names).toEqual(["notes", "world", "server.properties"]);
  });

  it("surfaces agent errors as rejections", async () => {
    await expect(remote.readFile(path.join(tmp, "srv"), "../../etc")).rejects.toThrow(/escapes/);
    await expect(remote.removeDir(path.parse(tmp).root)).rejects.toThrow(/Refusing/);
  });
});
