import type {
  GameMode,
  ItemView,
  Location,
  PlayerInventoryView,
  PlayerStatsView,
} from "@cubehold/shared";
import type { NbtCompound, NbtValue } from "./nbt.js";
import { uuidFromInts } from "./nbt.js";

/**
 * Turn a player's NBT (from /data get entity or playerdata/<uuid>.dat) into
 * plain fields. Handles the item formats before and after 1.20.5 (tag vs
 * components) and armor stored as slots 100-103 before 1.21.5 vs the
 * `equipment` compound after.
 */

const isObj = (v: NbtValue | undefined): v is NbtCompound =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: NbtValue | undefined): number | null =>
  typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : null;
const str = (v: NbtValue | undefined): string | null => (typeof v === "string" ? v : null);
const arr = (v: NbtValue | undefined): NbtValue[] => (Array.isArray(v) ? v : []);
const withNs = (id: string) => (id.includes(":") ? id : `minecraft:${id}`);

const GAME_MODES: GameMode[] = ["survival", "creative", "adventure", "spectator"];
const OLD_DIMENSIONS: Record<number, string> = {
  0: "minecraft:overworld",
  [-1]: "minecraft:the_nether",
  1: "minecraft:the_end",
};

export interface PlayerState {
  uuid: string | null;
  /** Paper stores the last name the player used. */
  lastKnownName: string | null;
  gameMode: GameMode | null;
  health: number | null;
  maxHealth: number;
  absorption: number;
  food: number | null;
  saturation: number | null;
  xpLevel: number | null;
  xpProgress: number | null;
  xpTotal: number | null;
  position: Location | null;
  respawn: Location | null;
  lastDeath: Location | null;
  inventory: PlayerInventoryView;
  enderChest: Array<ItemView | null>;
}

export function normalizePlayer(root: NbtCompound): PlayerState {
  const uuidInts = arr(root.UUID).filter((n): n is number => typeof n === "number");
  const bukkit = isObj(root.bukkit) ? root.bukkit : null;
  return {
    uuid: uuidInts.length === 4 ? uuidFromInts(uuidInts) : null,
    lastKnownName: str(bukkit?.lastKnownName),
    gameMode: GAME_MODES[num(root.playerGameType) ?? -1] ?? null,
    health: num(root.Health),
    maxHealth: maxHealth(root),
    absorption: num(root.AbsorptionAmount) ?? 0,
    food: num(root.foodLevel),
    saturation: num(root.foodSaturationLevel),
    xpLevel: num(root.XpLevel),
    xpProgress: num(root.XpP),
    xpTotal: num(root.XpTotal),
    position: position(root),
    respawn: respawn(root),
    lastDeath: blockLocation(root.LastDeathLocation),
    inventory: inventory(root),
    enderChest: slots(arr(root.EnderItems), 27, (s) => (s >= 0 && s < 27 ? s : null)),
  };
}

function dimensionOf(v: NbtValue | undefined): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return OLD_DIMENSIONS[v] ?? "minecraft:overworld";
  return "minecraft:overworld";
}

function position(root: NbtCompound): Location | null {
  const pos = arr(root.Pos).map((n) => num(n));
  if (pos.length !== 3 || pos.some((n) => n === null)) return null;
  const [x, y, z] = pos as number[];
  return { x: x as number, y: y as number, z: z as number, dimension: dimensionOf(root.Dimension) };
}

/** { pos: [I; x, y, z], dimension } as used by respawn and LastDeathLocation. */
function blockLocation(v: NbtValue | undefined): Location | null {
  if (!isObj(v)) return null;
  const pos = arr(v.pos).map((n) => num(n));
  if (pos.length !== 3 || pos.some((n) => n === null)) return null;
  const [x, y, z] = pos as number[];
  return { x: x as number, y: y as number, z: z as number, dimension: dimensionOf(v.dimension) };
}

function respawn(root: NbtCompound): Location | null {
  const modern = blockLocation(root.respawn);
  if (modern) return modern;
  const x = num(root.SpawnX);
  const y = num(root.SpawnY);
  const z = num(root.SpawnZ);
  if (x === null || y === null || z === null) return null;
  return { x, y, z, dimension: dimensionOf(root.SpawnDimension) };
}

function maxHealth(root: NbtCompound): number {
  const attrs = [...arr(root.attributes), ...arr(root.Attributes)].filter(isObj);
  const a = attrs.find((x) => /max_health|maxHealth/.test(str(x.id) ?? str(x.Name) ?? ""));
  if (!a) return 20;
  let value = num(a.base) ?? num(a.Base) ?? 20;
  for (const m of [...arr(a.modifiers), ...arr(a.Modifiers)].filter(isObj)) {
    const op = m.operation ?? m.Operation;
    if (op === "add_value" || op === 0) value += num(m.amount) ?? num(m.Amount) ?? 0;
  }
  return Math.max(1, value);
}

