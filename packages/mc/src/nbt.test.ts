import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type NbtCompound, parseDataReply, parseNbt, parseSnbt, uuidFromInts } from "./nbt.js";
import {
  countAdvancements,
  itemView,
  maxDurability,
  normalizePlayer,
  summarizeStats,
  textToPlain,
} from "./player-data.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Build binary NBT by hand: enough tag types to exercise the reader. */
function nbtBytes(): Buffer {
  const parts: Buffer[] = [];
  const u8 = (n: number) => parts.push(Buffer.from([n]));
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    parts.push(len, b);
  };
  const int = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    parts.push(b);
  };
  const float = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(n);
    parts.push(b);
  };
  u8(10); // root compound
  str("");
  u8(5); // float Health
  str("Health");
  float(17.5);
  u8(3); // int XpLevel
  str("XpLevel");
  int(27);
  u8(8); // string Dimension
  str("Dimension");
  str("minecraft:the_nether");
  u8(11); // int array UUID
  str("UUID");
  int(4);
  for (const n of [-1583368385, -1133625474, -1928419167, 1072812400]) int(n);
  u8(9); // list Inventory of compounds
  str("Inventory");
  u8(10);
  int(1);
  u8(1); // byte Slot
  str("Slot");
  u8(100); // 100 = feet in the old layout
  u8(8);
  str("id");
  str("minecraft:diamond_boots");
  u8(3);
  str("count");
  int(1);
  u8(0); // end of item
  u8(0); // end of root
  return Buffer.concat(parts);
}

describe("binary NBT", () => {
  it("reads a hand-built player", () => {
    const root = parseNbt(nbtBytes());
    expect(root.Health).toBeCloseTo(17.5);
    expect(root.XpLevel).toBe(27);
    expect(root.Dimension).toBe("minecraft:the_nether");
    const p = normalizePlayer(root);
    // -1583368385 as unsigned is 0xa19fb73f
    expect(p.uuid).toBe("a19fb73f-bc6e-3f7e-8d0e-a8a13ff1d170");
    expect(p.inventory.armor.feet?.id).toBe("minecraft:diamond_boots");
    expect(p.inventory.armor.feet?.maxDamage).toBe(429);
  });

  const fixture = path.join(here, "__fixtures__", "player-1.21.11.dat");
  it.skipIf(!fs.existsSync(fixture))("reads a real 1.21.11 player file", () => {
    const p = normalizePlayer(parseNbt(gunzipSync(fs.readFileSync(fixture))));
    expect(p.uuid).toBe("a2cfb83f-bc69-387e-8d07-c8a5c0f3cd70");
    expect(p.xpLevel).toBe(27);
    expect(p.inventory.hotbar[0]).toMatchObject({
      id: "minecraft:diamond_sword",
      enchantments: [
        { id: "minecraft:sharpness", level: 5 },
        { id: "minecraft:unbreaking", level: 3 },
      ],
    });
    expect(p.inventory.armor).toMatchObject({
      head: { id: "minecraft:diamond_helmet" },
      chest: { id: "minecraft:iron_chestplate", damage: 100, maxDamage: 240 },
      legs: { id: "minecraft:leather_leggings", color: 0xff0000 },
      feet: { id: "minecraft:netherite_boots" },
    });
    expect(p.inventory.offhand?.id).toBe("minecraft:shield");
    expect(p.enderChest[0]).toMatchObject({ id: "minecraft:diamond_block", count: 64 });
    expect(p.enderChest[13]?.id).toBe("minecraft:totem_of_undying");
    const all = [...p.inventory.hotbar, ...p.inventory.main].filter(Boolean);
    expect(all.find((i) => i?.id === "minecraft:name_tag")?.customName).toBe("Bob");
    expect(all.find((i) => i?.id === "minecraft:enchanted_book")?.enchantments).toEqual([
      { id: "minecraft:mending", level: 1 },
    ]);
  });
});

describe("SNBT", () => {
  it("parses the forms /data get prints", () => {
    const v = parseSnbt(
      `{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:enchantments": {"minecraft:sharpness": 5}, "minecraft:custom_name": 'It\\'s "sharp"'}, Pos: [3.5d, 152.0d, -9.5d], UUID: [I; 1, 2, 3, 4], flag: true, empty: [], trailing: [1, 2,]}`,
    ) as NbtCompound;
    expect(v.Slot).toBe(0);
    expect(v.Pos).toEqual([3.5, 152, -9.5]);
    expect(v.UUID).toEqual([1, 2, 3, 4]);
    expect(v.flag).toBe(true);
    expect(v.empty).toEqual([]);
    expect(v.trailing).toEqual([1, 2]);
    expect(itemView(v)).toMatchObject({
      customName: 'It\'s "sharp"',
      enchantments: [{ id: "minecraft:sharpness", level: 5 }],
    });
  });

  it("reads small /data get replies and refuses shortened ones", () => {
    expect(parseDataReply("BotAlex has the following entity data: 16.499998f")).toBeCloseTo(
      16.5,
      3,
    );
    expect(parseDataReply("BotAlex has the following entity data: [3.5d, 152.0d, 9.5d]")).toEqual([
      3.5, 152, 9.5,
    ]);
    expect(
      parseDataReply(
        'BotAlex has the following entity data: {pos: [I; 1, 64, -3], dimension: "minecraft:overworld"}',
      ),
    ).toEqual({ pos: [1, 64, -3], dimension: "minecraft:overworld" });
    expect(
      parseDataReply(
        'BotAlex has the following entity data: [{Slot: 0b, id: "minecraft:x", count...',
      ),
    ).toBeUndefined();
    expect(parseDataReply("Found no elements matching respawn")).toBeUndefined();
  });

  it("converts int-array UUIDs", () => {
    expect(uuidFromInts([0, 0, 0, 1])).toBe("00000000-0000-0000-0000-000000000001");
    expect(uuidFromInts([-1, -1, -1, -1])).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });
});

