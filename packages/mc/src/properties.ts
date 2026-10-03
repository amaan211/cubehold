import type { PropertySpec, PropertyValue } from "@cubehold/shared";

/**
 * Typed description of the server.properties keys we expose in the UI.
 * Anything not listed here is preserved verbatim when the file is rewritten.
 */
export const PROPERTY_SPECS: PropertySpec[] = [
  // --- General -------------------------------------------------------------
  {
    key: "motd",
    label: "MOTD",
    description: "Message shown in the server list.",
    group: "General",
    type: "string",
    default: "A Minecraft Server",
  },
  {
    key: "max-players",
    label: "Max players",
    description: "Maximum number of players allowed at once.",
    group: "General",
    type: "integer",
    default: 20,
    min: 1,
    max: 1000,
  },
  {
    key: "server-port",
    label: "Port",
    description: "TCP port the server listens on. Managed by the panel.",
    group: "General",
    type: "integer",
    default: 25565,
    min: 1,
    max: 65535,
    managed: true,
  },
  {
    key: "online-mode",
    label: "Online mode",
    description:
      "Verify every player's Microsoft account with Mojang's session servers before they can join.",
    group: "Authentication",
    type: "boolean",
    default: true,
  },
  {
    key: "white-list",
    label: "Whitelist",
    description: "Only whitelisted players can join.",
    group: "General",
    type: "boolean",
    default: false,
  },
  {
    key: "enforce-whitelist",
    label: "Enforce whitelist",
    description: "Kick players already online when they are removed from the whitelist.",
    group: "General",
    type: "boolean",
    default: false,
  },
  {
    key: "pvp",
    label: "PvP",
    description: "Players can damage each other.",
    group: "General",
    type: "boolean",
    default: true,
  },

  // --- World ---------------------------------------------------------------
  {
    key: "level-name",
    label: "World folder",
    description: "Name of the world directory.",
    group: "World",
    type: "string",
    default: "world",
  },
  {
    key: "level-seed",
    label: "Seed",
    description: "World generation seed. Leave blank for random. Only affects new worlds.",
    group: "World",
    type: "string",
    default: "",
  },
  {
    key: "level-type",
    label: "World type",
    description: "Generator preset. Only affects new worlds.",
    group: "World",
    type: "enum",
    default: "minecraft:normal",
    options: [
      "minecraft:normal",
      "minecraft:flat",
      "minecraft:large_biomes",
      "minecraft:amplified",
      "minecraft:single_biome_surface",
    ],
  },
  {
    key: "gamemode",
    label: "Default game mode",
    description: "Game mode for new players.",
    group: "World",
    type: "enum",
    default: "survival",
    options: ["survival", "creative", "adventure", "spectator"],
  },
  {
    key: "force-gamemode",
    label: "Force game mode",
    description: "Reset players to the default game mode on join.",
    group: "World",
    type: "boolean",
    default: false,
  },
  {
    key: "difficulty",
    label: "Difficulty",
    description: "World difficulty.",
    group: "World",
    type: "enum",
    default: "easy",
    options: ["peaceful", "easy", "normal", "hard"],
  },
  {
    key: "hardcore",
    label: "Hardcore",
    description: "Players are banned on death. Only affects new worlds.",
    group: "World",
    type: "boolean",
    default: false,
  },
  {
    key: "allow-nether",
    label: "Allow Nether",
    description: "Enable the Nether dimension.",
    group: "World",
    type: "boolean",
    default: true,
  },
  {
    key: "generate-structures",
    label: "Generate structures",
    description: "Villages, strongholds and so on. Only affects new chunks.",
    group: "World",
    type: "boolean",
    default: true,
  },
  {
    key: "spawn-protection",
    label: "Spawn protection",
    description: "Radius around spawn that only operators can modify. 0 disables it.",
    group: "World",
    type: "integer",
    default: 16,
    min: 0,
    max: 1000,
  },
  {
    key: "max-world-size",
    label: "Max world size",
    description: "World border radius in blocks.",
    group: "World",
    type: "integer",
    default: 29999984,
    min: 1,
    max: 29999984,
  },

  // --- Performance ---------------------------------------------------------
  {
    key: "view-distance",
    label: "View distance",
    description: "Chunks sent to players in each direction. Lower values save CPU and bandwidth.",
    group: "Performance",
    type: "integer",
    default: 10,
    min: 3,
    max: 32,
  },
  {
    key: "simulation-distance",
    label: "Simulation distance",
    description: "Chunks around players that are ticked.",
    group: "Performance",
    type: "integer",
    default: 10,
    min: 3,
    max: 32,
  },
  {
    key: "entity-broadcast-range-percentage",
    label: "Entity broadcast range",
    description: "How far entities are visible, as a percentage of the default.",
    group: "Performance",
    type: "integer",
    default: 100,
    min: 10,
    max: 1000,
  },
  {
    key: "max-tick-time",
    label: "Max tick time (ms)",
    description: "Watchdog kills the server if a tick takes longer than this. -1 disables it.",
    group: "Performance",
    type: "integer",
    default: 60000,
    min: -1,
    max: 600000,
  },
  {
    key: "network-compression-threshold",
    label: "Compression threshold",
    description: "Packets larger than this many bytes are compressed. -1 disables compression.",
    group: "Performance",
    type: "integer",
    default: 256,
    min: -1,
    max: 65535,
  },

  // --- Security ------------------------------------------------------------
  {
    key: "enable-command-block",
    label: "Command blocks",
    description: "Allow command blocks to run.",
    group: "Security",
    type: "boolean",
    default: false,
  },
  {
    key: "enable-query",
    label: "Query protocol",
    description: "Expose the GameSpy query port. Leave off unless a tool needs it.",
    group: "Security",
    type: "boolean",
    default: false,
  },
  {
    key: "enable-rcon",
    label: "RCON",
    description:
      "Remote console the panel uses for player management and TPS. Managed by the panel with a random 64-character password.",
    group: "Security",
    type: "boolean",
    default: false,
    managed: true,
  },
  {
    key: "enable-status",
    label: "Show in server list",
    description: "Respond to server-list pings.",
    group: "Security",
    type: "boolean",
    default: true,
  },
  {
    key: "hide-online-players",
    label: "Hide online players",
    description: "Do not list player names in the server-list ping.",
    group: "Security",
    type: "boolean",
    default: false,
  },
  {
    key: "op-permission-level",
    label: "Operator permission level",
    description: "Default level granted by /op (1-4).",
    group: "Security",
    type: "integer",
    default: 4,
    min: 1,
    max: 4,
  },
  {
    key: "player-idle-timeout",
    label: "Idle timeout (min)",
    description: "Kick players idle for this many minutes. 0 disables it.",
    group: "Security",
    type: "integer",
    default: 0,
    min: 0,
    max: 1440,
  },
  {
    key: "allow-flight",
    label: "Allow flight",
    description: "Do not kick survival players detected flying. Needed by some mods.",
    group: "Security",
    type: "boolean",
    default: false,
  },
  {
    key: "enforce-secure-profile",
    label: "Enforce secure profile",
    description: "Require chat signed with Mojang-issued player keys.",
    group: "Authentication",
    type: "boolean",
    default: true,
  },
];

