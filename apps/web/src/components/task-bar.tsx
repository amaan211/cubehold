import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** A running job: label, percent when known, and a thin progress bar. */
export function TaskBar({
  label,
  percent,
  className,
}: {
  label: string;
  percent: number | null;
  className?: string;
}) {
  return (
    <div
      className={cn("rounded-lg border border-primary/30 bg-card p-3 text-sm", className)}
      role="status"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <span className="truncate">{label}</span>
        </span>
        {percent !== null && <span className="tabular-nums text-muted-foreground">{percent}%</span>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-[width]",
            percent === null && "w-1/3 animate-pulse",
          )}
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}
