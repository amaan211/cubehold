import { describe, expect, it } from "vitest";
import { analyzeCrash } from "./crash.js";
import { buildJavaArgs } from "./launch.js";
import { parseLogLine, stripPrefix } from "./log.js";
import { overrideTarget, planModpack, safePackPath, suggestedModpackMemoryMb } from "./modpack.js";
import { neoForgeMinecraftVersion } from "./versions/forge.js";

describe("NeoForge versions", () => {
  it("maps loader versions to Minecraft versions", () => {
    expect(neoForgeMinecraftVersion("21.1.172")).toBe("1.21.1");
    expect(neoForgeMinecraftVersion("21.0.167")).toBe("1.21");
    expect(neoForgeMinecraftVersion("20.4.237")).toBe("1.20.4");
    expect(neoForgeMinecraftVersion("21.11.45")).toBe("1.21.11");
    expect(neoForgeMinecraftVersion("26.1.2.112")).toBe("26.1.2");
    expect(neoForgeMinecraftVersion("26.1.0.5-beta")).toBe("26.1");
  });

  it("skips versions it cannot place", () => {
    expect(neoForgeMinecraftVersion("20.1.0")).toBeNull(); // 1.20.1 NeoForge lived under another name
    expect(neoForgeMinecraftVersion("26.1.3")).toBeNull();
    expect(neoForgeMinecraftVersion("banana")).toBeNull();
  });
});

describe("launching Forge and NeoForge", () => {
  it("uses the args file instead of -jar", () => {
    const args = buildJavaArgs({
      software: "neoforge",
      memoryMb: 6144,
      jarFile: "libraries/net/neoforged/neoforge/21.1.172",
      argsFile: "libraries/net/neoforged/neoforge/21.1.172/unix_args.txt",
    });
    expect(args).toContain("@libraries/net/neoforged/neoforge/21.1.172/unix_args.txt");
    expect(args).not.toContain("-jar");
    expect(args.at(-1)).toBe("--nogui");
    expect(args[1]).toBe("-Xmx6144M");
  });
});

const sha512 = "a".repeat(128);
const sha1 = "b".repeat(40);

function pack(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.4.0",
    name: "Test Pack",
    dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.10" },
    files: [
      {
        path: "mods/lithium.jar",
        hashes: { sha1, sha512 },
        env: { client: "required", server: "required" },
        downloads: ["https://cdn.modrinth.com/data/gvQqBUqZ/versions/x/lithium.jar"],
        fileSize: 700_000,
      },
      {
        path: "mods/sodium.jar",
        hashes: { sha1, sha512 },
        env: { client: "required", server: "unsupported" },
        downloads: ["https://cdn.modrinth.com/data/AANobbMI/versions/y/sodium.jar"],
        fileSize: 900_000,
      },
      {
        path: "config/tweaks.json",
        hashes: { sha1 },
        downloads: ["https://raw.githubusercontent.com/example/pack/main/tweaks.json"],
        fileSize: 1_000,
      },
    ],
    ...overrides,
  };
}