export const PROPERTY_GROUPS = [
  "Authentication",
  "General",
  "World",
  "Performance",
  "Security",
] as const;

/**
 * Every server.properties key that involves Microsoft/Mojang authentication.
 * Offline mode turns all of them off so players without an account can join
 * and chat.
 */
export const AUTH_PROPERTY_KEYS = ["online-mode", "enforce-secure-profile"] as const;

export function authProperties(onlineMode: boolean): Record<string, PropertyValue> {
  return Object.fromEntries(AUTH_PROPERTY_KEYS.map((k) => [k, onlineMode]));
}

export interface RconSettings {
  port: number;
  password: string;
}

/**
 * RCON keys the panel writes before every start. Vanilla has no RCON bind
 * address (it follows server-ip), so the protection is the random password;
 * command output is never broadcast to ops.
 */
export function rconProperties(rcon: RconSettings): Record<string, PropertyValue> {
  return {
    "enable-rcon": true,
    "rcon.port": rcon.port,
    "rcon.password": rcon.password,
    "broadcast-rcon-to-ops": false,
  };
}

/** Never sent to the browser. */
export const SECRET_PROPERTY_KEYS = new Set(["rcon.password"]);

const specByKey = new Map(PROPERTY_SPECS.map((s) => [s.key, s]));

export function propertySpec(key: string): PropertySpec | undefined {
  return specByKey.get(key);
}

