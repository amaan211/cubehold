import type { GuiSprite, GuiTextures, ItemIcon } from "@cubehold/shared";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

/** URL of a game texture served by the panel (textures/<path>.png for a version). */
export function textureUrl(version: string, texture: string): string {
  return `/api/assets/${encodeURIComponent(version)}/textures/${texture}.png`;
}

export interface ItemAssets {
  version: string;
  icons: Record<string, ItemIcon>;
  names: Record<string, string>;
  gui: GuiTextures;
}

/**
 * Icons, names and GUI textures for a set of ids. The first call for a
 * Minecraft version makes the panel fetch that version's textures (a few
 * seconds), later calls are instant.
 */
export function useItemAssets(version: string | undefined, ids: string[]) {
  const trpc = useTRPC();
  const sorted = [...new Set(ids)].sort();
  return useQuery(
    trpc.assets.icons.queryOptions(
      { mcVersion: version ?? "", ids: sorted },
      {
        enabled: Boolean(version),
        staleTime: Number.POSITIVE_INFINITY,
        placeholderData: (prev) => prev,
        select: (d): ItemAssets => ({ ...d, version: version ?? "" }),
      },
    ),
  );
}

/** Style for a GUI sprite scaled by `scale`, cropping it out of its atlas when needed. */
export function spriteStyle(
  version: string,
  sprite: GuiSprite,
  scale: number,
  width?: number,
): React.CSSProperties {
  const [cx, cy, cw, ch] = sprite.crop ?? [0, 0, sprite.size[0], sprite.size[1]];
  const w = width ?? cw;
  return {
    width: w * scale,
    height: ch * scale,
    backgroundImage: `url(${textureUrl(version, sprite.texture)})`,
    backgroundSize: `${sprite.size[0] * scale}px ${sprite.size[1] * scale}px`,
    backgroundPosition: `-${cx * scale}px -${cy * scale}px`,
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
  };
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
export function roman(n: number): string {
  return ROMAN[n] ?? String(n);
}

export function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function dimensionName(id: string): string {
  const map: Record<string, string> = {
    "minecraft:overworld": "Overworld",
    "minecraft:the_nether": "Nether",
    "minecraft:the_end": "The End",
  };
  return map[id] ?? id;
}