describe("player data", () => {
  it("handles the pre-1.20.5 item format and old armor slots", () => {
    const p = normalizePlayer({
      Inventory: [
        { Slot: 103, id: "minecraft:golden_helmet", Count: 1, tag: { Damage: 10 } },
        { Slot: -106, id: "minecraft:torch", Count: 32 },
        {
          Slot: 9,
          id: "minecraft:bow",
          Count: 1,
          tag: {
            Enchantments: [{ id: "minecraft:power", lvl: 4 }],
            display: { Name: '{"text":"Longshot"}' },
          },
        },
      ],
      SpawnX: 10,
      SpawnY: 70,
      SpawnZ: -4,
      SpawnDimension: "minecraft:overworld",
      playerGameType: 1,
    });
    expect(p.inventory.armor.head).toMatchObject({
      id: "minecraft:golden_helmet",
      damage: 10,
      maxDamage: 77,
    });
    expect(p.inventory.offhand).toMatchObject({ id: "minecraft:torch", count: 32 });
    expect(p.inventory.main[0]).toMatchObject({
      customName: "Longshot",
      enchantments: [{ id: "minecraft:power", level: 4 }],
    });
    expect(p.respawn).toEqual({ x: 10, y: 70, z: -4, dimension: "minecraft:overworld" });
    expect(p.gameMode).toBe("creative");
  });

  it("uses the 1.21.5 equipment compound and respawn record", () => {
    const p = normalizePlayer({
      equipment: {
        head: { id: "minecraft:turtle_helmet", count: 1 },
        offhand: { id: "minecraft:shield", count: 1 },
      },
      respawn: { pos: [5, 64, 5], dimension: "minecraft:the_nether" },
      LastDeathLocation: { pos: [1, 2, 3], dimension: "minecraft:the_end" },
      attributes: [
        {
          id: "minecraft:max_health",
          base: 20,
          modifiers: [{ amount: 4, operation: "add_value" }],
        },
      ],
    });
    expect(p.inventory.armor.head?.maxDamage).toBe(275);
    expect(p.inventory.offhand?.id).toBe("minecraft:shield");
    expect(p.respawn?.dimension).toBe("minecraft:the_nether");
    expect(p.lastDeath).toEqual({ x: 1, y: 2, z: 3, dimension: "minecraft:the_end" });
    expect(p.maxHealth).toBe(24);
  });

  it("summarises statistics and advancements", () => {
    const s = summarizeStats({
      stats: {
        "minecraft:custom": {
          "minecraft:play_time": 72000,
          "minecraft:deaths": 3,
          "minecraft:walk_one_cm": 150000,
          "minecraft:sprint_one_cm": 50000,
          "minecraft:fall_one_cm": 99999,
          "minecraft:damage_taken": 205,
          "minecraft:leave_game": 7,
        },
        "minecraft:mined": { "minecraft:stone": 120, "minecraft:dirt": 30 },
        "minecraft:killed_by": { "minecraft:creeper": 2, "minecraft:zombie": 1 },
      },
    });
    expect(s).toMatchObject({
      playTimeMs: 3_600_000,
      deaths: 3,
      distanceBlocks: 2000,
      damageTaken: 21,
      blocksMined: 150,
      timesLeft: 7,
      mostMined: { id: "minecraft:stone", count: 120 },
      killedBy: { id: "minecraft:creeper", count: 2 },
    });
    expect(
      countAdvancements({
        "minecraft:story/mine_stone": { done: true },
        "minecraft:recipes/misc/torch": { done: true },
        "minecraft:story/smelt_iron": { done: false },
        DataVersion: 4000,
      }),
    ).toBe(1);
  });

  it("knows vanilla durability and reads chat components", () => {
    expect(maxDurability("minecraft:netherite_pickaxe")).toBe(2031);
    expect(maxDurability("minecraft:elytra")).toBe(432);
    expect(maxDurability("minecraft:stone")).toBeNull();
    expect(textToPlain('{"text":"A","extra":[{"text":"B"}]}')).toBe("AB");
    expect(textToPlain({ text: "C", extra: ["D"] })).toBe("CD");
    expect(textToPlain('"quoted"')).toBe("quoted");
  });
});
