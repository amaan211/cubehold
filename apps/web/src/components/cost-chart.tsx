import { useState } from "react";
import { cn, formatMoney } from "@/lib/utils";

export interface DayCost {
  day: string;
  compute: number;
  storage: number;
  ip: number;
  total: number;
}

/** A round top for the axis: 1, 2 or 5 times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Cost per day of one month as bars in the primary hue: thin bars with a 2px
 * gap, rounded at the top, a quiet axis, a tooltip per day, and a table view.
 */
export function DailyCostChart({
  days,
  currency,
  today,
}: {
  days: DayCost[];
  currency: "EUR" | "USD";
  /** Days after this one have not happened yet. */
  today: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const top = niceMax(Math.max(0, ...days.map((d) => d.total)));
  const spent = days.some((d) => d.total > 0);
  const h = days[hover ?? -1];
  const ticks = [top, top / 2, 0];

  return (
    <div className="space-y-2">
      {!spent ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing spent this month.</p>
      ) : table ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="p-2 font-medium">Day</th>
                <th className="p-2 text-right font-medium">VM time</th>
                <th className="p-2 text-right font-medium">Storage</th>
                <th className="p-2 text-right font-medium">IPv4</th>
                <th className="p-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {days
                .filter((d) => d.total > 0)
                .map((d) => (
                  <tr key={d.day} className="border-b border-border last:border-0">
                    <td className="p-2">{dayLabel(d.day)}</td>
                    <td className="p-2 text-right">{formatMoney(d.compute, currency)}</td>
                    <td className="p-2 text-right">{formatMoney(d.storage, currency)}</td>
                    <td className="p-2 text-right">{formatMoney(d.ip, currency)}</td>
                    <td className="p-2 text-right font-medium">{formatMoney(d.total, currency)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2">
          {/* Axis labels, in text ink. */}
          <div className="flex h-40 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums">
            {ticks.map((t) => (
              <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
                {formatMoney(t, currency)}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              {ticks.map((t) => (
                <div
                  key={t}
                  className={cn("border-t", t === 0 ? "border-border" : "border-border/50")}
                />
              ))}
            </div>
            <div
              className="relative flex h-40 items-end gap-[2px]"
              role="img"
              aria-label={`Cost per day, ${dayLabel(days[0]?.day ?? "")} to ${dayLabel(days.at(-1)?.day ?? "")}`}
              onMouseLeave={() => setHover(null)}
            >
              {days.map((d, i) => {
                const future = today !== null && d.day > today;
                const pct = (d.total / top) * 100;
                return (
                  // Each column is the hit target, taller and wider than its bar.
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover readout only; the table view has the same numbers
                  <div
                    key={d.day}
                    className="flex h-full min-w-0 flex-1 items-end"
                    onMouseEnter={() => setHover(i)}
                  >
                    <div
                      className={cn(
                        "w-full rounded-t-[4px] transition-opacity",
                        future ? "bg-transparent" : "bg-primary",
                        hover !== null && hover !== i && "opacity-60",
                      )}
                      style={{ height: d.total > 0 ? `max(2px, ${pct}%)` : 0 }}
                    />
                  </div>
                );
              })}
              {h && hover !== null && (
                <div
                  className="pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-56 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-md"
                  style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
                >
                  <p className="font-medium">
                    {dayLabel(h.day)}: {formatMoney(h.total, currency)}
                  </p>
                  {h.total > 0 && (
                    <p className="text-muted-foreground">
                      VM time {formatMoney(h.compute, currency)}
                      {h.storage > 0 && `, storage ${formatMoney(h.storage, currency)}`}
                      {h.ip > 0 && `, IPv4 ${formatMoney(h.ip, currency)}`}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="mt-1 flex text-[11px] text-muted-foreground">
              {days.map((d, i) => (
                <span key={d.day} className="min-w-0 flex-1 text-center">
                  {i % 7 === 0 ? Number(d.day.slice(8)) : ""}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {spent && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setTable((v) => !v)}
        >
          {table ? "Show as a chart" : "Show as a table"}
        </button>
      )}
    </div>
  );
}
