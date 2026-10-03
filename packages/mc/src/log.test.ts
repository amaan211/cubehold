import { describe, expect, it } from "vitest";
import { fallbackJavaMajor } from "./java.js";
import { buildJavaArgs } from "./launch.js";
import { parseLogLine, stripPrefix } from "./log.js";

describe("log parser", () => {
  it("strips vanilla and paper prefixes", () => {
    expect(stripPrefix("[12:00:00] [Server thread/INFO]: Hello")).toBe("Hello");
    expect(stripPrefix("[12:00:00 INFO]: Hello")).toBe("Hello");
    expect(stripPrefix("[12:00:00 WARN]: \x1b[33mHello\x1b[0m")).toBe("Hello");
  });

  it("detects done, join, leave, stop, eula, port", () => {
    expect(parseLogLine('[10:00:00 INFO]: Done (4.213s)! For help, type "help"')).toEqual({
      type: "done",
      seconds: 4.213,
    });
    expect(parseLogLine("[10:00:00] [Server thread/INFO]: Steve joined the game")).toEqual({
      type: "join",
      player: "Steve",
    });
    expect(parseLogLine("[10:00:00 INFO]: Alex left the game")).toEqual({
      type: "leave",
      player: "Alex",
    });
    expect(parseLogLine("[10:00:00 INFO]: Alex lost connection: Disconnected")).toEqual({
      type: "leave",
      player: "Alex",
    });
    expect(parseLogLine("[10:00:00 INFO]: Stopping server")?.type).toBe("stopping");
    expect(
      parseLogLine(
        "[10:00:00 WARN]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.",
      )?.type,
    ).toBe("eula");
    expect(parseLogLine("[10:00:00 WARN]: **** FAILED TO BIND TO PORT!")?.type).toBe("port_in_use");
    expect(parseLogLine("[10:00:00 INFO]: Preparing spawn area: 4%")).toBeNull();
  });

  it("parses paper tps output", () => {
    expect(parseLogLine("[10:00:00 INFO]: TPS from last 1m, 5m, 15m: *20.0, 19.98, 20.0")).toEqual({
      type: "tps",
      values: [20, 19.98, 20],
    });
  });
});

describe("java matrix fallback", () => {
  it("maps versions to java majors", () => {
    expect(fallbackJavaMajor("1.16.5")).toBe(8);
    expect(fallbackJavaMajor("1.17.1")).toBe(16);
    expect(fallbackJavaMajor("1.18.2")).toBe(17);
    expect(fallbackJavaMajor("1.20.4")).toBe(17);
    expect(fallbackJavaMajor("1.20.5")).toBe(21);
    expect(fallbackJavaMajor("1.21.11")).toBe(21);
    expect(fallbackJavaMajor("26.3")).toBe(25);
  });
});

describe("launch args", () => {
  it("uses memory and ends with the jar and --nogui", () => {
    const args = buildJavaArgs({ software: "paper", memoryMb: 2048, jarFile: "server.jar" });
    expect(args[0]).toBe("-Xms2048M");
    expect(args[1]).toBe("-Xmx2048M");
    expect(args.slice(-3)).toEqual(["-jar", "server.jar", "--nogui"]);
    expect(args).toContain("-XX:+UseG1GC");
  });

  it("prefers vendor flags when given", () => {
    const args = buildJavaArgs({
      software: "paper",
      memoryMb: 1024,
      jarFile: "server.jar",
      recommendedJvmFlags: ["-XX:+UseZGC"],
    });
    expect(args).toContain("-XX:+UseZGC");
    expect(args).not.toContain("-XX:+UseG1GC");
  });
});
