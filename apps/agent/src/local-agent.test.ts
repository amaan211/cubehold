import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalAgent } from "./local-agent.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-agent-test-"));
const agent = new LocalAgent();

afterAll(async () => {
  await agent.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("LocalAgent.snapshot", () => {
  it("reports a never-run server as stopped with no history", async () => {
    const snap = await agent.snapshot("nope", path.join(tmp, "missing"));
    expect(snap).toEqual({ status: "stopped", players: [], lines: [], source: "none" });
  });

  it("falls back to the tail of logs/latest.log", async () => {
    const dir = path.join(tmp, "srv");
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    const lines = Array.from(
      { length: 250 },
      (_, i) => `[12:00:00] [Server thread/INFO]: line ${i}`,
    );
    fs.writeFileSync(path.join(dir, "logs", "latest.log"), `${lines.join("\r\n")}\r\n`);

    const snap = await agent.snapshot("srv", dir);
    expect(snap.source).toBe("logfile");
    expect(snap.status).toBe("stopped");
    expect(snap.lines).toHaveLength(200);
    expect(snap.lines.at(-1)?.line).toBe("[12:00:00] [Server thread/INFO]: line 249");
    expect(snap.lines[0]?.line).toBe("[12:00:00] [Server thread/INFO]: line 50");
    expect(snap.lines.every((l) => !l.line.includes("\r"))).toBe(true);
  });

  it("drops a partial first line when reading the end of a large log", async () => {
    const dir = path.join(tmp, "big");
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    // ~100 KB of lines so only the last 64 KB is read and the first line read is cut.
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `entry-${String(i).padStart(5, "0")} ${"x".repeat(40)}`,
    );
    fs.writeFileSync(path.join(dir, "logs", "latest.log"), lines.join("\n"));

    const snap = await agent.snapshot("big", dir);
    expect(snap.lines.length).toBeLessThanOrEqual(200);
    for (const l of snap.lines) expect(l.line).toMatch(/^entry-\d{5} x{40}$/);
    expect(snap.lines.at(-1)?.line.startsWith("entry-01999")).toBe(true);
  });
});
