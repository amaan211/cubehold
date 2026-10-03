import { describe, expect, it } from "vitest";
import { addonPlatform } from "./addons.js";
import {
  parseListOutput,
  parseMsptOutput,
  parseTickQuery,
  parseTpsOutput,
  tpsCommandFor,
} from "./commands.js";
import { analyzeCrash, errorLines, unexplainedExit } from "./crash.js";
import { buildJavaArgs } from "./launch.js";
import { estimateProcessMemoryMb, gcLogArgs, parseGcLog } from "./memory.js";
import { banDate, isValidIp, isValidPlayerName, offlineUuid } from "./players.js";

describe("tick performance", () => {
  it("picks the command per software and version", () => {
    expect(tpsCommandFor("paper", "1.21.11")).toBe("tps");
    expect(tpsCommandFor("purpur", "1.16.5")).toBe("tps");
    expect(tpsCommandFor("vanilla", "1.20.3")).toBe("tick query");
    expect(tpsCommandFor("fabric", "26.3")).toBe("tick query");
    expect(tpsCommandFor("vanilla", "1.20.2")).toBeNull();
    expect(tpsCommandFor("vanilla", "1.19.4")).toBeNull();
  });

  it("parses paper tps and mspt", () => {
    expect(parseTpsOutput("§6TPS from last 1m, 5m, 15m: §a*20.0, §a19.98, §a20.0")).toBe(20);
    expect(parseTpsOutput("TPS from last 1m, 5m, 15m: 17.5, 19.0, 19.9")).toBe(17.5);
    expect(parseTpsOutput("Unknown command")).toBeNull();
    expect(
      parseMsptOutput(
        "§6Server tick times §e(§7avg§e/§7min§e/§7max§e)§6 from last 5s§7,§6 10s§7,§6 1m§e:\n§6◴ §a1.2§7/§a0.8§7/§a5.3§e, §a1.1§7/§a0.7§7/§a6.0",
      ),
    ).toBe(1.2);
  });

  it("parses vanilla tick query", () => {
    const text =
      "The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: 2.3ms (Target: 50.0ms)\nPercentiles: P50: 2.1ms P95: 3.0ms P99: 4.4ms, sample: 100";
    expect(parseTickQuery(text)).toEqual({ tps: 20, mspt: 2.3 });
    expect(
      parseTickQuery(
        "Target tick rate: 20.0 per second.Average time per tick: 80.0ms (Target: 50.0ms)",
      ),
    ).toEqual({ tps: 12.5, mspt: 80 });
  });

  it("parses list output", () => {
    expect(parseListOutput("There are 2 of a max of 20 players online: Alex, Steve")).toEqual({
      online: 2,
      max: 20,
      players: ["Alex", "Steve"],
    });
    expect(parseListOutput("There are 0 of a max of 20 players online: ")).toEqual({
      online: 0,
      max: 20,
      players: [],
    });
    expect(
      parseListOutput("§6There are §c1§6 out of maximum §c20§6 players online.\ndefault: Alex"),
    ).toEqual({
      online: 1,
      max: 20,
      players: ["Alex"],
    });
  });
});

describe("memory", () => {
  it("reads the latest heap figure from G1 and ZGC logs", () => {
    const g1 = [
      "[1.234s] Using G1",
      "[12.5s] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 204M->38M(4096M) 9.1ms",
      "[40.1s] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 1230M->412M(4096M) 12.3ms",
    ].join("\n");
    expect(parseGcLog(g1)).toEqual({ usedMb: 412, committedMb: 4096 });
    expect(parseGcLog("[3s] GC(2) Major Collection (Warmup) 820M(20%)->210M(5%) 0.3s")).toEqual({
      usedMb: 210,
      committedMb: null,
    });
    expect(parseGcLog("[1.2s] Using G1")).toBeNull();
    expect(parseGcLog("[5s] GC(3) Pause Full 2G->1G(4G) 1s")).toEqual({
      usedMb: 1024,
      committedMb: 4096,
    });
  });

  it("adds the gc log flag from Java 9 and estimates overhead", () => {
    expect(gcLogArgs(8)).toEqual([]);
    expect(gcLogArgs(21)[0]).toMatch(/^-Xlog:gc:file=\.cubehold\/gc\.log:/);
    const args = buildJavaArgs({
      software: "paper",
      memoryMb: 2048,
      jarFile: "server.jar",
      javaMajor: 21,
    });
    expect(args.some((a) => a.startsWith("-Xlog:gc"))).toBe(true);
    expect(args.slice(-3)).toEqual(["-jar", "server.jar", "--nogui"]);
    expect(estimateProcessMemoryMb(4096)).toBeGreaterThan(4096 + 512);
    expect(estimateProcessMemoryMb(4096)).toBeLessThan(4096 + 1024);
  });
});

