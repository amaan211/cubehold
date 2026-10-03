import { useQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, Link, Outlet } from "@tanstack/react-router";
import { ArrowLeft, Moon, ShieldOff, Trash2, Users, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DeleteServerDialog } from "@/components/delete-server-dialog";
import { ServerActions } from "@/components/server-actions";
import { TaskBar } from "@/components/task-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { realtime, useConnectionState, useServerLive } from "@/lib/realtime";
import { queryClient, useTRPC } from "@/lib/trpc";
import { formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      context.trpc.servers.get.queryOptions({ serverId: params.id }),
    ),
  component: ServerLayout,
  errorComponent: ({ error }: ErrorComponentProps) => (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link to="/">
          <ArrowLeft /> Servers
        </Link>
      </Button>
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  ),
});

export const statusVariant = {
  running: "success",
  starting: "warning",
  stopping: "warning",
  installing: "warning",
  crashed: "danger",
  stopped: "outline",
  sleeping: "outline",
} as const;

function ServerLayout() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const server = useQuery(
    trpc.servers.get.queryOptions({ serverId: id }, { refetchInterval: 15_000 }),
  );
  const hosts = useQuery(trpc.hosts.list.queryOptions(undefined, { refetchInterval: 15_000 }));
  const live = useServerLive(id);
  const conn = useConnectionState();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Version, Java and settings change underneath us during installs and
  // version changes; refresh them as soon as the status moves on.
  const lastStatus = useRef(live.status);
  useEffect(() => {
    if (lastStatus.current === "installing" && live.status !== "installing") {
      void queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
    }
    lastStatus.current = live.status;
  }, [live.status, trpc]);

  // Finished background jobs: tell the user and refresh what they changed.
  useEffect(
    () =>
      realtime.onTask((task) => {
        if (task.serverId !== id || task.state === "running") return;
        const keys = {
          backup: [trpc.backups.pathKey()],
          restore: [trpc.backups.pathKey(), trpc.files.pathKey()],
          archive: [trpc.files.pathKey()],
          extract: [trpc.files.pathKey()],
          addon: [trpc.addons.pathKey()],
          move: [
            trpc.servers.pathKey(),
            trpc.hosts.pathKey(),
            trpc.network.pathKey(),
            trpc.backups.pathKey(),
            trpc.files.pathKey(),
          ],
        }[task.kind];
        for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
        // Plugin installs report through their own button; avoid a second toast.
        if (task.kind === "addon") return;
        if (task.state === "failed") toast.error(`${task.label} failed: ${task.message ?? ""}`);
        else toast.success(`${task.label}: done${task.message ? ` (${task.message})` : ""}`);
      }),
    [id, trpc],
  );

  const s = server.data;
  const host = hosts.data?.find((h) => h.id === s?.hostId);
  if (!s) return null;
  const status = live.ready ? live.status : s.status;
  const addonsLabel =
    s.software === "fabric" || s.software === "forge" || s.software === "neoforge"
      ? "Mods"
      : s.software === "vanilla"
        ? null
        : "Plugins";
  const tabs = [
    { to: "/servers/$id", label: "Overview", exact: true },
    { to: "/servers/$id/console", label: "Console", exact: false },
    { to: "/servers/$id/players", label: "Players", exact: false },
    { to: "/servers/$id/files", label: "Files", exact: false },
    ...(addonsLabel ? [{ to: "/servers/$id/addons", label: addonsLabel, exact: false }] : []),
    { to: "/servers/$id/backups", label: "Backups", exact: false },
    { to: "/servers/$id/schedules", label: "Schedules", exact: false },
    { to: "/servers/$id/network", label: "Network", exact: false },
    { to: "/servers/$id/security", label: "Security", exact: false },
    { to: "/servers/$id/settings", label: "Settings", exact: false },
  ] as const;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/">
          <ArrowLeft /> Servers
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{s.name}</h1>
            <Badge variant={statusVariant[status]} dot data-testid="server-status">
              {status === "sleeping" && <Moon className="size-3" />}
              {status}
            </Badge>
            {!s.onlineMode && (
              <Link to="/servers/$id/settings" params={{ id }} title="Player login settings">
                <Badge variant="warning">
                  <ShieldOff className="size-3" /> Offline mode
                </Badge>
              </Link>
            )}
            {conn !== "open" && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title="Live updates disconnected"
              >
                <WifiOff className="size-3.5" /> {conn === "connecting" ? "connecting" : "offline"}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {s.software} {s.mcVersion} · Java {s.javaVersion || "…"} · {formatMb(s.memoryMb)} heap ·
            port {s.port}
            {host && host.kind !== "local" && (
              <>
                {" "}
                · on{" "}
                <Link to="/hosts" className="hover:underline">
                  {host.name}
                </Link>
              </>
            )}
            {live.players.length > 0 && (
              <>
                {" "}
                · <Users className="inline size-3.5" /> {live.players.length} online
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ServerActions serverId={id} status={status} />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete server"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={status === "installing"}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {live.install && (
        <TaskBar
          label={live.install.message}
          percent={live.install.percent}
          className="border-border"
        />
      )}
      {live.tasks.map((t) => (
        <TaskBar
          key={t.taskId}
          label={t.message ? `${t.label} · ${t.message}` : t.label}
          percent={t.percent}
        />
      ))}
      {host && (host.state === "vm-stopped" || host.state === "hibernated") && (
        <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
          {host.name} is turned off
          {host.state === "hibernated" ? " and saved as a snapshot" : ""} to save money. Start boots
          it first ({host.state === "hibernated" ? "2 to 5 minutes" : "about a minute"}); the
          address players use may change.
        </p>
      )}
      {host &&
        host.kind !== "local" &&
        host.state !== "online" &&
        host.state !== "vm-stopped" &&
        host.state !== "hibernated" && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {host.name} is not connected ({host.state}
            {host.error ? `: ${host.error}` : ""}). The server keeps running there if it was; the
            panel shows its last known state until the connection is back.{" "}
            <Link to="/hosts" className="underline">
              Hosts
            </Link>
          </p>
        )}
      {s.meta?.installError && status !== "installing" && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Installation failed: {s.meta.installError}. Press Start to retry.
        </p>
      )}

      <nav className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-1 border-b border-border">
          {tabs.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              params={{ id }}
              activeOptions={{ exact: t.exact }}
              className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              activeProps={{ className: "border-primary text-foreground" }}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </nav>

      <Outlet />

      <DeleteServerDialog
        serverId={id}
        serverName={s.name}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
