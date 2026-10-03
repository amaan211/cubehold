import type { GuiSprite, ItemView } from "@cubehold/shared";
import { useState } from "react";
import { createPortal } from "react-dom";
import { type ItemAssets, roman, spriteStyle, textureUrl } from "./assets";
import { ItemIcon } from "./item-icon";

/**
 * One inventory slot at GUI position (x, y) in game pixels, times `scale`.
 * Draws the item, stack count, durability bar and enchantment glint, and
 * shows a game-style tooltip on hover.
 */
export function Slot({
  item,
  assets,
  x,
  y,
  scale,
  empty,
  highlight,
}: {
  item: ItemView | null;
  assets: ItemAssets | undefined;
  x: number;
  y: number;
  scale: number;
  /** Outline shown in an empty slot (armor and shield slots). */
  empty?: GuiSprite | null;
  highlight?: boolean;
}) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const size = 16 * scale;
  const glint = item && item.enchantments.length > 0;
  const firstLayer = item && assets?.icons[item.id];
  const mask =
    glint && firstLayer?.kind === "flat" && firstLayer.layers[0]
      ? `url(${textureUrl(assets?.version ?? "", firstLayer.layers[0].texture)})`
      : undefined;
  const dmg = item?.damage && item.maxDamage ? item.damage / item.maxDamage : null;

  const label = item
    ? `${item.customName ?? assets?.names[item.id] ?? item.id}${item.count > 1 ? ` ×${item.count}` : ""}`
    : "Empty slot";
  return (
    // Hover and focus only show the tooltip; the label carries the same text for screen readers.
    <div
      className="absolute outline-none focus-visible:ring-2 focus-visible:ring-primary"
      style={{ left: x * scale, top: y * scale, width: size, height: size }}
      role="img"
      aria-label={label}
      tabIndex={item ? 0 : undefined}
      onMouseMove={(e) => item && setHover({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setHover(null)}
      onFocus={(e) => {
        if (!item) return;
        const r = e.currentTarget.getBoundingClientRect();
        setHover({ x: r.right, y: r.top + 12 });
      }}
      onBlur={() => setHover(null)}
    >
      {highlight && <div className="absolute inset-0 bg-white/25" />}
      {!item && empty && assets && (
        <div className="absolute inset-0" style={spriteStyle(assets.version, empty, scale)} />
      )}
      {item && assets && (
        <>
          <ItemIcon
            icon={assets.icons[item.id]}
            version={assets.version}
            color={item.color}
            size={size}
            label={assets.names[item.id] ?? item.id}
          />
          {glint && (
            <div
              className="mc-glint pointer-events-none absolute inset-0"
              style={
                mask
                  ? {
                      maskImage: mask,
                      WebkitMaskImage: mask,
                      maskSize: "100% 100%",
                      WebkitMaskSize: "100% 100%",
                    }
                  : { borderRadius: 2 }
              }
            />
          )}
          {dmg !== null && dmg > 0 && (
            <div
              className="absolute bg-black"
              style={{ left: 2 * scale, top: 13 * scale, width: 13 * scale, height: 2 * scale }}
            >
              <div
                style={{
                  width: `${Math.round((1 - dmg) * 13) * scale}px`,
                  height: scale,
                  background: `hsl(${Math.round((1 - dmg) * 120)} 100% 50%)`,
                }}
              />
            </div>
          )}
          {item.count > 1 && (
            <span
              className="mc-text pointer-events-none absolute right-0 bottom-0 leading-none text-white"
              style={{ fontSize: 8 * scale, right: -scale, bottom: -scale }}
            >
              {item.count}
            </span>
          )}
        </>
      )}
      {hover &&
        item &&
        createPortal(<Tooltip item={item} assets={assets} at={hover} />, document.body)}
    </div>
  );
}

function Tooltip({
  item,
  assets,
  at,
}: {
  item: ItemView;
  assets: ItemAssets | undefined;
  at: { x: number; y: number };
}) {
  const name = item.customName ?? assets?.names[item.id] ?? item.id;
  const enchanted = item.enchantments.length > 0;
  const flip = at.x > window.innerWidth - 280;
  return (
    <div
      className="mc-tooltip pointer-events-none fixed z-[100] max-w-72 px-2 py-1.5 text-sm leading-snug"
      style={{
        left: flip ? undefined : at.x + 14,
        right: flip ? window.innerWidth - at.x + 14 : undefined,
        top: at.y - 18,
      }}
    >
      <p
        className={item.customName ? "italic" : ""}
        style={{ color: enchanted ? "#55ffff" : "#ffffff" }}
      >
        {name}
      </p>
      {item.enchantments.map((e) => (
        <p key={e.id} style={{ color: "#aaaaaa" }}>
          {assets?.names[e.id] ?? e.id.replace("minecraft:", "")} {roman(e.level)}
        </p>
      ))}
      {item.lore.map((l) => (
        <p key={l} className="italic" style={{ color: "#aa00aa" }}>
          {l}
        </p>
      ))}
      {item.maxDamage !== null && (item.damage ?? 0) > 0 && (
        <p style={{ color: "#ffffff" }}>
          Durability: {item.maxDamage - (item.damage ?? 0)} / {item.maxDamage}
        </p>
      )}
      {item.count > 1 && <p style={{ color: "#aaaaaa" }}>× {item.count}</p>}
      <p style={{ color: "#555555" }}>{item.id}</p>
    </div>
  );
}
