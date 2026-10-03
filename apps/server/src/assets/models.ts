import type { FacePart, GuiSprite, GuiTextures, ItemIcon } from "@cubehold/shared";

/**
 * Work out how to draw an item the way the game's inventory does, from the
 * client's own model files: flat sprites for items, a shaded cube for
 * blocks, and hand-built boxes for the few items the game draws with code
 * (chests, shulker boxes, mob heads).
 */

/** Read access to one version's extracted assets (paths relative to assets/minecraft/). */
export interface AssetReader {
  json(rel: string): unknown | null;
  /** Pixel size of textures/<texture>.png, or null when it does not exist. */
  textureSize(texture: string): [number, number] | null;
}

interface ModelJson {
  parent?: string;
  textures?: Record<string, string>;
  elements?: Element[];
}

interface Element {
  from: [number, number, number];
  to: [number, number, number];
  faces?: Partial<
    Record<
      Direction,
      { texture: string; uv?: [number, number, number, number]; tintindex?: number }
    >
  >;
}

type Direction = "up" | "down" | "north" | "south" | "east" | "west";

interface Tint {
  type?: string;
  value?: number;
  default?: number;
}

interface Pick {
  model: string | null;
  tints: Tint[];
  special: { type: string; texture?: string } | null;
}

const bare = (id: string) => id.replace(/^minecraft:/, "");

/** Walk the 1.21.4+ item definition tree down to the model shown in an inventory. */
function pickModel(node: unknown, depth = 0): Pick | null {
  if (!node || typeof node !== "object" || depth > 16) return null;
  const n = node as Record<string, unknown>;
  const type = bare(String(n.type ?? ""));
  switch (type) {
    case "model":
      return {
        model: String(n.model),
        tints: Array.isArray(n.tints) ? (n.tints as Tint[]) : [],
        special: null,
      };
    case "special": {
      const m = (n.model ?? {}) as { type?: string; texture?: string };
      return {
        model: n.base ? String(n.base) : null,
        tints: [],
        special: { type: bare(String(m.type ?? "")), texture: m.texture },
      };
    }
    case "condition":
      return pickModel(n.on_false, depth + 1) ?? pickModel(n.on_true, depth + 1);
    case "select": {
      const cases = Array.isArray(n.cases)
        ? (n.cases as Array<{ when?: unknown; model?: unknown }>)
        : [];
      // Tridents and spyglasses have a separate flat model for inventories.
      if (bare(String(n.property ?? "")) === "display_context") {
        const gui = cases.find((c) => ([] as unknown[]).concat(c.when).includes("gui"));
        const picked = pickModel(gui?.model, depth + 1);
        if (picked) return picked;
      }
      return pickModel(n.fallback, depth + 1) ?? pickModel(cases[0]?.model, depth + 1);
    }
    case "range_dispatch": {
      const entries = Array.isArray(n.entries) ? (n.entries as Array<{ model?: unknown }>) : [];
      return pickModel(n.fallback, depth + 1) ?? pickModel(entries[0]?.model, depth + 1);
    }
    case "composite": {
      const models = Array.isArray(n.models) ? n.models : [];
      return pickModel(models[0], depth + 1);
    }
    default:
      return pickModel(n.fallback, depth + 1);
  }
}

interface ResolvedModel {
  textures: Record<string, string>;
  elements: Element[] | null;
  generated: boolean;
  builtinEntity: boolean;
}

function loadModel(r: AssetReader, name: string): ResolvedModel | null {
  const textures: Record<string, string> = {};
  let elements: Element[] | null = null;
  let generated = false;
  let builtinEntity = false;
  let cur: string | null = bare(name);
  let found = false;
  for (let depth = 0; cur && depth < 24; depth++) {
    if (cur === "builtin/generated") {
      generated = true;
      break;
    }
    if (cur === "builtin/entity") {
      builtinEntity = true;
      break;
    }
    const m = r.json(`models/${cur}.json`) as ModelJson | null;
    if (!m) break;
    found = true;
    for (const [k, v] of Object.entries(m.textures ?? {})) if (!(k in textures)) textures[k] = v;
    if (!elements && Array.isArray(m.elements) && m.elements.length > 0) elements = m.elements;
    cur = m.parent ? bare(m.parent) : null;
  }
  return found || generated || builtinEntity
    ? { textures, elements, generated, builtinEntity }
    : null;
}

