import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Laptop,
  Plus,
  RefreshCw,
  Router,
  Server,
  Waypoints,
} from "lucide-react";
import { CloudAccounts } from "@/components/cloud-accounts";
import { SshHostCard } from "@/components/hosts";
import { Address, PlayitHostPanel } from "@/components/network";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { queryClient, useTRPC } from "@/lib/trpc";
import { cn, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/hosts")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(context.trpc.hosts.list.queryOptions()),
  component: Hosts,
});

function Hosts() {
  const trpc = useTRPC();
  const hosts = useQuery(trpc.hosts.list.queryOptions(undefined, { refetchInterval: 5_000 }));
  const local = hosts.data?.find((h) => h.kind === "local");
  const remote = hosts.data?.filter((h) => h.kind !== "local") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hosts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Machines that run your servers: this computer, any VPS you add, and cloud VMs the panel
            creates for you.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/hosts/guide">
              <BookOpen /> Getting a VPS
            </Link>
          </Button>
          <Button asChild>
            <Link to="/hosts/new">
              <Plus /> Add a VPS
            </Link>
          </Button>
        </div>
      </div>

      {local && (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-md bg-muted">
                <Laptop className="size-4" />
              </span>
              <div>
                <CardTitle className="text-base">{local.name}</CardTitle>
                <CardDescription>
                  This computer{local.os ? ` · ${local.os}` : ""} · {local.servers} server
                  {local.servers === 1 ? "" : "s"}
                </CardDescription>
              </div>
            </div>
            <Badge variant="success" dot>
              online
            </Badge>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <HostNetwork hostId={local.id} />
          </CardContent>
        </Card>
      )}

      <CloudAccounts />

      {remote.length > 0 ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {remote.map((h) => (
            <li key={h.id}>
              <SshHostCard h={h} />
            </li>
          ))}
        </ul>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-3 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">Run servers on a VPS</p>
                <p className="text-muted-foreground">
                  A small rented server stays online when this computer is off, and players connect
                  straight to its address. The panel sets it up over SSH in a few minutes.
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link to="/hosts/guide">Which VPS to get</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const wanLabel = {
  public: { text: "Public address on the router: port forwarding works", ok: true },
  cgnat: { text: "Shared address (CGNAT): port forwarding cannot work; use playit.gg", ok: false },
  "double-nat": { text: "Two routers in a row: forward on both, or use playit.gg", ok: false },
  unknown: { text: "No UPnP router answered", ok: false },
} as const;

function HostNetwork({ hostId }: { hostId: string }) {
  const trpc = useTRPC();
  const net = useQuery(trpc.network.host.queryOptions({ hostId }, { refetchInterval: 30_000 }));
  const refresh = useMutation({
    mutationFn: () =>
      queryClient.fetchQuery(trpc.network.host.queryOptions({ hostId, refresh: true })),
    onSuccess: (data) => queryClient.setQueryData(trpc.network.host.queryKey({ hostId }), data),
  });
  const n = net.data;
  const info = n?.info;
  const wan = info ? (info.vpn ? null : wanLabel[info.wan]) : null;

  return (
    <div className="grid gap-6 text-sm text-foreground lg:grid-cols-2">
      <section className="space-y-3">
        <h3 className="flex items-center justify-between font-medium">
          <span className="flex items-center gap-2">
            <Router className="size-4 text-muted-foreground" /> Network
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw className={cn(refresh.isPending && "animate-spin")} /> Check again
          </Button>
        </h3>
        {!info ? (
          <p className="text-muted-foreground">
            {net.isLoading ? "Looking at the network…" : "Could not read the network."}
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
            <dt className="text-muted-foreground">On your network</dt>
            <dd>{info.primary ? <Address value={info.primary} /> : "—"}</dd>
            <dt className="text-muted-foreground">Public IPv4</dt>
            <dd>{info.publicIpv4 ? <Address value={info.publicIpv4} /> : "—"}</dd>
            {info.publicIpv6 && (
              <>
                <dt className="text-muted-foreground">Public IPv6</dt>
                <dd className="min-w-0">
                  <Address value={info.publicIpv6} muted />
                </dd>
              </>
            )}
            {info.tailscale && (
              <>
                <dt className="text-muted-foreground">Tailscale</dt>
                <dd>
                  <Address value={info.tailscale} />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Router</dt>
            <dd>
              {info.router ? (
                <>
                  {info.router.name ?? info.router.model ?? "UPnP router"}{" "}
                  <a
                    className="text-primary hover:underline"
                    href={`http://${info.router.host}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {info.router.host}
                  </a>
                </>
              ) : (
                "No UPnP router found"
              )}
            </dd>
          </dl>
        )}
        {info?.vpn && (
          <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Internet traffic goes through a
            VPN, so the public address above is the VPN's.
          </p>
        )}
        {wan && (
          <p
            className={cn(
              "flex gap-1.5",
              wan.ok ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
            )}
          >
            {wan.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            )}
            {wan.text}
          </p>
        )}
        {n && n.mappings.length > 0 && (
          <div>
            <p className="font-medium">Port forwards kept by the panel</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {n.mappings.map((m) => (
                <li key={m.key}>
                  {m.protocol} {m.port} · {m.server ?? "removed server"} ·{" "}
                  {m.status === "active"
                    ? `active${m.updatedAt ? `, renewed ${timeAgo(m.updatedAt)}` : ""}`
                    : m.status === "failed"
                      ? `failed: ${m.error}`
                      : "pending"}
                </li>
              ))}
            </ul>
          </div>
        )}
        {info && <p className="text-xs text-muted-foreground">Checked {timeAgo(info.checkedAt)}</p>}
      </section>
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 font-medium">
          <Waypoints className="size-4 text-muted-foreground" /> playit.gg
        </h3>
        <PlayitHostPanel />
      </section>
    </div>
  );
}
