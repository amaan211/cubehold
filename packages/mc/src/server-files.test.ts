import { describe, expect, it } from "vitest";
import { defaultPropertiesText, parseProperties, propertiesToMap } from "./properties.js";
import { classifyEntry, versionArtifacts } from "./server-files.js";
import { compareVersionsIn } from "./versions/index.js";

describe("classifyEntry", () => {
  it("recognises world folders for the configured level name", () => {
    expect(classifyEntry("world", "dir")).toBe("world");
    expect(classifyEntry("world_nether", "dir")).toBe("world");
    expect(classifyEntry("world_the_end", "dir")).toBe("world");
    expect(classifyEntry("survival", "dir", "survival")).toBe("world");
    expect(classifyEntry("world", "dir", "survival")).toBe("other");
  });

  it("separates downloaded binaries from user data", () => {
    expect(classifyEntry("server.jar", "file")).toBe("downloaded");
    expect(classifyEntry("fabric-server-launch.jar", "file")).toBe("downloaded");
    expect(classifyEntry("libraries", "dir")).toBe("downloaded");
    expect(classifyEntry("cache", "dir")).toBe("downloaded");
    expect(classifyEntry(".fabric", "dir")).toBe("downloaded");
    expect(classifyEntry(".cubehold-staging", "dir")).toBe("downloaded");
    expect(classifyEntry("plugins", "dir")).toBe("addons");
    expect(classifyEntry("mods", "dir")).toBe("addons");
    expect(classifyEntry("server.properties", "file")).toBe("config");
    expect(classifyEntry("whitelist.json", "file")).toBe("config");
    expect(classifyEntry("paper-global.yml", "file")).toBe("config");
    expect(classifyEntry("logs", "dir")).toBe("logs");
    expect(classifyEntry("crash-reports", "dir")).toBe("logs");
    expect(classifyEntry("something-else", "dir")).toBe("other");
  });

  it("lists version artifacts including the current jar", () => {
    expect(versionArtifacts("server.jar")).toEqual(
      expect.arrayContaining(["server.jar", "cache", "libraries", "versions", ".fabric"]),
    );
    expect(versionArtifacts(undefined)).not.toContain("server.jar");
  });
});

describe("compareVersionsIn", () => {
  const list = [
    { id: "26.3", kind: "release" as const, releasedAt: null },
    { id: "26.3-rc-3", kind: "snapshot" as const, releasedAt: null },
    { id: "26.2", kind: "release" as const, releasedAt: null },
    { id: "1.21.11", kind: "release" as const, releasedAt: null },
    { id: "1.21.10", kind: "release" as const, releasedAt: null },
  ];
  it("orders by the vendor list", () => {
    expect(compareVersionsIn(list, "26.2", "26.3")).toBeLessThan(0);
    expect(compareVersionsIn(list, "26.3", "1.21.11")).toBeGreaterThan(0);
    expect(compareVersionsIn(list, "26.3-rc-3", "26.3")).toBeLessThan(0);
    expect(compareVersionsIn(list, "1.21.10", "1.21.10")).toBe(0);
  });
  it("falls back to numeric order for unknown versions", () => {
    expect(compareVersionsIn(list, "1.20.4", "1.21.1")).toBeLessThan(0);
    expect(compareVersionsIn(list, "1.21.2", "1.21.1")).toBeGreaterThan(0);
  });
});

describe("offline mode defaults", () => {
  it("turns off every auth key", () => {
    const map = propertiesToMap(
      parseProperties(defaultPropertiesText({ port: 25565, motd: "x", onlineMode: false })),
    );
    expect(map.get("online-mode")).toBe("false");
    expect(map.get("enforce-secure-profile")).toBe("false");
  });
  it("keeps auth on by default", () => {
    const map = propertiesToMap(parseProperties(defaultPropertiesText({ port: 25565, motd: "x" })));
    expect(map.get("online-mode")).toBe("true");
    expect(map.get("enforce-secure-profile")).toBe("true");
  });
});