function resolveTexture(textures: Record<string, string>, ref: string | undefined): string | null {
  let t = ref;
  for (let i = 0; t?.startsWith("#") && i < 12; i++) t = textures[t.slice(1)];
  if (!t || t.startsWith("#")) return null;
  return bare(t);
}

// Fixed inventory colours for the plants and leaves the game tints by biome.
const LEGACY_TINTS: Record<string, number> = {
  grass_block: 0x91bd59,
  short_grass: 0x91bd59,
  grass: 0x91bd59,
  tall_grass: 0x91bd59,
  fern: 0x91bd59,
  large_fern: 0x91bd59,
  oak_leaves: 0x48b518,
  jungle_leaves: 0x48b518,
  acacia_leaves: 0x48b518,
  dark_oak_leaves: 0x48b518,
  vine: 0x48b518,
  spruce_leaves: 0x619961,
  birch_leaves: 0x80a755,
  mangrove_leaves: 0x92c648,
  lily_pad: 0x208030,
};
const DYEABLE =
  /^(leather_(helmet|chestplate|leggings|boots|horse_armor)|wolf_armor|(splash_|lingering_)?potion|tipped_arrow)$/;

function tintColor(t: Tint | undefined): number | null {
  if (!t) return null;
  const type = bare(t.type ?? "");
  const v = type === "constant" ? t.value : type === "grass" ? 0x91bd59 : t.default;
  return typeof v === "number" ? v & 0xffffff : null;
}

function tintFor(id: string, pick: Pick | null, index: number | undefined): number | null {
  if (index === undefined || index < 0) return null;
  if (pick && pick.tints.length > 0) return tintColor(pick.tints[index]);
  if (index !== 0) return null;
  if (id in LEGACY_TINTS) return LEGACY_TINTS[id] as number;
  if (/^leather_/.test(id)) return 0xa06540;
  if (/potion|tipped_arrow/.test(id)) return 0xf800f8;
  return null;
}

function flatIcon(r: AssetReader, id: string, model: ResolvedModel, pick: Pick | null): ItemIcon {
  const layers: Extract<ItemIcon, { kind: "flat" }>["layers"] = [];
  for (let i = 0; i < 10; i++) {
    const tex = resolveTexture(model.textures, model.textures[`layer${i}`]);
    if (!tex) continue;
    const size = r.textureSize(tex);
    if (!size) continue;
    const tint = tintFor(id, pick, i);
    layers.push({ texture: tex, size, tint, dyeable: tint !== null && DYEABLE.test(id) });
  }
  return layers.length ? { kind: "flat", layers } : { kind: "missing" };
}

/** Faces shown in an inventory: the top, the north face on the left, the east face on the right. */
function blockIcon(r: AssetReader, id: string, model: ResolvedModel, pick: Pick | null): ItemIcon {
  const els = model.elements ?? [];
  const volume = (e: Element) =>
    Math.abs((e.to[0] - e.from[0]) * (e.to[1] - e.from[1]) * (e.to[2] - e.from[2]));
  const el = [...els].sort((a, b) => volume(b) - volume(a))[0];
  if (!el) return { kind: "missing" };
  const [fx, fy, fz] = el.from;
  const [tx, ty, tz] = el.to;
  const face = (dir: Direction, fallbackUv: [number, number, number, number]): FacePart[] => {
    const f = el.faces?.[dir] ?? el.faces?.south ?? el.faces?.west;
    if (!f) return [];
    const tex = resolveTexture(model.textures, f.texture);
    const size = tex ? r.textureSize(tex) : null;
    if (!tex || !size) return [];
    const scale = size[0] / 16; // uv units are 1/16 of the (square) frame
    const [u0, v0, u1, v1] = f.uv ?? fallbackUv;
    return [
      {
        texture: tex,
        size,
        uv: [u0 * scale, v0 * scale, u1 * scale, v1 * scale],
        x: [0, 1],
        y: [0, 1],
        tint: tintFor(id, pick, f.tintindex),
      },
    ];
  };
  const top = face("up", [fx, fz, tx, tz]);
  const left = face("north", [16 - tx, 16 - ty, 16 - fx, 16 - fy]);
  const right = face("east", [16 - tz, 16 - ty, 16 - fz, 16 - fy]);
  if (!top.length && !left.length && !right.length) return { kind: "missing" };
  return {
    kind: "block",
    height: Math.min(1, Math.max(0.125, (ty - fy) / 16)),
    scale: 1,
    top,
    left,
    right,
  };
}

