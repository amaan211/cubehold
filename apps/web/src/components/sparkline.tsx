import { useId, useMemo, useState } from "react";

export interface SparkPoint {
  at: number;
  value: number;
}

interface SparklineProps {
  data: SparkPoint[];
  /** Fixed upper bound (e.g. 100 for percent); otherwise scaled to the data. */
  max?: number;
  format?: (v: number) => string;
  height?: number;
  className?: string;
  ariaLabel: string;
  /** Shown instead of the chart when there is no data. */
  emptyLabel?: string;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

/**
 * Single-series area sparkline for stat tiles: 2px line in the primary hue, a
 * faint fill, no axes, and a hover readout in text tokens.
 */
export function Sparkline({
  data,
  max,
  format = (v) => v.toFixed(0),
  height = 40,
  className,
  ariaLabel,
  emptyLabel = "No data yet",
}: SparklineProps) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const width = 200;
  const pad = 3;

  const geo = useMemo(() => {
    const n = data.length;
    const peak = n ? Math.max(...data.map((d) => d.value)) : 0;
    const top = max ?? Math.max(1, peak * 1.15);
    const pts = data.map((d, i) => ({
      x: n <= 1 ? width - pad : pad + (i / (n - 1)) * (width - pad * 2),
      y: pad + (1 - Math.min(1, d.value / top)) * (height - pad * 2),
      ...d,
    }));
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const first = pts[0];
    const last = pts[n - 1];
    const area =
      first && last
        ? `${line} L${last.x.toFixed(1)},${height - pad} L${first.x.toFixed(1)},${height - pad} Z`
        : "";
    return { pts, line, area, peak };
  }, [data, max, height]);

  if (data.length === 0) {
    return (
      <div className={className}>
        <div className="flex h-10 items-end">
          <div className="w-full border-t border-dashed border-border" />
        </div>
        <p className="mt-1 h-4 text-xs text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  const hovered = hover !== null ? geo.pts[hover] : null;

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-10 w-full cursor-crosshair overflow-visible"
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rel = (e.clientX - rect.left) / rect.width;
          const idx = Math.round(rel * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, idx)));
        }}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.area} fill={`url(#${id}-fill)`} />
        <path
          d={geo.line}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hovered && (
          <>
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={0}
              y2={height}
              stroke="var(--muted-foreground)"
              strokeWidth="1"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r="3"
              fill="var(--primary)"
              stroke="var(--card)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <p className="mt-1 h-4 text-xs text-muted-foreground tabular-nums">
        {hovered
          ? `${format(hovered.value)} · ${ago(hovered.at)}`
          : `peak ${format(geo.peak)} · last ${Math.max(1, Math.round((Date.now() - (data[0]?.at ?? Date.now())) / 60000))} min`}
      </p>
    </div>
  );
}
