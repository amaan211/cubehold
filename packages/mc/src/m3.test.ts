import { securityGrade, securityScore } from "@cubehold/shared";
import { describe, expect, it } from "vitest";
import { bedrockSupport, geyserArgs, log4jMitigation } from "./hardening.js";
import { buildJavaArgs } from "./launch.js";
import { playerFileDirs, usesPlayersFolder } from "./player-data.js";

describe("Log4Shell mitigation", () => {
  it("follows Mojang's advice per version", () => {
    expect(log4jMitigation("vanilla", "1.6.4").status).toBe("not-affected");
    expect(log4jMitigation("vanilla", "1.8.9")).toMatchObject({
      status: "config-file",
      args: ["-Dlog4j.configurationFile=log4j2_17-111.xml"],
    });
    expect(log4jMitigation("fabric", "1.16.5").file?.name).toBe("log4j2_112-116.xml");
    expect(log4jMitigation("vanilla", "1.17.1").status).toBe("flag");
    expect(log4jMitigation("vanilla", "1.18").status).toBe("flag");
    expect(log4jMitigation("vanilla", "1.18.1").status).toBe("not-affected");
    expect(log4jMitigation("vanilla", "26.3").status).toBe("not-affected");
    expect(log4jMitigation("paper", "1.12.2").status).toBe("fixed-build");
  });

  it("puts panel flags before the user's own", () => {
    const args = buildJavaArgs({
      software: "vanilla",
      memoryMb: 1024,
      jarFile: "server.jar",
      extraJvmArgs: ["-Dmine=1"],
      managedArgs: ["-Dlog4j.configurationFile=log4j2_112-116.xml", ...geyserArgs(19133)],
    });
    const i = (a: string) => args.indexOf(a);
    expect(i("-DgeyserUdpPort=19133")).toBeGreaterThan(0);
    expect(i("-DgeyserUdpPort=19133")).toBeLessThan(i("-Dmine=1"));
    expect(i("-Dmine=1")).toBeLessThan(i("-jar"));
    expect(geyserArgs(null)).toEqual([]);
  });
});

describe("Bedrock support", () => {
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let k = 0; k < 3; k++) {
      const d = (pa[k] ?? 0) - (pb[k] ?? 0);
      if (d) return d;
    }
    return 0;
  };

  it("needs Paper or Purpur 1.20.5+ on Java 21, with ViaVersion when behind", () => {
    expect(bedrockSupport("vanilla", "26.3", 25, "26.3", cmp)).toMatchObject({ supported: false });
    expect(bedrockSupport("paper", "1.20.4", 17, "26.3", cmp)).toMatchObject({ supported: false });
    expect(bedrockSupport("paper", "1.21.11", 21, "26.3", cmp)).toEqual({
      supported: true,
      via: "geysermc",
      needsViaVersion: true,
    });
    expect(bedrockSupport("purpur", "26.3", 25, "26.3", cmp)).toMatchObject({
      needsViaVersion: false,
    });
    expect(bedrockSupport("fabric", "1.21.11", 21, "26.3", cmp)).toMatchObject({ via: "modrinth" });
  });
});

describe("player files", () => {
  it("follows the 26.1 move of player data under players/", () => {
    expect(usesPlayersFolder("26.1")).toBe(true);
    expect(usesPlayersFolder("26.3.1")).toBe(true);
    expect(usesPlayersFolder("1.21.11")).toBe(false);
    expect(playerFileDirs("world", "players")).toEqual({
      data: "world/players/data",
      stats: "world/players/stats",
      advancements: "world/players/advancements",
    });
    expect(playerFileDirs("world", "legacy").data).toBe("world/playerdata");
  });
});

describe("security score", () => {
  it("costs points by severity, half for warnings", () => {
    expect(securityScore([])).toBe(100);
    expect(securityScore([{ status: "fail", severity: "critical" }])).toBe(60);
    expect(
      securityScore([
        { status: "warn", severity: "high" },
        { status: "info", severity: "critical" },
      ]),
    ).toBe(90);
    expect(securityScore(Array(5).fill({ status: "fail", severity: "critical" }))).toBe(0);
    expect([95, 80, 65, 45, 10].map(securityGrade)).toEqual(["A", "B", "C", "D", "F"]);
  });
});