const part = (
  texture: string,
  size: [number, number],
  uv: [number, number, number, number],
  y: [number, number] = [0, 1],
  x: [number, number] = [0, 1],
): FacePart => ({ texture, size, uv, x, y, tint: null });

/** Chests are drawn by code from a 64x64 atlas; rebuild the lid, body and latch. */
function chestIcon(r: AssetReader, textureName: string): ItemIcon | null {
  const tex = `entity/chest/${textureName}`;
  const size = r.textureSize(tex);
  if (!size) return null;
  const s = size[0] / 64;
  const uv = (a: number, b: number, c: number, d: number): [number, number, number, number] => [
    a * s,
    b * s,
    c * s,
    d * s,
  ];
  const lid = 5 / 14;
  return {
    kind: "block",
    height: 14 / 16,
    scale: 0.94,
    top: [part(tex, size, uv(14, 0, 28, 14))],
    left: [
      part(tex, size, uv(14, 14, 28, 19), [0, lid]),
      part(tex, size, uv(14, 33, 28, 43), [lid, 1]),
      part(tex, size, uv(1, 1, 3, 5), [3 / 14, 7 / 14], [6 / 14, 8 / 14]),
    ],
    right: [
      part(tex, size, uv(0, 14, 14, 19), [0, lid]),
      part(tex, size, uv(0, 33, 14, 43), [lid, 1]),
    ],
  };
}

const HEADS: Record<string, string> = {
  skeleton_skull: "entity/skeleton/skeleton",
  wither_skeleton_skull: "entity/skeleton/wither_skeleton",
  zombie_head: "entity/zombie/zombie",
  creeper_head: "entity/creeper/creeper",
  player_head: "entity/player/wide/steve",
};

/** Mob heads: the 8x8x8 head box from the mob's skin. */
function headIcon(r: AssetReader, id: string): ItemIcon | null {
  const tex = HEADS[id];
  const size = tex ? r.textureSize(tex) : null;
  if (!tex || !size) return null;
  const s = size[0] / 64;
  const uv = (a: number, b: number, c: number, d: number): [number, number, number, number] => [
    a * s,
    b * s,
    c * s,
    d * s,
  ];
  return {
    kind: "block",
    height: 1,
    scale: 0.7,
    top: [part(tex, size, uv(8, 0, 16, 8))],
    left: [part(tex, size, uv(8, 8, 16, 16))],
    right: [part(tex, size, uv(0, 8, 8, 16))],
  };
}

function cubeOf(r: AssetReader, texture: string, height = 1): ItemIcon | null {
  const size = r.textureSize(texture);
  if (!size) return null;
  const f = [part(texture, size, [0, 0, size[0], size[0]])];
  const side = [part(texture, size, [0, (1 - height) * size[0], size[0], size[0]])];
  return { kind: "block", height, scale: 1, top: f, left: side, right: side };
}

const LEGACY_CHESTS: Record<string, string> = {
  chest: "normal",
  trapped_chest: "trapped",
  ender_chest: "ender",
};

function specialIcon(
  r: AssetReader,
  id: string,
  special: { type: string; texture?: string } | null,
  model: ResolvedModel | null,
): ItemIcon | null {
  const type = special?.type ?? "";
  if (type === "chest" || id in LEGACY_CHESTS) {
    const name = special?.texture ? bare(special.texture) : (LEGACY_CHESTS[id] ?? "normal");
    return chestIcon(r, name);
  }
  if (type === "shulker_box" || /shulker_box$/.test(id)) return cubeOf(r, `block/${id}`);
  if (type === "shield" || id === "shield") {
    // The shield's front plate, 12x22 at (1,1) of its 64x64 skin.
    for (const tex of ["entity/shield_base_nopattern", "entity/shield/base_nopattern"]) {
      const size = r.textureSize(tex);
      if (!size) continue;
      const s = size[0] / 64;
      return {
        kind: "flat",
        layers: [{ texture: tex, size, tint: null, uv: [1 * s, 1 * s, 13 * s, 23 * s] }],
      };
    }
    return null;
  }
  if (type === "head" || id in HEADS) return headIcon(r, id);
  if (type === "bed" || /_bed$/.test(id)) {
    const particle = model ? resolveTexture(model.textures, model.textures.particle) : null;
    return particle ? cubeOf(r, particle, 9 / 16) : null;
  }
  return null;
}

