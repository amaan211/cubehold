import type { ItemView, PlayerInventoryView } from "@cubehold/shared";
import { useEffect, useRef, useState } from "react";
import { type ItemAssets, spriteStyle } from "./assets";
import { Slot } from "./slot";

/** Largest whole-pixel scale at which a GUI `width` game pixels wide fits the container. */
export function useGuiScale(width: number, max = 4) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(2);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(Math.max(1, Math.min(max, Math.floor(el.clientWidth / width))));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, max]);
  return { ref, scale };
}

/**
 * The survival inventory screen, drawn with the game's own background:
 * armor on the left, the player in the black box, the 2x2 crafting grid
 * (empty), off-hand, three rows of storage and the hotbar.
 */
export function InventoryGui({
  inventory,
  assets,
  playerName,
}: {
  inventory: PlayerInventoryView;
  assets: ItemAssets | undefined;
  playerName: string;
}) {
  const { ref, scale } = useGuiScale(176);
  const bg = assets?.gui.inventory;
  const armor: Array<[ItemView | null, keyof NonNullable<ItemAssets["gui"]>]> = [
    [inventory.armor.head, "slotHelmet"],
    [inventory.armor.chest, "slotChestplate"],
    [inventory.armor.legs, "slotLeggings"],
    [inventory.armor.feet, "slotBoots"],
  ];
  return (
    <div ref={ref} className="w-full">
      <div
        className="relative mx-auto"
        style={
          bg && assets
            ? spriteStyle(assets.version, bg, scale)
            : {
                width: 176 * scale,
                height: 166 * scale,
                background: "#c6c6c6",
                borderRadius: 4 * scale,
              }
        }
      >
        {/* The player, where the game draws the 3D model. */}
        <img
          src={`https://mc-heads.net/body/${encodeURIComponent(playerName)}/${Math.round(64 * scale)}`}
          alt=""
          className="absolute object-contain"
          style={{
            left: 27 * scale,
            top: 9 * scale,
            width: 48 * scale,
            height: 68 * scale,
            imageRendering: "pixelated",
          }}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
        {armor.map(([item, empty], i) => (
          <Slot
            key={empty}
            item={item}
            assets={assets}
            x={8}
            y={8 + i * 18}
            scale={scale}
            empty={assets?.gui[empty] as never}
          />
        ))}
        <Slot
          item={inventory.offhand}
          assets={assets}
          x={77}
          y={62}
          scale={scale}
          empty={assets?.gui.slotShield}
        />
        {inventory.main.map((item, i) => (
          <Slot
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
            key={`m${i}`}
            item={item}
            assets={assets}
            x={8 + (i % 9) * 18}
            y={84 + Math.floor(i / 9) * 18}
            scale={scale}
          />
        ))}
        {inventory.hotbar.map((item, i) => (
          <Slot
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
            key={`h${i}`}
            item={item}
            assets={assets}
            x={8 + i * 18}
            y={142}
            scale={scale}
            highlight={i === inventory.selected}
          />
        ))}
      </div>
    </div>
  );
}

/** The ender chest screen: the top of the game's chest background, 3 rows. */
export function EnderChestGui({
  items,
  assets,
}: {
  items: Array<ItemView | null>;
  assets: ItemAssets | undefined;
}) {
  const { ref, scale } = useGuiScale(176);
  const bg = assets?.gui.chest;
  const top = bg ? { ...bg, crop: [0, 0, 176, 71] as [number, number, number, number] } : null;
  const bottom = bg ? { ...bg, crop: [0, 215, 176, 7] as [number, number, number, number] } : null;
  return (
    <div ref={ref} className="w-full">
      <div className="relative mx-auto" style={{ width: 176 * scale, height: 78 * scale }}>
        {top && bottom && assets ? (
          <>
            <div
              className="absolute top-0 left-0"
              style={spriteStyle(assets.version, top, scale)}
            />
            <div
              className="absolute left-0"
              style={{ ...spriteStyle(assets.version, bottom, scale), top: 71 * scale }}
            />
          </>
        ) : (
          <div className="absolute inset-0 rounded bg-[#c6c6c6]" />
        )}
        <span
          className="absolute font-mono leading-none"
          style={{ left: 8 * scale, top: 6 * scale, fontSize: 8 * scale, color: "#404040" }}
        >
          Ender Chest
        </span>
        {items.map((item, i) => (
          <Slot
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
            key={i}
            item={item}
            assets={assets}
            x={8 + (i % 9) * 18}
            y={18 + Math.floor(i / 9) * 18}
            scale={scale}
          />
        ))}
      </div>
    </div>
  );
}