function inventory(root: NbtCompound): PlayerInventoryView {
  const items = arr(root.Inventory).filter(isObj);
  const bySlot = new Map<number, ItemView>();
  for (const it of items) {
    const slot = num(it.Slot);
    const view = itemView(it);
    if (slot !== null && view) bySlot.set(slot, view);
  }
  const eq = isObj(root.equipment) ? root.equipment : {};
  const equip = (key: string, slot: number) =>
    (isObj(eq[key]) ? itemView(eq[key] as NbtCompound) : null) ?? bySlot.get(slot) ?? null;
  return {
    hotbar: Array.from({ length: 9 }, (_, i) => bySlot.get(i) ?? null),
    main: Array.from({ length: 27 }, (_, i) => bySlot.get(9 + i) ?? null),
    armor: {
      head: equip("head", 103),
      chest: equip("chest", 102),
      legs: equip("legs", 101),
      feet: equip("feet", 100),
    },
    offhand: equip("offhand", -106),
    selected: Math.min(8, Math.max(0, num(root.SelectedItemSlot) ?? 0)),
  };
}

function slots(
  items: NbtValue[],
  size: number,
  map: (slot: number) => number | null,
): Array<ItemView | null> {
  const out: Array<ItemView | null> = Array.from({ length: size }, () => null);
  for (const it of items.filter(isObj)) {
    const slot = map(num(it.Slot) ?? -1);
    if (slot !== null) out[slot] = itemView(it);
  }
  return out;
}

export function itemView(stack: NbtCompound): ItemView | null {
  const rawId = str(stack.id);
  if (!rawId || rawId === "minecraft:air" || rawId === "air") return null;
  const id = withNs(rawId);
  const components = isObj(stack.components) ? stack.components : {};
  const tag = isObj(stack.tag) ? stack.tag : {};
  const display = isObj(tag.display) ? tag.display : {};
  const potion = isObj(components["minecraft:potion_contents"])
    ? (components["minecraft:potion_contents"] as NbtCompound)
    : {};
  const dyed = components["minecraft:dyed_color"];
  const customName = components["minecraft:custom_name"] ?? display.Name;
  const damage = num(components["minecraft:damage"]) ?? num(tag.Damage);
  return {
    id,
    count: num(stack.count) ?? num(stack.Count) ?? 1,
    customName: customName === undefined ? null : textToPlain(customName) || null,
    enchantments: [
      ...enchantments(components["minecraft:enchantments"]),
      ...enchantments(components["minecraft:stored_enchantments"]),
      ...legacyEnchantments(tag.Enchantments),
      ...legacyEnchantments(tag.StoredEnchantments),
    ],
    damage: damage && damage > 0 ? damage : null,
    maxDamage: num(components["minecraft:max_damage"]) ?? maxDurability(id),
    lore: [...arr(components["minecraft:lore"]), ...arr(display.Lore)]
      .map(textToPlain)
      .filter(Boolean),
    color:
      num(dyed) ??
      (isObj(dyed) ? num(dyed.rgb) : null) ??
      num(display.color) ??
      num(potion.custom_color) ??
      num(tag.CustomPotionColor),
  };
}

/** 1.20.5-1.21.4: {levels: {id: lvl}}; 1.21.5+: {id: lvl}. */
function enchantments(v: NbtValue | undefined): Array<{ id: string; level: number }> {
  if (!isObj(v)) return [];
  const map = isObj(v.levels) ? v.levels : v;
  return Object.entries(map)
    .filter(([k, lvl]) => k !== "show_in_tooltip" && typeof lvl === "number")
    .map(([k, lvl]) => ({ id: withNs(k), level: lvl as number }));
}

function legacyEnchantments(v: NbtValue | undefined): Array<{ id: string; level: number }> {
  return arr(v)
    .filter(isObj)
    .flatMap((e) => {
      const id = str(e.id);
      const lvl = num(e.lvl);
      return id && lvl !== null ? [{ id: withNs(id), level: lvl }] : [];
    });
}

/**
 * Plain text from a chat component: a JSON string (up to 1.21.4), an NBT
 * compound or list (1.21.5+), or a bare string.
 */
export function textToPlain(v: NbtValue | unknown): string {
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
      try {
        return textToPlain(JSON.parse(t) as unknown);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(textToPlain).join("");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const own =
      typeof o.text === "string"
        ? o.text
        : typeof o.translate === "string"
          ? ((o.fallback as string) ?? "")
          : "";
    return own + (Array.isArray(o.extra) ? o.extra.map(textToPlain).join("") : "");
  }
  return v === undefined || v === null ? "" : String(v);
}

// --- durability ------------------------------------------------------------------

