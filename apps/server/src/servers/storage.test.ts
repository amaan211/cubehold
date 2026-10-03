import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DestinationError,
  defaultExportDestination,
  isInside,
  validateExportDestination,
} from "./storage.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-storage-test-"));
const dataDir = path.join(tmp, "data");
fs.mkdirSync(path.join(dataDir, "servers", "abc"), { recursive: true });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("isInside", () => {
  it("handles equality, children and look-alike siblings", () => {
    expect(isInside(dataDir, dataDir)).toBe(true);
    expect(isInside(dataDir, path.join(dataDir, "servers"))).toBe(true);
    expect(isInside(dataDir, `${dataDir}-other`)).toBe(false);
    expect(isInside(path.join(dataDir, "servers"), dataDir)).toBe(false);
  });
});

describe("validateExportDestination", () => {
  it("accepts a new folder outside the data dir", () => {
    const dest = path.join(tmp, "exports", "srv 1");
    expect(validateExportDestination(dest, dataDir)).toBe(path.resolve(dest));
  });

  it("accepts an existing empty folder", () => {
    const dest = path.join(tmp, "empty");
    fs.mkdirSync(dest);
    expect(validateExportDestination(dest, dataDir)).toBe(path.resolve(dest));
  });

  it("rejects relative paths, the data dir, non-empty folders and files", () => {
    expect(() => validateExportDestination("backups/x", dataDir)).toThrow(DestinationError);
    expect(() => validateExportDestination(path.join(dataDir, "servers", "abc"), dataDir)).toThrow(
      /outside the panel's data folder/,
    );
    const full = path.join(tmp, "full");
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, "a.txt"), "x");
    expect(() => validateExportDestination(full, dataDir)).toThrow(/already has files/);
    expect(() => validateExportDestination(path.join(full, "a.txt"), dataDir)).toThrow(/file/);
  });

  it("expands ~ to the home folder", () => {
    const out = validateExportDestination("~/cubehold-test-does-not-exist-123", dataDir);
    expect(out).toBe(path.join(os.homedir(), "cubehold-test-does-not-exist-123"));
  });
});

describe("defaultExportDestination", () => {
  it("builds a readable, filesystem-safe folder name", () => {
    const out = defaultExportDestination("My: Server*", new Date(2026, 8, 28, 9, 5));
    expect(path.basename(out)).toBe("My_ Server_ 2026-09-28 09-05");
    expect(out.startsWith(os.homedir())).toBe(true);
  });
});