export function resolveIcon(r: AssetReader, fullId: string): ItemIcon {
  if (!fullId.startsWith("minecraft:") && fullId.includes(":")) return { kind: "missing" };
  const id = bare(fullId);
  const def = r.json(`items/${id}.json`) as { model?: unknown } | null;
  const pick = def?.model ? pickModel(def.model) : null;
  const modelName = pick ? pick.model : `item/${id}`;
  const model = modelName ? loadModel(r, modelName) : null;

  if (pick?.special || model?.builtinEntity) {
    const icon = specialIcon(r, id, pick?.special ?? null, model);
    if (icon) return icon;
  }
  if (!model) return { kind: "missing" };
  if (model.generated) return flatIcon(r, id, model, pick);
  if (model.elements) return blockIcon(r, id, model, pick);
  return { kind: "missing" };
}

// --- GUI --------------------------------------------------------------------------

export function guiTextures(r: AssetReader): GuiTextures {
  const sprite = (
    texture: string,
    crop: [number, number, number, number] | null = null,
  ): GuiSprite | null => {
    const size = r.textureSize(texture);
    return size ? { texture, size, crop } : null;
  };
  // 1.20.2+ keeps HUD pieces as separate sprites; older versions pack them into icons.png.
  const modern = r.textureSize("gui/sprites/hud/heart/full") !== null;
  const icons = (x: number, y: number, w = 9, h = 9) => sprite("gui/icons", [x, y, w, h]);
  const slot = (name: string) =>
    sprite(`gui/sprites/container/slot/${name}`) ?? sprite(`item/empty_armor_slot_${name}`);
  return {
    inventory: sprite("gui/container/inventory", [0, 0, 176, 166]),
    chest: sprite("gui/container/generic_54", [0, 0, 176, 222]),
    heartFull: modern ? sprite("gui/sprites/hud/heart/full") : icons(52, 0),
    heartHalf: modern ? sprite("gui/sprites/hud/heart/half") : icons(61, 0),
    heartContainer: modern ? sprite("gui/sprites/hud/heart/container") : icons(16, 0),
    heartAbsorbingFull: modern ? sprite("gui/sprites/hud/heart/absorbing_full") : icons(160, 0),
    heartAbsorbingHalf: modern ? sprite("gui/sprites/hud/heart/absorbing_half") : icons(169, 0),
    foodFull: modern ? sprite("gui/sprites/hud/food_full") : icons(52, 27),
    foodHalf: modern ? sprite("gui/sprites/hud/food_half") : icons(61, 27),
    foodEmpty: modern ? sprite("gui/sprites/hud/food_empty") : icons(16, 27),
    xpBackground: modern
      ? sprite("gui/sprites/hud/experience_bar_background")
      : icons(0, 64, 182, 5),
    xpProgress: modern ? sprite("gui/sprites/hud/experience_bar_progress") : icons(0, 69, 182, 5),
    slotHelmet: slot("helmet"),
    slotChestplate: slot("chestplate"),
    slotLeggings: slot("leggings"),
    slotBoots: slot("boots"),
    slotShield: slot("shield"),
  };
}

/** English names for items, blocks, enchantments and mobs; title-cased id when unknown. */
export function displayName(lang: Record<string, string>, fullId: string): string {
  const [ns, id] = fullId.includes(":")
    ? (fullId.split(":", 2) as [string, string])
    : ["minecraft", fullId];
  for (const kind of ["item", "block", "enchantment", "entity"]) {
    const v = lang[`${kind}.${ns}.${id.replace(/\//g, ".")}`];
    if (v) return v;
  }
  return id
    .split(/[_/]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