describe("players", () => {
  it("derives offline-mode UUIDs like the server does", () => {
    // Java: UUID.nameUUIDFromBytes("OfflinePlayer:Notch".getBytes(UTF_8))
    expect(offlineUuid("Notch")).toBe("b50ad385-829d-3141-a216-7e7d7539ba7f");
    expect(offlineUuid("Steve")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("validates names and addresses", () => {
    expect(isValidPlayerName("Steve_01")).toBe(true);
    expect(isValidPlayerName("bad name")).toBe(false);
    expect(isValidPlayerName("a".repeat(17))).toBe(false);
    expect(isValidIp("192.168.1.20")).toBe(true);
    expect(isValidIp("300.1.1.1")).toBe(false);
    expect(isValidIp("2001:db8::1")).toBe(true);
  });

  it("formats ban dates the way Minecraft does", () => {
    expect(banDate(new Date(Date.UTC(2026, 8, 28, 14, 3, 12)))).toBe("2026-09-28 14:03:12 +0000");
  });
});

describe("crash analysis", () => {
  it("recognises out-of-memory and names the plugin jar", () => {
    const text = [
      "---- Minecraft Crash Report ----",
      "Description: Exception in server tick loop",
      "java.lang.OutOfMemoryError: Java heap space",
      "\tat java.base/java.util.Arrays.copyOf(Arrays.java:3512)",
      "\tat com.example.farm.FarmTask.run(FarmTask.java:42) ~[MegaFarm-1.2.jar:?]",
      "\tat net.minecraft.server.MinecraftServer.tick(MinecraftServer.java:1) ~[paper-1.21.11.jar:?]",
    ].join("\n");
    const a = analyzeCrash(text);
    expect(a.cause).toBe("out_of_memory");
    expect(a.description).toBe("Exception in server tick loop");
    expect(a.exception).toBe("java.lang.OutOfMemoryError: Java heap space");
    expect(a.suspects[0]).toBe("MegaFarm-1.2.jar");
    expect(a.suspects).not.toContain("paper-1.21.11.jar");
  });

  it("recognises common causes and falls back to unknown", () => {
    expect(analyzeCrash("**** FAILED TO BIND TO PORT!").cause).toBe("port_in_use");
    expect(
      analyzeCrash("net.minecraft.world.level.storage.LevelStorageException: session.lock").cause,
    ).toBe("world_locked");
    expect(
      analyzeCrash("Incompatible mods found!\n - Mod 'Foo' requires any version of fabric-api")
        .cause,
    ).toBe("mod_dependencies");
    expect(analyzeCrash("A single server tick took 60.00 seconds (should be max 0.05)").cause).toBe(
      "watchdog",
    );
    const other = analyzeCrash("something odd\n\tat org.example.thing.Widget.go(Widget.java:1)");
    expect(other.cause).toBe("unknown");
    expect(other.suspects).toEqual(["org.example.thing"]);
  });

  it("ignores the normal startup log and explains a silent exit", () => {
    const startup = [
      '[10:00:00 INFO]: Preparing level "world"',
      "[10:00:01 INFO]: Loaded 1290 recipes; RegionFile cache warmed; level.dat read",
      '[10:00:02 INFO]: Done (3.1s)! For help, type "help"',
    ];
    expect(errorLines(startup)).toEqual([]);
    expect(unexplainedExit(1)).toMatchObject({ cause: "killed" });
    const failing = [
      ...startup,
      "[10:05:00 ERROR]: Encountered an unexpected exception",
      "java.lang.IllegalStateException: boom",
      "\tat com.example.Plug.tick(Plug.java:9) ~[Plug-1.0.jar:?]",
      "[10:05:00 INFO]: Stopping server",
    ];
    const errs = errorLines(failing);
    expect(errs).toHaveLength(3);
    expect(analyzeCrash(errs.join("\n")).suspects).toEqual(["Plug-1.0.jar", "com.example.Plug"]);
  });
});

describe("addon platforms", () => {
  it("maps software to folders and loaders", () => {
    expect(addonPlatform("paper")?.folder).toBe("plugins");
    expect(addonPlatform("purpur")?.modrinthLoaders[0]).toBe("purpur");
    expect(addonPlatform("fabric")).toMatchObject({ folder: "mods", kind: "mod", hangar: false });
    expect(addonPlatform("vanilla")).toBeNull();
  });
});
