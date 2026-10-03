import type { FacePart, ItemIcon as Icon } from "@cubehold/shared";
import { useId } from "react";
import { hex, textureUrl } from "./assets";

/**
 * Draws an item like the game's inventory: flat sprites pixel for pixel, and
 * blocks as a lit isometric cube (top, north face on the left, east face on
 * the right) with each face's texture mapped by an affine transform.
 * Coordinates are in a 32x32 box (a 16x16 slot at 2x).
 */
export function ItemIcon({
  icon,
  version,
  color,
  size = 32,
  label,
}: {
  icon: Icon | undefined;
  version: string;
  /** Dye or potion colour of this particular stack. */
  color?: number | null;
  size?: number;
  label?: string;
}) {
  const uid = useId().replace(/:/g, "");
  if (!icon || icon.kind === "missing") {
    const initials = (label ?? "?")
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return (
      <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label={label}>
        <title>{label ?? "Unknown item"}</title>
        <rect
          x="3"
          y="3"
          width="26"
          height="26"
          rx="4"
          fill="#8b8b8b"
          stroke="#373737"
          strokeWidth="2"
        />
        <text
          x="16"
          y="21"
          textAnchor="middle"
          fontSize="12"
          fontWeight="700"
          fill="#ffffff"
          fontFamily="monospace"
        >
          {initials}
        </text>
      </svg>
    );
  }

  // Every colour used, collected up front so the filters exist before anything refers to them.
  const tints = new Map<string, number>();
  const used =
    icon.kind === "flat"
      ? icon.layers.map((l) => (l.dyeable && color != null ? color : l.tint))
      : [...icon.top, ...icon.left, ...icon.right].map((p) => p.tint);
  for (const t of used) if (t !== null) tints.set(hex(t).slice(1), t);
  const filterFor = (tint: number | null) =>
    tint === null ? undefined : `url(#${uid}-t${hex(tint).slice(1)})`;

  let body: React.ReactNode;
  if (icon.kind === "flat") {
    body = icon.layers.map((l) => {
      const tint = l.dyeable && color != null ? color : l.tint;
      // Nested svg crops: animated strips to their first frame, atlas sprites to their uv.
      const [u0, v0, u1, v1] = l.uv ?? [0, 0, l.size[0], l.size[0]];
      return (
        <svg
          key={l.texture}
          aria-hidden
          x="0"
          y="0"
          width="32"
          height="32"
          viewBox={`${u0} ${v0} ${u1 - u0} ${v1 - v0}`}
        >
          <image
            href={textureUrl(version, l.texture)}
            width={l.size[0]}
            height={l.size[1]}
            preserveAspectRatio="none"
            filter={filterFor(tint)}
            style={{ imageRendering: "pixelated" }}
          />
        </svg>
      );
    });
  } else {
    body = <Cube icon={icon} version={version} uid={uid} filterFor={filterFor} />;
  }

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      style={{ overflow: "visible" }}
    >
      <title>{label ?? "Item"}</title>
      <defs>
        {[...tints.entries()].map(([key, tint]) => (
          <filter key={key} id={`${uid}-t${key}`} colorInterpolationFilters="sRGB">
            <feFlood floodColor={hex(tint)} result="c" />
            <feComposite
              in="c"
              in2="SourceGraphic"
              operator="arithmetic"
              k1="1"
              k2="0"
              k3="0"
              k4="0"
            />
            <feComposite in2="SourceGraphic" operator="in" />
          </filter>
        ))}
      </defs>
      {body}
    </svg>
  );
}

type Pt = [number, number];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];

function Cube({
  icon,
  version,
  uid,
  filterFor,
}: {
  icon: Extract<Icon, { kind: "block" }>;
  version: string;
  uid: string;
  filterFor: (tint: number | null) => string | undefined;
}) {
  // Full cube at scale 1: 28 wide, top face 14 tall, sides 17 tall; 31 in all.
  const s = icon.scale;
  const W = 14 * s;
  const H = 7 * s;
  const S = 17 * s;
  const side = S * icon.height;
  const total = 2 * H + S;
  const y0 = (32 - total) / 2 + (S - side);
  const A: Pt = [16, y0];
  const B: Pt = [16 + W, y0 + H];
  const C: Pt = [16, y0 + 2 * H];
  const D: Pt = [16 - W, y0 + H];
  const down: Pt = [0, side];
  // origin, u axis, v axis of each face as the texture sees it (from outside the block)
  const faces: Array<{ key: string; parts: FacePart[]; o: Pt; u: Pt; v: Pt; shade: number }> = [
    { key: "top", parts: icon.top, o: D, u: add(C, mul(D, -1)), v: add(A, mul(D, -1)), shade: 0 },
    { key: "left", parts: icon.left, o: C, u: add(D, mul(C, -1)), v: down, shade: 0.22 },
    { key: "right", parts: icon.right, o: B, u: add(C, mul(B, -1)), v: down, shade: 0.42 },
  ];
  return (
    <g>
      {faces.map((f) =>
        f.parts.map((p, i) => {
          const o = add(add(f.o, mul(f.u, p.x[0])), mul(f.v, p.y[0]));
          const u = mul(f.u, p.x[1] - p.x[0]);
          const v = mul(f.v, p.y[1] - p.y[0]);
          const [a, b, c, d] = p.uv;
          const du = c - a || 1;
          const dv = d - b || 1;
          const m: [number, number, number, number] = [u[0] / du, u[1] / du, v[0] / dv, v[1] / dv];
          const e = o[0] - m[0] * a - m[2] * b;
          const fy = o[1] - m[1] * a - m[3] * b;
          const quad = [o, add(o, u), add(add(o, u), v), add(o, v)];
          const id = `${uid}-${f.key}-${i}`;
          // Grow the clip a hair so neighbouring faces meet without a hairline gap.
          const cx = quad.reduce((n, q) => n + q[0], 0) / 4;
          const cy = quad.reduce((n, q) => n + q[1], 0) / 4;
          const grown = quad
            .map(([x, y]) => `${cx + (x - cx) * 1.02},${cy + (y - cy) * 1.02}`)
            .join(" ");
          return (
            <g key={id}>
              <clipPath id={id}>
                <polygon points={grown} />
              </clipPath>
              <g clipPath={`url(#${id})`}>
                <image
                  href={textureUrl(version, p.texture)}
                  width={p.size[0]}
                  height={p.size[1]}
                  preserveAspectRatio="none"
                  transform={`matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${e} ${fy})`}
                  filter={filterFor(p.tint)}
                  style={{ imageRendering: "pixelated" }}
                />
                {f.shade > 0 && <polygon points={grown} fill="#000" fillOpacity={f.shade} />}
              </g>
            </g>
          );
        }),
      )}
    </g>
  );
}
