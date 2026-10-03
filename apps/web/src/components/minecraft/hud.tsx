import type { GuiSprite } from "@cubehold/shared";
import { type ItemAssets, spriteStyle } from "./assets";

function Icon({
  sprite,
  version,
  scale,
}: {
  sprite: GuiSprite | null | undefined;
  version: string;
  scale: number;
}) {
  if (!sprite)
    return <span className="inline-block" style={{ width: 9 * scale, height: 9 * scale }} />;
  return <span className="inline-block" style={spriteStyle(version, sprite, scale)} />;
}

/** Health like the game's HUD: a container per 2 health, full or half hearts, then absorption. */
export function Hearts({
  health,
  max,
  absorption,
  assets,
  scale = 2,
}: {
  health: number;
  max: number;
  absorption: number;
  assets: ItemAssets;
  scale?: number;
}) {
  const g = assets.gui;
  const hearts = Math.ceil(max / 2);
  const golden = Math.ceil(absorption / 2);
  return (
    <div
      className="flex flex-wrap"
      style={{ gap: scale }}
      role="img"
      aria-label={`${Math.round(health * 10) / 10} of ${max} health${absorption ? `, ${absorption} absorption` : ""}`}
    >
      {Array.from({ length: hearts }, (_, i) => {
        const fill = health >= i * 2 + 2 ? g.heartFull : health >= i * 2 + 1 ? g.heartHalf : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional
          <span key={i} className="relative inline-block">
            <Icon sprite={g.heartContainer} version={assets.version} scale={scale} />
            {fill && (
              <span className="absolute inset-0">
                <Icon sprite={fill} version={assets.version} scale={scale} />
              </span>
            )}
          </span>
        );
      })}
      {Array.from({ length: golden }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <span key={`a${i}`} className="relative inline-block">
          <Icon sprite={g.heartContainer} version={assets.version} scale={scale} />
          <span className="absolute inset-0">
            <Icon
              sprite={absorption >= i * 2 + 2 ? g.heartAbsorbingFull : g.heartAbsorbingHalf}
              version={assets.version}
              scale={scale}
            />
          </span>
        </span>
      ))}
    </div>
  );
}

export function Hunger({
  food,
  assets,
  scale = 2,
}: {
  food: number;
  assets: ItemAssets;
  scale?: number;
}) {
  const g = assets.gui;
  return (
    <div
      className="flex flex-wrap"
      style={{ gap: scale }}
      role="img"
      aria-label={`${food} of 20 hunger`}
    >
      {Array.from({ length: 10 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <span key={i} className="relative inline-block">
          <Icon sprite={g.foodEmpty} version={assets.version} scale={scale} />
          {food >= i * 2 + 1 && (
            <span className="absolute inset-0">
              <Icon
                sprite={food >= i * 2 + 2 ? g.foodFull : g.foodHalf}
                version={assets.version}
                scale={scale}
              />
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/** The experience bar with the level number above it, in the game's green. */
export function XpBar({
  level,
  progress,
  assets,
  width,
}: {
  level: number;
  progress: number;
  assets: ItemAssets;
  /** Pixel width to draw at; the bar keeps its 182x5 proportions. */
  width: number;
}) {
  const g = assets.gui;
  const scale = width / 182;
  const bar = (sprite: GuiSprite, clip?: number) => {
    const [cx, cy, cw, ch] = sprite.crop ?? [0, 0, sprite.size[0], sprite.size[1]];
    return (
      <div
        className="absolute top-0 left-0"
        style={{
          width: (clip ?? cw) * scale,
          height: ch * scale,
          backgroundImage: `url(/api/assets/${encodeURIComponent(assets.version)}/textures/${sprite.texture}.png)`,
          backgroundSize: `${sprite.size[0] * scale}px ${sprite.size[1] * scale}px`,
          backgroundPosition: `-${cx * scale}px -${cy * scale}px`,
          imageRendering: "pixelated",
        }}
      />
    );
  };
  return (
    <div className="flex flex-col items-center" style={{ width }}>
      <span
        className="mc-text leading-none"
        style={{
          color: "#80ff20",
          fontSize: Math.max(12, 9 * scale),
          // The game hides the number at level 0; keep the space so the bar does not jump.
          visibility: level > 0 ? "visible" : "hidden",
        }}
      >
        {level}
      </span>
      <div
        className="relative mt-1"
        style={{ width, height: 5 * scale }}
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Level ${level}, ${Math.round(progress * 100)}% to the next`}
      >
        {g.xpBackground && bar(g.xpBackground)}
        {g.xpProgress && bar(g.xpProgress, Math.round(182 * Math.min(1, Math.max(0, progress))))}
      </div>
    </div>
  );
}
