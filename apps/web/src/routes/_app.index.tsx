import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Cpu, HardDrive, MemoryStick, Plus, Server } from "lucide-react";
import { OnboardingCard } from "@/components/onboarding-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTRPC } from "@/lib/trpc";
import { formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(context.trpc.servers.list.queryOptions()),
      context.queryClient.ensureQueryData(context.trpc.system.info.queryOptions()),
    ]);
  },
  component: Dashboard,
});

const statusVariant = {
  running: "success",
  starting: "warning",
  stopping: "warning",
  installing: "warning",
  crashed: "danger",
  stopped: "outline",
  sleeping: "outline",
} as const;

function Dashboard() {
  const trpc = useTRPC();
  const servers = useQuery(trpc.servers.list.queryOptions(undefined, { refetchInterval: 5_000 }));
  const info = useQuery(trpc.system.info.queryOptions(undefined, { refetchInterval: 10_000 }));
  const hosts = useQuery(trpc.hosts.list.queryOptions(undefined, { refetchInterval: 15_000 }));
  const hostOf = (id: string) => hosts.data?.find((h) => h.id === id);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything you run, wherever it lives.
          </p>
        </div>
        <Button asChild>
          <Link to="/servers/new">
            <Plus /> New server
          </Link>
        </Button>
      </div>

      <OnboardingCard />

      <section className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-muted-foreground">This machine</CardTitle>
            <Server className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{info.data?.hostname ?? "…"}</p>
            <p className="text-xs text-muted-foreground">
              {info.data ? `${info.data.platform} · ${info.data.arch}` : ""}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-muted-foreground">CPU</CardTitle>
            <Cpu className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{info.data?.cpus ?? "…"} threads</p>
            <p className="text-xs text-muted-foreground">Node {info.data?.nodeVersion ?? ""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-muted-foreground">Memory</CardTitle>
            <MemoryStick className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">
              {info.data ? formatMb(info.data.freeMemMb) : "…"}{" "}
              <span className="text-sm font-normal text-muted-foreground">free</span>
            </p>
            <p className="text-xs text-muted-foreground">
              of {info.data ? formatMb(info.data.totalMemMb) : ""}
            </p>
          </CardContent>
        </Card>
      </section>

      <section>
        {servers.data && servers.data.length === 0 ? (
          <Card className="border-dashed">
            <CardHeader className="items-center py-12 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-muted">
                <HardDrive className="size-5 text-muted-foreground" />
              </span>
              <CardTitle className="mt-2 text-base">No servers yet</CardTitle>
              <CardDescription>
                Create one on this machine, a VPS, or your cloud account.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {servers.data?.map((s) => (
              <li key={s.id}>
                <Link to="/servers/$id" params={{ id: s.id }} className="block">
                  <Card className="transition-colors hover:bg-muted/40">
                    <CardHeader className="flex-row items-start justify-between space-y-0">
                      <div>
                        <CardTitle className="text-base">{s.name}</CardTitle>
                        <CardDescription>
                          {s.software} {s.mcVersion} · {formatMb(s.memoryMb)} · :{s.port}
                          {s.hostId !== "local" && ` · on ${hostOf(s.hostId)?.name ?? "a VPS"}`}
                        </CardDescription>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {s.hostId !== "local" &&
                          hostOf(s.hostId) &&
                          hostOf(s.hostId)?.state !== "online" && (
                            <Badge variant="danger" title="The host is not connected">
                              host {hostOf(s.hostId)?.state}
                            </Badge>
                          )}
                        {!s.onlineMode && (
                          <Badge variant="warning" title="Offline mode: no account checks">
                            offline
                          </Badge>
                        )}
                        <Badge variant={statusVariant[s.status as keyof typeof statusVariant]} dot>
                          {s.status}
                        </Badge>
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
