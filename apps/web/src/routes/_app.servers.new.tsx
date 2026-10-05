import {
  createServerInput,
  estimateJvmOverheadMb,
  estimateProcessMemoryMb,
  heapLimits,
  type ServerSoftware,
} from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Cloud,
  Laptop,
  Loader2,
  Package,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConnectAccountDialog } from "@/components/cloud-accounts";
import {
  CloudPriceNotes,
  CloudSizeTable,
  CloudWhereFields,
  useCloudCatalog,
} from "@/components/cloud-picker";
import { JobSteps, useHostJob } from "@/components/hosts";
import { OfflineModeWarning } from "@/components/offline-mode-warning";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatMb } from "@/lib/utils";

/** The "host" that means: create a new cloud VM for this server. */
const NEW_VM = "new-cloud-vm";

export const Route = createFileRoute("/_app/servers/new")({
  validateSearch: (s: Record<string, unknown>): { hostId?: string; cloud?: boolean } => ({
    hostId: typeof s.hostId === "string" ? s.hostId : undefined,
    cloud: s.cloud === true || s.cloud === "true" ? true : undefined,
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
  const [hostId, setHostId] = useState(search.cloud ? NEW_VM : (search.hostId ?? "local"));
  const newVm = hostId === NEW_VM;
  const host = hosts.data?.find((h) => h.id === hostId);
  const limits = useQuery(trpc.mc.limits.queryOptions({ hostId }, { enabled: !newVm }));
  const catalog = useCloudCatalog(newVm);
  const [connecting, setConnecting] = useState(false);
  const [size, setSize] = useState("");
  const [vmHostId, setVmHostId] = useState<string | null>(null);

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

  // A new VM: the biggest size on offer sets the slider's top; the size follows the memory.
  const sizes = catalog.sizes.data ?? [];
  // Until sizes load (or with no account yet), the slider keeps a usual range.
  const vmMaxMb = sizes.length
    ? Math.min(32768, Math.max(1024, ...sizes.map((s) => heapLimits(s.memoryMb).maxMemMb)))
    : 16384;
  const maxMemMb = newVm ? vmMaxMb : (limits.data?.maxMemMb ?? 8192);
  const memoryMb = Math.min(
    memory ?? (newVm ? 2048 : (limits.data?.defaultMemMb ?? 2048)),
    maxMemMb,
  );
  const fitsVm = (s: { memoryMb: number }) => heapLimits(s.memoryMb).maxMemMb >= memoryMb;
  const best = sizes.find(fitsVm);
  useEffect(() => {
    if (!newVm) return;
    const current = sizes.find((s) => s.id === size);
    if ((!current || !fitsVm(current)) && best) setSize(best.id);
  });
  const chosen = sizes.find((s) => s.id === size);
  const noAccounts = newVm && catalog.accounts.data?.length === 0;

  const hostReady = newVm
    ? !!chosen && fitsVm(chosen)
    : hostId === "local" || host?.state === "online";

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
  const createVm = useMutation(
    trpc.cloud.createHost.mutationOptions({
      onSuccess: (r) => {
        setVmHostId(r.hostId);
        void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
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
  const pending = create.isPending || createVm.isPending;
  const canSubmit = validation.success && !pending && hostReady;

  if (vmHostId) return <CreatingOnVm hostId={vmHostId} name={name} />;

  const where = newVm
    ? "a new cloud VM"
    : hostId === "local"
      ? "this machine"
      : (host?.name ?? "the chosen host");
  const totalMb = newVm ? chosen?.memoryMb : limits.data?.totalMemMb;

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
          Runs on {where}. Java and the server files are downloaded for you.
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
          if (!validation.success) return;
          if (!newVm) return create.mutate(validation.data);
          const { hostId: _h, ...server } = validation.data;
          createVm.mutate({
            accountId: catalog.accountId,
            region: catalog.region,
            size,
            name: name.trim(),
            firewall: true,
            fail2ban: true,
            autoUpdates: true,
            server,
          });
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>Where it runs</CardTitle>
            <CardDescription>You can move the server to another host later.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {hosts.data?.map((h) => {
              const online = h.state === "online";
              const Icon =
                h.kind === "local" ? Laptop : h.kind === "cloud" ? Cloud : TerminalSquare;
              return (
                <Choice
                  key={h.id}
                  selected={hostId === h.id}
                  disabled={!online}
                  onClick={() => {
                    setHostId(h.id);
                    setMemory(null);
                  }}
                  icon={<Icon className="size-4" />}
                  title={h.name}
                  hint={`${h.kind === "local" ? "This computer" : (h.address ?? "")}${
                    h.totalMemMb ? ` · ${formatMb(h.totalMemMb)} RAM` : ""
                  }${h.freeMemMb != null ? `, ${formatMb(h.freeMemMb)} free` : ""}${
                    !online ? ` · ${h.state}` : ""
                  }`}
                />
              );
            })}
            <Choice
              selected={newVm}
              onClick={() => {
                setHostId(NEW_VM);
                setMemory(null);
              }}
              icon={<Cloud className="size-4" />}
              title="A new cloud server"
              hint="A VM in your Hetzner, DigitalOcean, Vultr, Linode or AWS account, set up for you"
            />
          </CardContent>
        </Card>

        {newVm && noAccounts && (
          <Card className="border-primary/40">
            <CardHeader>
              <CardTitle>Connect a cloud account first</CardTitle>
              <CardDescription>
                The panel creates the VM in your own account with an API token (an access key on
                AWS), so the provider bills you directly. It takes a couple of minutes; the dialog
                shows where to make the token.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => setConnecting(true)}>
                <Cloud /> Connect a cloud account
              </Button>
              <Button asChild type="button" variant="outline">
                <Link to="/hosts/guide">Which provider?</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {newVm && !noAccounts && (
          <Card>
            <CardHeader>
              <CardTitle>Cloud server</CardTitle>
              <CardDescription>
                Pick a location close to your players. The size follows the memory you give the
                server below; you can pick a bigger one.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CloudWhereFields catalog={catalog} />
              <CloudSizeTable
                catalog={catalog}
                fits={fitsVm}
                best={best}
                selected={size}
                onSelect={setSize}
              />
              <CloudPriceNotes catalog={catalog} chosen={chosen} />
              <p className="flex gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" /> The VM gets Ubuntu
                24.04, a firewall, fail2ban and automatic security updates, and accepts only the
                panel's SSH key.
              </p>
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
              {newVm ? (
                <>
                  {chosen
                    ? `${chosen.label} has ${formatMb(chosen.memoryMb)} of RAM.`
                    : noAccounts
                      ? "Connect a cloud account above first."
                      : "Pick a cloud server size above."}{" "}
                </>
              ) : (
                <>
                  {hostId === "local" ? "This machine" : (host?.name ?? "The host")} has{" "}
                  {totalMb ? formatMb(totalMb) : "…"} of RAM.{" "}
                </>
              )}
              2 to 4 GB suits a handful of players; modded servers want more.
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
                max={maxMemMb}
                step={512}
                value={memoryMb}
                onChange={(e) => setMemory(Number(e.target.value))}
                className="w-full accent-[var(--primary)]"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>1 GB</span>
                <span>{formatMb(maxMemMb)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                This is the heap. Java itself needs about{" "}
                {formatMb(estimateJvmOverheadMb(memoryMb))} more, so expect the server to use around{" "}
                {formatMb(estimateProcessMemoryMb(memoryMb))}
                {newVm ? "." : " in Task Manager."}
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

        <div className="flex flex-wrap items-center justify-end gap-3">
          {!validation.success && name && version && eula && (
            <p className="text-xs text-destructive">{validation.error.issues[0]?.message}</p>
          )}
          {newVm && chosen && (
            <p className="text-xs text-muted-foreground">
              Creates {chosen.label} in {catalog.account?.label ?? "your account"}; billing starts
              when the VM does.
            </p>
          )}
          <Button type="submit" disabled={!canSubmit}>
            {pending && <Loader2 className="animate-spin" />}
            {pending ? "Creating…" : newVm ? "Create the VM and server" : "Create server"}
          </Button>
        </div>
      </form>
      <ConnectAccountDialog open={connecting} onClose={() => setConnecting(false)} />
    </div>
  );
}

function Choice({
  selected,
  disabled,
  onClick,
  icon,
  title,
  hint,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-primary bg-accent/60" : "border-border hover:bg-muted",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          {icon} {title}
        </span>
        {selected && <Check className="size-4 text-primary" />}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/** Progress of a new VM; opens the server once it exists. */
function CreatingOnVm({ hostId, name }: { hostId: string; name: string }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const job = useHostJob(hostId);
  const j = job.data;
  useEffect(() => {
    if (j?.state === "done" && j.serverId) {
      void queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
      toast.success(`${name} is installing on its new VM`);
      void navigate({ to: "/servers/$id", params: { id: j.serverId } });
    }
  }, [j?.state, j?.serverId, name, navigate, trpc]);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New server</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The provider builds the VM, the panel sets it up over SSH, then creates {name} on it.
          About 3 to 6 minutes; you can leave this page and find it under Hosts.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            {j?.state === "failed" ? "Setup stopped" : `Creating a VM for ${name}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {j ? (
            <JobSteps job={j} defaultLog={j.state === "failed"} />
          ) : (
            <Loader2 className="animate-spin" />
          )}
          {j?.state === "failed" && (
            <p className="flex gap-1.5 text-sm text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" /> {j.error} The VM (if it was created) is
              listed under Hosts, where you can retry or delete it.
            </p>
          )}
          <Button asChild variant="outline">
            <Link to="/hosts">Go to Hosts</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
