import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeResolve } from "./files.js";

describe("safeResolve", () => {
  const root = path.resolve("/srv/mc/abc");
  it("allows paths inside the root", () => {
    expect(safeResolve(root, "server.properties")).toBe(path.join(root, "server.properties"));
    expect(safeResolve(root, "world/level.dat")).toBe(path.join(root, "world", "level.dat"));
    expect(safeResolve(root, "/leading-slash.txt")).toBe(path.join(root, "leading-slash.txt"));
    expect(safeResolve(root, "")).toBe(root);
  });
  it("rejects traversal", () => {
    expect(() => safeResolve(root, "../other")).toThrow(/escapes/);
    expect(() => safeResolve(root, "world/../../x")).toThrow(/escapes/);
    expect(() => safeResolve(root, "..")).toThrow(/escapes/);
  });
});