/** Parse a .properties file. Comments and blank lines are kept as raw entries. */
export interface ParsedProperties {
  /** Ordered lines: either a key/value pair or a raw comment/blank line. */
  lines: Array<{ key: string; value: string } | { raw: string }>;
}

export function parseProperties(text: string): ParsedProperties {
  const lines: ParsedProperties["lines"] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (
      line.trim() === "" ||
      line.trimStart().startsWith("#") ||
      line.trimStart().startsWith("!")
    ) {
      lines.push({ raw: line });
      continue;
    }
    const idx = line.search(/[=:]/);
    if (idx === -1) {
      lines.push({ key: line.trim(), value: "" });
      continue;
    }
    lines.push({
      key: line.slice(0, idx).trim(),
      value: unescapeValue(line.slice(idx + 1).trim()),
    });
  }
  // Drop a trailing empty raw line produced by a final newline.
  const last = lines[lines.length - 1];
  if (last && "raw" in last && last.raw === "") lines.pop();
  return { lines };
}

export function propertiesToMap(parsed: ParsedProperties): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of parsed.lines) if ("key" in l) m.set(l.key, l.value);
  return m;
}

/** Apply values, preserving order and comments; new keys are appended. */
export function applyProperties(
  parsed: ParsedProperties,
  values: Record<string, PropertyValue>,
): ParsedProperties {
  const pending = new Map(Object.entries(values).map(([k, v]) => [k, formatValue(v)]));
  const lines = parsed.lines.map((l) => {
    if ("key" in l && pending.has(l.key)) {
      const value = pending.get(l.key) as string;
      pending.delete(l.key);
      return { key: l.key, value };
    }
    return l;
  });
  for (const [key, value] of pending) lines.push({ key, value });
  return { lines };
}

export function serializeProperties(parsed: ParsedProperties): string {
  return `${parsed.lines.map((l) => ("raw" in l ? l.raw : `${l.key}=${escapeValue(l.value)}`)).join("\n")}\n`;
}

/** Coerce a raw string into the spec's type. Unknown keys stay strings. */
export function coerceValue(key: string, raw: string): PropertyValue {
  const spec = specByKey.get(key);
  if (!spec) return raw;
  switch (spec.type) {
    case "boolean":
      return raw.toLowerCase() === "true";
    case "integer": {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : (spec.default as number);
    }
    default:
      return raw;
  }
}

export function formatValue(v: PropertyValue): string {
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

/** Validate a proposed set of values against the spec. Returns error messages by key. */
export function validateValues(values: Record<string, PropertyValue>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = specByKey.get(key);
    if (!spec) continue;
    if (spec.managed) {
      errors[key] = "This setting is managed by the panel.";
      continue;
    }
    switch (spec.type) {
      case "boolean":
        if (typeof value !== "boolean") errors[key] = "Must be true or false.";
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value))
          errors[key] = "Must be a whole number.";
        else if (spec.min !== undefined && value < spec.min)
          errors[key] = `Must be at least ${spec.min}.`;
        else if (spec.max !== undefined && value > spec.max)
          errors[key] = `Must be at most ${spec.max}.`;
        break;
      case "enum":
        if (typeof value !== "string" || !spec.options?.includes(value))
          errors[key] = "Not a valid option.";
        break;
      case "string":
        if (typeof value !== "string") errors[key] = "Must be text.";
        else if (/[\r\n]/.test(value)) errors[key] = "Must be a single line.";
        break;
    }
  }
  return errors;
}

/** Sensible defaults the panel writes for a brand-new server. */
export function defaultPropertiesText(opts: {
  port: number;
  motd: string;
  onlineMode?: boolean;
}): string {
  const values: Record<string, PropertyValue> = {
    "server-port": opts.port,
    motd: opts.motd,
    ...authProperties(opts.onlineMode ?? true),
    "enable-query": false,
    "enable-rcon": false,
    "enable-command-block": false,
    "view-distance": 10,
    "simulation-distance": 10,
    "max-players": 20,
  };
  const header = {
    raw: "#Minecraft server properties (managed by cubehold; comments and unknown keys are preserved)",
  };
  return serializeProperties(applyProperties({ lines: [header] }, values));
}

function escapeValue(v: string): string {
  // Java .properties escapes: backslash, and leading spaces; MOTD colour codes use §.
  return v.replace(/\\/g, "\\\\").replace(/^ /, "\\ ");
}

function unescapeValue(v: string): string {
  return v
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\(.)/g, "$1");
}
