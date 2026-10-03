import { describe, expect, it } from "vitest";
import {
  applyProperties,
  coerceValue,
  defaultPropertiesText,
  parseProperties,
  propertiesToMap,
  serializeProperties,
  validateValues,
} from "./properties.js";

const SAMPLE = `#Minecraft server properties
#Sat Sep 27 2026
enable-jmx-monitoring=false
rcon.port=25575
level-seed=
gamemode=survival
motd=A Minecraft Server \\u00A7aGreen
server-port=25565
online-mode=true
`;

describe("properties", () => {
  it("parses keys, preserves comments and unknown keys", () => {
    const parsed = parseProperties(SAMPLE);
    const map = propertiesToMap(parsed);
    expect(map.get("gamemode")).toBe("survival");
    expect(map.get("level-seed")).toBe("");
    expect(map.get("motd")).toBe("A Minecraft Server §aGreen");
    expect(parsed.lines[0]).toEqual({ raw: "#Minecraft server properties" });
    expect(map.has("enable-jmx-monitoring")).toBe(true);
  });

  it("applies values in place and appends new keys", () => {
    const parsed = parseProperties(SAMPLE);
    const out = serializeProperties(
      applyProperties(parsed, { gamemode: "creative", "max-players": 8, pvp: false }),
    );
    const lines = out.split("\n");
    expect(lines.indexOf("gamemode=creative")).toBe(5); // same position as before
    expect(out).toContain("max-players=8\n");
    expect(out).toContain("pvp=false\n");
    expect(out.startsWith("#Minecraft server properties\n")).toBe(true);
  });

  it("coerces raw strings by spec type", () => {
    expect(coerceValue("online-mode", "true")).toBe(true);
    expect(coerceValue("online-mode", "FALSE")).toBe(false);
    expect(coerceValue("max-players", "42")).toBe(42);
    expect(coerceValue("max-players", "garbage")).toBe(20);
    expect(coerceValue("unknown-key", "x")).toBe("x");
  });

  it("validates ranges, enums and managed keys", () => {
    const errors = validateValues({
      "max-players": 0,
      difficulty: "brutal",
      "server-port": 1234,
      motd: "ok",
      "view-distance": 12,
    });
    expect(Object.keys(errors).sort()).toEqual(["difficulty", "max-players", "server-port"]);
  });

  it("produces a default file with the chosen port", () => {
    const text = defaultPropertiesText({ port: 25570, motd: "Hi" });
    const map = propertiesToMap(parseProperties(text));
    expect(map.get("server-port")).toBe("25570");
    expect(map.get("online-mode")).toBe("true");
    expect(map.get("enable-rcon")).toBe("false");
  });
});
