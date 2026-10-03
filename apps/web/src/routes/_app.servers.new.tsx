import {
  createServerInput,
  estimateJvmOverheadMb,
  estimateProcessMemoryMb,
  type ServerSoftware,
} from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Laptop, Package, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { OfflineModeWarning } from "@/components/offline-mode-warning";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/new")({
  validateSearch: (s: Record<string, unknown>): { hostId?: string } => ({
    hostId: typeof s.hostId === "string" ? s.hostId : undefined,
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(context.trpc.mc.software.queryOptions()),
      context.queryClient.ensureQueryData(context.trpc.hosts.list.queryOptions()),
    ]);
  },
  component: NewServer,
});

function NewServer() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const software = useQuery(trpc.mc.software.queryOptions());
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const [hostId, setHostId] = useState(search.hostId ?? "local");
  const host = hosts.data?.find((h) => h.id === hostId);
  const limits = useQuery(trpc.mc.limits.queryOptions({ hostId }));
  const hostReady = hostId === "local" || host?.state === "online";

  const [sw, setSw] = useState<ServerSoftware>("paper");
  const [snapshots, setSnapshots] = useState(false);
  const [version, setVersion] = useState("");
  const [name, setName] = useState("My server");
  const [memory, setMemory] = useState<number | null>(null);
  const [port, setPort] = useState(25565);
  const [eula, setEula] = useState(false);
  const [onlineMode, setOnlineMode] = useState(true);

  const versions = useQuery(
    trpc.mc.versions.queryOptions(
      { software: sw, includeSnapshots: snapshots },
      { staleTime: 5 * 60_000 },
    ),
  );

  // Default to the newest release whenever the list changes.
  useEffect(() => {
    if (versions.data && !versions.data.some((v) => v.id === version)) {
      setVersion(versions.data[0]?.id ?? "");
    }
  }, [versions.data, version]);

  const memoryMb = Math.min(
    memory ?? limits.data?.defaultMemMb ?? 2048,
    limits.data?.maxMemMb ?? Number.POSITIVE_INFINITY,
  );

  const create = useMutation(
    trpc.servers.create.mutationOptions({
      onSuccess: async (server) => {
        await queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
        toast.success(`Creating ${server.name}`);
        await navigate({ to: "/servers/$id", params: { id: server.id } });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  const input = useMemo(
    () => ({
      hostId,
      name,
      software: sw,
      mcVersion: version,
      memoryMb,
      port,
      onlineMode,
      acceptEula: eula as true,
    }),
    [hostId, name, sw, version, memoryMb, port, onlineMode, eula],
  );
  const validation = createServerInput.safeParse(input);
  const canSubmit = validation.success && !create.isPending && hostReady;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/">
          <ArrowLeft /> Servers
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New server</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Runs on {hostId === "local" ? "this machine" : (host?.name ?? "the chosen host")}. Java
          and the server files are downloaded for you.
        </p>
        <Link
          to="/servers/modpack"
          className="mt-2 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <Package className="size-4" /> Install a modpack instead
        </Link>
      </div>

      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (validation.success) create.mutate(validation.data);
        }}
      >
        {(hosts.data?.length ?? 0) > 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Host</CardTitle>
              <CardDescription>Where the server runs. You can move it later.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {hosts.data?.map((h) => {
                const online = h.state === "online";
                const Icon = h.kind === "local" ? Laptop : TerminalSquare;
                return (
                  <button
                    type="button"
                    key={h.id}
                    disabled={!online}
                    onClick={() => {
                      setHostId(h.id);
                      setMemory(null);
                    }}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      hostId === h.id
                        ? "border-primary bg-accent/60"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <Icon className="size-4" /> {h.name}
                      </span>
                      {hostId === h.id && <Check className="size-4 text-primary" />}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {h.kind === "local" ? "This computer" : (h.address ?? "")}
                      {h.totalMemMb ? ` · ${formatMb(h.totalMemMb)} RAM` : ""}
                      {h.freeMemMb != null ? `, ${formatMb(h.freeMemMb)} free` : ""}
                      {!online ? ` · ${h.state}` : ""}
                    </p>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Software</CardTitle>
            <CardDescription>
              What runs your world. Paper is the right choice for most people.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-3">
            {software.data?.map((s) => (
              <button
                type="button"
                key={s.id}
                disabled={!s.supported}
                onClick={() => setSw(s.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  sw === s.id ? "border-primary bg-accent/60" : "border-border hover:bg-muted",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{s.label}</span>
                  {sw === s.id && <Check className="size-4 text-primary" />}
                  {!s.supported && (
                    <span className="text-[10px] uppercase text-muted-foreground">soon</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Version</CardTitle>
            <CardDescription>Players need a matching client version to join.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="version">Minecraft version</Label>
              <Select
                id="version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                disabled={versions.isPending}
              >
                {versions.isPending && <option>Loading versions…</option>}
                {versions.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id}
                    {v.kind === "snapshot" ? " (pre-release)" : ""}
                  </option>
                ))}
              </Select>
              {versions.error && (
                <p className="text-xs text-destructive">{errorMessage(versions.error)}</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Switch id="snapshots" checked={snapshots} onCheckedChange={setSnapshots} />
              <Label htmlFor="snapshots" className="font-normal text-muted-foreground">
                Show snapshots and pre-releases
              </Label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resources</CardTitle>
            <CardDescription>
              {hostId === "local" ? "This machine" : (host?.name ?? "The host")} has{" "}
              {limits.data ? formatMb(limits.data.totalMemMb) : "…"} of RAM. 2 to 4 GB suits a
              handful of players; modded servers want more.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="memory">Memory</Label>
                <span className="text-sm tabular-nums">{formatMb(memoryMb)}</span>
              </div>
              <input
                id="memory"
                type="range"
                min={1024}
                max={limits.data?.maxMemMb ?? 8192}
                step={512}
                value={memoryMb}
                onChange={(e) => setMemory(Number(e.target.value))}
                className="w-full accent-[var(--primary)]"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>1 GB</span>
                <span>{limits.data ? formatMb(limits.data.maxMemMb) : ""}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                This is the heap. Java itself needs about{" "}
                {formatMb(estimateJvmOverheadMb(memoryMb))} more, so expect the server to use around{" "}
                {formatMb(estimateProcessMemoryMb(memoryMb))} in Task Manager.
              </p>
            </div>
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">25565 is the default players expect.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Player login</CardTitle>
            <CardDescription>
              Online mode checks every player with Microsoft. Turn it off for friends without a
              Minecraft account or for LAN play. You can change this later in Settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="online-mode">Require a Microsoft account (online mode)</Label>
              <Switch id="online-mode" checked={onlineMode} onCheckedChange={setOnlineMode} />
            </div>
            {!onlineMode && <OfflineModeWarning existingWorld={false} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Name and agreement</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor="name">Server name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={48}
              />
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
              <input
                type="checkbox"
                checked={eula}
                onChange={(e) => setEula(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span className="text-sm">
                I agree to the{" "}
                <a
                  href="https://aka.ms/MinecraftEULA"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  Minecraft End User License Agreement
                </a>
                . The server will not start without it.
              </span>
            </label>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          {!validation.success && name && version && eula && (
            <p className="text-xs text-destructive">{validation.error.issues[0]?.message}</p>
          )}
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? "Creating…" : "Create server"}
          </Button>
        </div>
      </form>
    </div>
  );
}