describe("Modrinth modpacks", () => {
  it("plans a Fabric pack and leaves client-only files out", () => {
    const plan = planModpack(pack());
    expect(plan.software).toBe("fabric");
    expect(plan.loaderVersion).toBe("0.16.10");
    expect(plan.mcVersion).toBe("1.21.1");
    expect(plan.files.map((f) => f.path)).toEqual(["mods/lithium.jar", "config/tweaks.json"]);
    expect(plan.clientOnly).toBe(1);
    expect(plan.downloadBytes).toBe(701_000);
    expect(suggestedModpackMemoryMb(plan)).toBe(4096);
  });

  it("knows NeoForge and Forge packs", () => {
    expect(
      planModpack(pack({ dependencies: { minecraft: "1.21.1", neoforge: "21.1.172" } })),
    ).toMatchObject({
      software: "neoforge",
      loaderVersion: "21.1.172",
    });
    expect(
      planModpack(pack({ dependencies: { minecraft: "1.20.1", forge: "47.4.0" } })),
    ).toMatchObject({
      software: "forge",
      loaderVersion: "47.4.0",
    });
    expect(() =>
      planModpack(pack({ dependencies: { minecraft: "1.21.1", "quilt-loader": "0.26" } })),
    ).toThrow(/Quilt/);
  });

  it("refuses files outside the server folder", () => {
    for (const bad of ["../escape.jar", "/etc/passwd", "C:/Windows/evil.dll", "mods/../../x.jar"]) {
      const p = pack();
      p.files[0] = { ...(p.files[0] as object), path: bad } as (typeof p.files)[0];
      expect(() => planModpack(p)).toThrow(/outside the server folder/);
    }
  });

  it("refuses downloads from hosts the format does not allow", () => {
    const p = pack();
    p.files[0] = {
      ...(p.files[0] as object),
      downloads: ["https://evil.example.com/lithium.jar"],
    } as (typeof p.files)[0];
    expect(() => planModpack(p)).toThrow(/host/);
    p.files[0] = {
      ...(p.files[0] as object),
      downloads: ["http://cdn.modrinth.com/x.jar"],
    } as (typeof p.files)[0];
    expect(() => planModpack(p)).toThrow(/host/);
  });

  it("refuses files without a checksum and indexes that are not packs", () => {
    const p = pack();
    p.files[0] = { ...(p.files[0] as object), hashes: {} } as (typeof p.files)[0];
    expect(() => planModpack(p)).toThrow(/checksum/);
    expect(() => planModpack({ hello: "world" })).toThrow(/not a Modrinth modpack/);
  });

  it("maps override entries and ignores anything else", () => {
    expect(overrideTarget("overrides/config/a.toml")).toEqual({
      path: "config/a.toml",
      server: false,
    });
    expect(overrideTarget("server-overrides/config/a.toml")).toEqual({
      path: "config/a.toml",
      server: true,
    });
    expect(overrideTarget("overrides/config/")).toBeNull();
    expect(overrideTarget("overrides/../evil.txt")).toBeNull();
    expect(overrideTarget("modrinth.index.json")).toBeNull();
    expect(overrideTarget("client-overrides/options.txt")).toBeNull();
  });

  it("normalises safe paths", () => {
    expect(safePackPath("mods\\a.jar")).toBe("mods/a.jar");
    expect(safePackPath("./config//x.json")).toBe("config/x.json");
    expect(safePackPath("")).toBeNull();
  });
});

describe("crash analysis", () => {
  it("says when a mod needs a newer loader", () => {
    const log = [
      "[main/ERROR] [net.neoforged.fml.loading.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:",
      "[main/FATAL] [net.neoforged.fml.ModLoader/CORE]: Error during pre-loading phase: Mod ferritecore requires neoforge 21.1.218 or above",
    ].join("\n");
    expect(analyzeCrash(log).cause).toBe("loader_too_old");
  });

  it("still reports other missing mods as dependencies", () => {
    expect(
      analyzeCrash("Missing or unsupported mandatory dependencies:\n\tMod ID: 'architectury'")
        .cause,
    ).toBe("mod_dependencies");
  });
});

describe("Forge and NeoForge console lines", () => {
  it("finds the message after the logger name", () => {
    const done =
      '[22:30:47] [Server thread/INFO] [minecraft/DedicatedServer]: Done (4.065s)! For help, type "help"';
    expect(parseLogLine(done)).toEqual({ type: "done", seconds: 4.065 });
    expect(
      parseLogLine(
        "[22:31:02] [Server thread/INFO] [minecraft/MinecraftServer]: Steve joined the game",
      ),
    ).toEqual({ type: "join", player: "Steve" });
  });

  it("keeps brackets that belong to the message", () => {
    expect(stripPrefix("[12:00:00] [Server thread/INFO]: [Not Secure] <Steve> hi")).toBe(
      "[Not Secure] <Steve> hi",
    );
    expect(stripPrefix("[12:00:00 INFO]: [Geyser] Started")).toBe("[Geyser] Started");
  });
});