const TOOL_TIERS: Record<string, number> = {
  wooden: 59,
  stone: 131,
  copper: 190,
  iron: 250,
  golden: 32,
  diamond: 1561,
  netherite: 2031,
};
const ARMOR: Record<string, [number, number, number, number]> = {
  // helmet, chestplate, leggings, boots
  leather: [55, 80, 75, 65],
  chainmail: [165, 240, 225, 195],
  copper: [121, 176, 165, 143],
  iron: [165, 240, 225, 195],
  golden: [77, 112, 105, 91],
  diamond: [363, 528, 495, 429],
  netherite: [407, 592, 555, 481],
};
const SINGLE: Record<string, number> = {
  turtle_helmet: 275,
  bow: 384,
  crossbow: 465,
  trident: 250,
  shield: 336,
  fishing_rod: 64,
  shears: 238,
  flint_and_steel: 64,
  elytra: 432,
  carrot_on_a_stick: 25,
  warped_fungus_on_a_stick: 100,
  mace: 500,
  brush: 64,
};

/** Durability of vanilla tools and armor; null for everything else. */
export function maxDurability(id: string): number | null {
  const name = id.replace(/^minecraft:/, "");
  if (name in SINGLE) return SINGLE[name] as number;
  const tool = /^(\w+?)_(sword|pickaxe|axe|shovel|hoe)$/.exec(name);
  if (tool) return TOOL_TIERS[tool[1] as string] ?? null;
  const armor = /^(\w+?)_(helmet|chestplate|leggings|boots)$/.exec(name);
  if (armor) {
    const set = ARMOR[armor[1] as string];
    const i = ["helmet", "chestplate", "leggings", "boots"].indexOf(armor[2] as string);
    return set ? (set[i] ?? null) : null;
  }
  return null;
}

// --- statistics ------------------------------------------------------------------

type StatMap = Record<string, number>;

function top(map: StatMap | undefined): { id: string; count: number } | null {
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of Object.entries(map ?? {})) {
    if (typeof count === "number" && (!best || count > best.count)) best = { id, count };
  }
  return best;
}

const sum = (map: StatMap | undefined) =>
  Object.values(map ?? {}).reduce((n, v) => n + (typeof v === "number" ? v : 0), 0);

/**
 * Folders (relative to the server) holding per-player files. Minecraft 26.1
 * moved them under the world's players/ folder: playerdata -> players/data,
 * stats -> players/stats, advancements -> players/advancements.
 */
export function playerFileDirs(
  level: string,
  layout: "players" | "legacy",
): { data: string; stats: string; advancements: string } {
  return layout === "players"
    ? {
        data: `${level}/players/data`,
        stats: `${level}/players/stats`,
        advancements: `${level}/players/advancements`,
      }
    : {
        data: `${level}/playerdata`,
        stats: `${level}/stats`,
        advancements: `${level}/advancements`,
      };
}

/** Year-numbered versions (26.1 and later) use the players/ layout for new worlds. */
export function usesPlayersFolder(mcVersion: string): boolean {
  const m = /^(\d+)\.\d+/.exec(mcVersion);
  return m ? Number(m[1]) >= 26 : false;
}

/** Summarise world/stats/<uuid>.json, which the game keeps for every player. */
export function summarizeStats(json: unknown): PlayerStatsView | null {
  const stats = (json as { stats?: Record<string, StatMap> })?.stats;
  if (!stats) return null;
  const c = stats["minecraft:custom"] ?? {};
  const g = (k: string) => c[`minecraft:${k}`] ?? 0;
  const cm = Object.entries(c)
    .filter(([k]) => k.endsWith("_one_cm") && !k.includes("fall"))
    .reduce((n, [, v]) => n + (v ?? 0), 0);
  const playTicks = c["minecraft:play_time"] ?? c["minecraft:play_one_minute"] ?? 0;
  return {
    playTimeMs: playTicks * 50,
    deaths: g("deaths"),
    mobKills: g("mob_kills"),
    playerKills: g("player_kills"),
    distanceBlocks: Math.round(cm / 100),
    jumps: g("jump"),
    // Stored in tenths of a health point.
    damageDealt: Math.round(g("damage_dealt") / 10),
    damageTaken: Math.round(g("damage_taken") / 10),
    blocksMined: sum(stats["minecraft:mined"]),
    itemsCrafted: sum(stats["minecraft:crafted"]),
    fishCaught: g("fish_caught"),
    animalsBred: g("animals_bred"),
    timesLeft: g("leave_game"),
    timeSinceDeathMs: g("deaths") > 0 ? g("time_since_death") * 50 : null,
    mostMined: top(stats["minecraft:mined"]),
    mostKilled: top(stats["minecraft:killed"]),
    killedBy: top(stats["minecraft:killed_by"]),
  };
}

/** Completed advancements, not counting recipe unlocks. */
export function countAdvancements(json: unknown): number {
  if (!json || typeof json !== "object") return 0;
  return Object.entries(json as Record<string, { done?: boolean }>).filter(
    ([k, v]) => !k.includes(":recipes/") && v && typeof v === "object" && v.done === true,
  ).length;
}
