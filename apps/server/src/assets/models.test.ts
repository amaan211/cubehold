import { describe, expect, it } from "vitest";
import { type AssetReader, displayName, guiTextures, resolveIcon } from "./models.js";

/** A tiny fake of an extracted client jar. */
function reader(
  files: Record<string, unknown>,
  textures: Record<string, [number, number]>,
): AssetReader {
  return {
    json: (rel) => files[rel] ?? null,
    textureSize: (t) => textures[t] ?? null,
  };
}

const models = {
  "models/item/generated.json": { parent: "builtin/generated" },
  "models/item/diamond.json": {
    parent: "minecraft:item/generated",
    textures: { layer0: "minecraft:item/diamond" },
  },
  "models/block/block.json": {},
  "models/block/cube.json": {
    parent: "block/block",
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          up: { texture: "#up" },
          down: { texture: "#down" },
          north: { texture: "#north" },
          east: { texture: "#east" },
          south: { texture: "#south" },
          west: { texture: "#west" },
        },
      },
    ],
  },
  "models/block/cube_column.json": {
    parent: "block/cube",
    textures: {
      up: "#end",
      down: "#end",
      north: "#side",
      east: "#side",
      south: "#side",
      west: "#side",
    },
  },
  "models/block/oak_log.json": {
    parent: "minecraft:block/cube_column",
    textures: { end: "minecraft:block/oak_log_top", side: "minecraft:block/oak_log" },
  },
  "models/item/oak_log.json": { parent: "minecraft:block/oak_log" },
  "models/block/slab.json": {
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 8, 16],
        faces: { up: { texture: "#top" }, north: { texture: "#side" }, east: { texture: "#side" } },
      },
    ],
  },
  "models/item/oak_slab.json": {
    parent: "block/slab",
    textures: { top: "block/oak_planks", side: "block/oak_planks" },
  },
  "models/item/leather_boots.json": {
    parent: "item/generated",
    textures: { layer0: "item/leather_boots", layer1: "item/leather_boots_overlay" },
  },
};
const textures: Record<string, [number, number]> = {
  "item/diamond": [16, 16],
  "block/oak_log": [16, 16],
  "block/oak_log_top": [16, 16],
  "block/oak_planks": [16, 16],
  "item/leather_boots": [16, 16],
  "item/leather_boots_overlay": [16, 16],
  "entity/chest/ender": [64, 64],
  "gui/sprites/hud/heart/full": [9, 9],
  "gui/container/inventory": [256, 256],
};

describe("item icons", () => {
  it("draws items flat and blocks as cubes, walking model parents", () => {
    const r = reader(models, textures);
    expect(resolveIcon(r, "minecraft:diamond")).toEqual({
      kind: "flat",
      layers: [{ texture: "item/diamond", size: [16, 16], tint: null, dyeable: false }],
    });
    const log = resolveIcon(r, "minecraft:oak_log");
    expect(log.kind).toBe("block");
    if (log.kind === "block") {
      expect(log.top[0]?.texture).toBe("block/oak_log_top");
      expect(log.left[0]?.texture).toBe("block/oak_log");
      expect(log.height).toBe(1);
    }
    const slab = resolveIcon(r, "minecraft:oak_slab");
    expect(slab.kind === "block" && slab.height).toBe(0.5);
    // Side faces of a bottom slab show the lower half of the texture.
    expect(slab.kind === "block" && slab.left[0]?.uv).toEqual([0, 8, 16, 16]);
  });

  it("tints dyeable leather by default and knows the chest special case", () => {
    const r = reader(models, textures);
    const boots = resolveIcon(r, "minecraft:leather_boots");
    expect(boots.kind === "flat" && boots.layers[0]).toMatchObject({
      tint: 0xa06540,
      dyeable: true,
    });
    expect(boots.kind === "flat" && boots.layers[1]?.tint).toBeNull();
    // Pre-1.21.4 ender chests are "builtin/entity": rebuilt from the chest atlas.
    const withEntity = reader(
      { ...models, "models/item/ender_chest.json": { parent: "builtin/entity" } },
      textures,
    );
    const chest = resolveIcon(withEntity, "minecraft:ender_chest");
    expect(chest.kind).toBe("block");
    if (chest.kind === "block") {
      expect(chest.top[0]).toMatchObject({ texture: "entity/chest/ender", uv: [14, 0, 28, 14] });
      expect(chest.left).toHaveLength(3); // lid, body, latch
    }
  });

  it("follows 1.21.4 item definitions, including special and select nodes", () => {
    const r = reader(
      {
        ...models,
        "items/diamond.json": {
          model: { type: "minecraft:model", model: "minecraft:item/diamond" },
        },
        "items/ender_chest.json": {
          model: {
            type: "minecraft:special",
            base: "minecraft:item/ender_chest",
            model: { type: "minecraft:chest", texture: "minecraft:ender" },
          },
        },
        "items/oak_leaves.json": {
          model: {
            type: "minecraft:model",
            model: "minecraft:item/oak_log",
            tints: [{ type: "minecraft:constant", value: -12012264 }],
          },
        },
        "items/clock.json": {
          model: {
            type: "minecraft:select",
            property: "x",
            cases: [{ model: { type: "minecraft:model", model: "minecraft:item/diamond" } }],
          },
        },
      },
      textures,
    );
    expect(resolveIcon(r, "minecraft:diamond").kind).toBe("flat");
    expect(resolveIcon(r, "minecraft:ender_chest").kind).toBe("block");
    expect(resolveIcon(r, "minecraft:clock").kind).toBe("flat");
    expect(resolveIcon(r, "modded:thing")).toEqual({ kind: "missing" });
    expect(resolveIcon(r, "minecraft:nope")).toEqual({ kind: "missing" });
  });

  it("finds GUI sprites and English names", () => {
    const g = guiTextures(reader({}, textures));
    expect(g.heartFull).toEqual({
      texture: "gui/sprites/hud/heart/full",
      size: [9, 9],
      crop: null,
    });
    expect(g.inventory?.crop).toEqual([0, 0, 176, 166]);
    expect(g.foodFull).toBeNull();
    const lang = {
      "item.minecraft.diamond": "Diamond",
      "block.minecraft.oak_log": "Oak Log",
      "enchantment.minecraft.sharpness": "Sharpness",
    };
    expect(displayName(lang, "minecraft:diamond")).toBe("Diamond");
    expect(displayName(lang, "minecraft:oak_log")).toBe("Oak Log");
    expect(displayName(lang, "minecraft:sharpness")).toBe("Sharpness");
    expect(displayName(lang, "minecraft:golden_carrot")).toBe("Golden Carrot");
  });
});
