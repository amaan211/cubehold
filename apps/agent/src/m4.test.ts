import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitServerBinaries, gcJavaRuntimes, STAGING_DIR, writeInitialFiles } from "./install.js";
import { LocalAgent } from "./local-agent.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-m4-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("installs on the agent's host", () => {
  it("removes unused Java runtimes, keeping needed and running ones", async () => {
    const java = tmp();
    for (const v of ["8", "17", "21", "notes"]) {
      fs.mkdirSync(path.join(java, v, "bin"), { recursive: true });
      fs.writeFileSync(path.join(java, v, "bin", "java"), "x".repeat(100));
    }
    const removed = await gcJavaRuntimes(java, [21], [path.join(java, "17", "bin", "java")]);
    expect(removed).toEqual([{ major: 8, sizeBytes: 100 }]);
    expect(fs.readdirSync(java).sort()).toEqual(["17", "21", "notes"]);
  });

  it("only commits a jar from the server's own staging folder", async () => {
    const dir = tmp();
    const outside = path.join(tmp(), "evil.jar");
    fs.writeFileSync(outside, "x");
    const staged = { javaMajor: 21, jarFile: "server.jar", build: null, recommendedJvmFlags: null };
    await expect(
      commitServerBinaries(dir, { ...staged, stagedPath: outside }, undefined),
    ).rejects.toThrow(/staging folder/);

    fs.mkdirSync(path.join(dir, STAGING_DIR));
    const inside = path.join(dir, STAGING_DIR, "paper-1.jar");
    fs.writeFileSync(inside, "jar");
    fs.writeFileSync(path.join(dir, "old.jar"), "old");
    await commitServerBinaries(
      dir,
      { ...staged, jarFile: "paper-1.jar", stagedPath: inside },
      "old.jar",
    );
    expect(fs.readFileSync(path.join(dir, "paper-1.jar"), "utf8")).toBe("jar");
    expect(fs.existsSync(path.join(dir, "old.jar"))).toBe(false);
    expect(fs.existsSync(path.join(dir, STAGING_DIR))).toBe(false);
  });

  it("writes eula.txt and keeps an existing server.properties", async () => {
    const dir = path.join(tmp(), "new-server");
    await writeInitialFiles({ directory: dir, port: 25570, name: "Test", onlineMode: false });
    expect(fs.readFileSync(path.join(dir, "eula.txt"), "utf8")).toMatch(/eula=true/);
    const props = fs.readFileSync(path.join(dir, "server.properties"), "utf8");
    expect(props).toMatch(/server-port=25570/);
    expect(props).toMatch(/online-mode=false/);
    fs.writeFileSync(path.join(dir, "server.properties"), "motd=mine\n");
    await writeInitialFiles({ directory: dir, port: 1, name: "x", onlineMode: true });
    expect(fs.readFileSync(path.join(dir, "server.properties"), "utf8")).toBe("motd=mine\n");
  });

  it("reports its data folder and disk, and refuses plain http downloads", async () => {
    const data = tmp();
    const agent = new LocalAgent({ dataDir: data });
    try {
      const info = await agent.hostInfo();
      expect(info.dataDir).toBe(path.resolve(data));
      expect(info.diskTotalMb).toBeGreaterThan(0);
      expect(info.os).toBeTruthy();
      await expect(
        agent.fetchUrl({ url: "http://example.com/x.jar", root: data, relPath: "x.jar" }),
      ).rejects.toThrow(/https/);
      await expect(
        agent.fetchUrl({ url: "https://example.com/x.jar", root: data, relPath: "../x.jar" }),
      ).rejects.toThrow();
    } finally {
      await agent.shutdown();
    }
  });
});
