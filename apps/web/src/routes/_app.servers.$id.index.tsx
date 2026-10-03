import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, AlertTriangle, CheckCircle2, Moon, XCircle } from "lucide-react";
import { AccessCard } from "@/components/access-card";
import { Console } from "@/components/console";
import { CrashCard } from "@/components/crash-card";
import { Sparkline } from "@/components/sparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useServerLive } from "@/lib/realtime";
import { useTRPC } from "@/lib/trpc";
import { cn, formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/")({
  component: Overview,
});

/** TPS health, always with an icon and a word so colour is never the only signal. */
function tpsHealth(tps: number) {
  if (tps >= 19.5) return { label: "Smooth", Icon: CheckCircle2, className: "text-primary" };
  if (tps >= 15)
    return {
      label: "Lagging",
      Icon: AlertTriangle,
      className: "text-amber-600 dark:text-amber-400",
    };
  return { label: "Struggling", Icon: XCircle, className: "text-destructive" };
}

function Overview() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const server = useQuery(trpc.servers.get.queryOptions({ serverId: id }));
  const live = useServerLive(id);
  const last = live.metrics.at(-1);
  const heapMb = server.data?.memoryMb ?? last?.memMaxMb ?? 0;
  const online = live.status === "running" || live.status === "starting";
  const offlineLabel =
    live.status === "installing"
      ? "Installing"
      : live.status === "sleeping"
        ? "Sleeping until a player joins"
        : "Server is not running";
  const tpsPoints = live.metrics.flatMap((m) =>
    m.tps === null ? [] : [{ at: m.at, value: m.tps }],
  );
  const heapUsed = online ? (last?.heapUsedMb ?? null) : null;
  const health = online && last?.tps != null ? tpsHealth(last.tps) : null;

  return (
    <div className="space-y-6">
      <CrashCard serverId={id} status={live.status} />

      {live.status === "sleeping" && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-sm">
          <Moon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            Stopped after nobody played for a while. The server list shows it as sleeping, and it
            starts by itself when a player joins (they reconnect after about 30 seconds).
          </p>
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground">CPU</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {online && last ? `${last.cpuPercent.toFixed(1)}%` : "—"}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                of this machine
              </span>
            </p>
            <Sparkline
              className="mt-2"
              data={live.metrics.map((m) => ({ at: m.at, value: m.cpuPercent }))}
              max={100}
              format={(v) => `${v.toFixed(1)}%`}
              ariaLabel="CPU usage over the last five minutes"
              emptyLabel={offlineLabel}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground">Memory</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className="text-2xl font-semibold tabular-nums"
              title="Everything the Java process uses: the heap it reserves at start plus the JVM's own memory"
            >
              {online && last ? formatMb(last.memUsedMb) : "—"}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">Java process</span>
            </p>
            <HeapBar used={heapUsed} max={heapMb} running={online} />
            <Sparkline
              className="mt-2"
              data={live.metrics.map((m) => ({ at: m.at, value: m.memUsedMb }))}
              format={(v) => formatMb(Math.round(v))}
              ariaLabel="Java process memory over the last five minutes"
              emptyLabel={offlineLabel}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center justify-between text-muted-foreground">
              TPS
              {health && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-xs font-medium",
                    health.className,
                  )}
                >
                  <health.Icon className="size-3.5" /> {health.label}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {online && last?.tps != null ? last.tps.toFixed(1) : "—"}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {online && last?.mspt != null
                  ? `${last.mspt.toFixed(1)} ms per tick`
                  : "of 20 per second"}
              </span>
            </p>
            <Sparkline
              className="mt-2"
              data={online ? tpsPoints : []}
              max={20}
              format={(v) => `${v.toFixed(1)} TPS`}
              ariaLabel="Ticks per second over the last five minutes"
              emptyLabel={
                !online
                  ? offlineLabel
                  : live.status === "starting"
                    ? "Available once started"
                    : "Waiting for the first reading"
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground">Players</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {online ? live.players.length : "—"}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {live.players.map((p) => (
                <li key={p} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                  {p}
                </li>
              ))}
              {live.players.length === 0 && (
                <li className="text-xs text-muted-foreground">
                  {online ? "Nobody online" : offlineLabel}
                </li>
              )}
            </ul>
          </CardContent>
        </Card>
      </section>

      <AccessCard serverId={id} />

      <Console serverId={id} heightClass="h-72" />
    </div>
  );
}

/** Heap in use after the last garbage collection, against the configured maximum. */
function HeapBar({ used, max, running }: { used: number | null; max: number; running: boolean }) {
  const pct = used !== null && max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div className="mt-2" title="Heap still in use after the last garbage collection">
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1">
          <Activity className="size-3" /> Heap in use
        </span>
        <span>
          {running && used !== null
            ? `${formatMb(used)} of ${formatMb(max)}`
            : `${formatMb(max)} max`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        {pct > 0 && (
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
