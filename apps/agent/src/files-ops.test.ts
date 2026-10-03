import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyInto, removePaths, removeTree, statPaths } from "./files.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-files-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeServer(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "world", "region"), { recursive: true });
  fs.writeFileSync(path.join(dir, "world", "level.dat"), "x".repeat(100));
  fs.writeFileSync(path.join(dir, "world", "region", "r.0.0.mca"), "y".repeat(1000));
  fs.mkdirSync(path.join(dir, "plugins"));
  fs.writeFileSync(path.join(dir, "plugins", "a.jar"), "z".repeat(10));
  fs.writeFileSync(path.join(dir, "server.properties"), "motd=hi\n");
  return dir;
}

describe("agent file operations", () => {
  it("measures paths and reports missing ones", async () => {
    const dir = makeServer("stat");
    const stats = await statPaths(dir, ["world", "plugins", "server.properties", "nope"]);
    expect(stats.map((s) => [s.path, s.exists, s.kind, s.files, s.sizeBytes])).toEqual([
      ["world", true, "dir", 2, 1100],
      ["plugins", true, "dir", 1, 10],
      ["server.properties", true, "file", 1, 8],
      ["nope", false, null, 0, 0],
    ]);
  });

  it("copies selected entries and refuses to merge into existing data", async () => {
    const dir = makeServer("copy");
    const dest = path.join(tmp, "export");
    const res = await copyInto(dir, ["world", "server.properties", "missing"], dest);
    expect(res).toEqual({ files: 3, sizeBytes: 1108 });
    expect(fs.readFileSync(path.join(dest, "world", "level.dat"), "utf8")).toHaveLength(100);
    expect(fs.existsSync(path.join(dest, "plugins"))).toBe(false);
    await expect(copyInto(dir, ["world"], dest)).rejects.toThrow(/already exists/);
    await expect(copyInto(dir, ["world"], "relative/path")).rejects.toThrow(/absolute/);
  });

  it("rejects paths that escape the root", async () => {
    const dir = makeServer("escape");
    await expect(copyInto(dir, ["../stat"], path.join(tmp, "x"))).rejects.toThrow(/escapes/);
    await expect(removePaths(dir, ["../stat"])).rejects.toThrow(/escapes/);
    await expect(removePaths(dir, [""])).rejects.toThrow(/root itself/);
  });

  it("removes a tree completely and refuses shallow paths", async () => {
    const dir = makeServer("remove");
    await removeTree(dir);
    expect(fs.existsSync(dir)).toBe(false);
    await removeTree(dir); // already gone is fine
    await expect(removeTree(path.parse(tmp).root)).rejects.toThrow(/Refusing/);
  });
});
