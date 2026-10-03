import { estimateProcessMemoryMb, installModpackInput } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Download, FileArchive, Loader2, Package, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { OfflineModeWarning } from "@/components/offline-mode-warning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatMb } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/modpack")({
  component: ModpackPage,
});

interface Preview {
  packId: string;
  name: string;
  version: string;
  summary: string | null;
  iconUrl: string | null;
  mcVersion: string;
  software: "vanilla" | "fabric" | "forge" | "neoforge";
  loaderVersion: string | null;
  mods: number;
  otherFiles: number;
  clientOnly: number;
  overrides: number;
  downloadBytes: number;
  suggestedMemoryMb: number;
}

const LOADER_LABEL = { vanilla: "Vanilla", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };

function bytes(n: number): string {
  return n > 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.max(1, Math.round(n / 1024 / 1024))} MB`;
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

function ModpackPage() {
  const [preview, setPreview] = useState<Preview | null>(null);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/servers/new">
          <ArrowLeft /> New server
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Install a modpack</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a pack from Modrinth or upload a .mrpack file. The panel installs the right loader,
          downloads every server mod (checked against the pack's hashes) and copies its configs.
        </p>
      </div>
      {preview ? (
        <InstallForm preview={preview} onBack={() => setPreview(null)} />
      ) : (
        <Choose onPrepared={setPreview} />
      )}
    </div>
  );
}

function Choose({ onPrepared }: { onPrepared: (p: Preview) => void }) {
  const trpc = useTRPC();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<{
    projectId: string;
    title: string;
    iconUrl: string | null;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const results = useQuery(
    trpc.modpacks.search.queryOptions({ query: debounced, offset: 0 }, { staleTime: 60_000 }),
  );
  const versions = useQuery(
    trpc.modpacks.versions.queryOptions(
      { projectId: picked?.projectId ?? "" },
      { enabled: !!picked, staleTime: 60_000 },
    ),
  );
  const [versionId, setVersionId] = useState("");
  useEffect(() => {
    const list = versions.data;
    if (list && !list.some((v) => v.id === versionId)) {
      setVersionId((list.find((v) => v.featured) ?? list[0])?.id ?? "");
    }
  }, [versions.data, versionId]);

  const prepare = useMutation(
    trpc.modpacks.prepare.mutationOptions({
      onSuccess: (p) => onPrepared(p),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".mrpack")) {
      toast.error("Choose a .mrpack file (a Modrinth modpack).");
      return;
    }
    setUploading(true);
    try {
      const res = await fetch("/api/modpacks/upload", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "x-cubehold-upload": "1" },
        body: file,
      });
      const body = (await res.json()) as Preview & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Upload failed (HTTP ${res.status})`);
      onPrepared(body);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  if (picked) {
    const v = versions.data?.find((x) => x.id === versionId);
    return (
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <PackIcon url={picked.iconUrl} />
          <div className="min-w-0">
            <CardTitle className="truncate">{picked.title}</CardTitle>
            <CardDescription>Choose a version. The newest one is usually right.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="pack-version">Version</Label>
            <Select
              id="pack-version"
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              disabled={versions.isPending}
            >
              {versions.isPending && <option>Loading versions…</option>}
              {versions.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.versionNumber} · Minecraft {x.gameVersions.join(", ")} · {x.loaders.join(", ")}
                </option>
              ))}
            </Select>
            {versions.data?.length === 0 && (
              <p className="text-xs text-destructive">This pack has no downloadable versions.</p>
            )}
          </div>
          {v?.file && (
            <p className="text-xs text-muted-foreground">Pack file: {bytes(v.file.sizeBytes)}</p>
          )}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => setPicked(null)} disabled={prepare.isPending}>
              <ArrowLeft /> Other packs
            </Button>
            <Button
              disabled={!versionId || prepare.isPending}
              onClick={() => prepare.mutate({ versionId, iconUrl: picked.iconUrl })}
            >
              {prepare.isPending ? <Loader2 className="animate-spin" /> : <Download />}
              {prepare.isPending ? "Reading the pack…" : "Continue"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search modpacks"
              placeholder="Search Modrinth modpacks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".mrpack"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading ? "Reading…" : "Upload .mrpack"}
          </Button>
        </CardContent>
      </Card>

      {results.error && <p className="text-sm text-destructive">{errorMessage(results.error)}</p>}
      {results.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Searching Modrinth…
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {results.data?.hits.map((h) => (
          <li key={h.projectId}>
            <button
              type="button"
              onClick={() =>
                setPicked({ projectId: h.projectId, title: h.title, iconUrl: h.iconUrl })
              }
              className="flex h-full w-full gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted"
            >
              <PackIcon url={h.iconUrl} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{h.title}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{h.description}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{compact(h.downloads)} downloads</span>
                  {h.loaders.map((l) => (
                    <Badge key={l} variant="outline" className="px-1.5 py-0 text-[10px]">
                      {l}
                    </Badge>
                  ))}
                  {h.gameVersions.at(-1) && <span>· {h.gameVersions.at(-1)}</span>}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {results.data && results.data.hits.length === 0 && (
        <p className="text-sm text-muted-foreground">No modpacks match that search.</p>
      )}
      <p className="text-xs text-muted-foreground">
        CurseForge packs are not supported yet. Many popular packs are also on Modrinth.
      </p>
    </div>
  );
}

function PackIcon({ url }: { url: string | null }) {
  return url ? (
    <img
      src={url}
      alt=""
      className="size-12 shrink-0 rounded-md bg-muted object-cover"
      loading="lazy"
    />
  ) : (
    <span className="grid size-12 shrink-0 place-items-center rounded-md bg-muted">
      <Package className="size-5 text-muted-foreground" />
    </span>
  );
}

function InstallForm({ preview, onBack }: { preview: Preview; onBack: () => void }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const [hostId, setHostId] = useState("local");
  const limits = useQuery(trpc.mc.limits.queryOptions({ hostId }));
  const [memory, setMemory] = useState<number | null>(null);
  const [port, setPort] = useState(25565);
  const [name, setName] = useState(preview.name.slice(0, 48));
  const [onlineMode, setOnlineMode] = useState(true);
  const [eula, setEula] = useState(false);

  const max = limits.data?.maxMemMb ?? 8192;
  const memoryMb = Math.min(memory ?? preview.suggestedMemoryMb, max);
  const tooSmall = max < preview.suggestedMemoryMb;
  const onlineHosts = hosts.data?.filter((h) => h.id === "local" || h.state === "online") ?? [];

  const install = useMutation(
    trpc.modpacks.install.mutationOptions({
      onSuccess: async (server) => {
        await queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
        toast.success(`Installing ${server.name}`);
        await navigate({ to: "/servers/$id", params: { id: server.id } });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const input = {
    packId: preview.packId,
    hostId,
    name,
    memoryMb,
    port,
    onlineMode,
    acceptEula: eula as true,
  };
  const valid = installModpackInput.safeParse(input);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          {preview.iconUrl ? (
            <PackIcon url={preview.iconUrl} />
          ) : (
            <FileArchive className="size-10 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <CardTitle>
              {preview.name}{" "}
              <span className="font-normal text-muted-foreground">{preview.version}</span>
            </CardTitle>
            {preview.summary && <CardDescription>{preview.summary}</CardDescription>}
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <Fact label="Minecraft" value={preview.mcVersion} />
            <Fact
              label="Loader"
              value={`${LOADER_LABEL[preview.software]}${preview.loaderVersion ? ` ${preview.loaderVersion}` : ""}`}
            />
            <Fact label="Server mods" value={String(preview.mods)} />
            <Fact label="Download" value={bytes(preview.downloadBytes)} />
            <Fact label="Config files" value={String(preview.overrides)} />
            <Fact label="Client-only, skipped" value={String(preview.clientOnly)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          {onlineHosts.length > 1 && (
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor="pack-host">Host</Label>
              <Select id="pack-host" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                {onlineHosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.kind === "local" ? `${h.name} (this computer)` : h.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="grid gap-1.5 sm:max-w-sm">
            <Label htmlFor="pack-name">Server name</Label>
            <Input
              id="pack-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={48}
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="pack-memory">Memory</Label>
              <span className="text-sm tabular-nums">{formatMb(memoryMb)}</span>
            </div>
            <input
              id="pack-memory"
              type="range"
              min={2048}
              max={max}
              step={512}
              value={memoryMb}
              onChange={(e) => setMemory(Number(e.target.value))}
              className="w-full accent-[var(--primary)]"
            />
            <p
              className={cn(
                "text-xs",
                tooSmall ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
              )}
            >
              {tooSmall
                ? `A pack with ${preview.mods} mods wants about ${formatMb(preview.suggestedMemoryMb)}; this host can give ${formatMb(max)}. It may run slowly or crash.`
                : `Suggested for ${preview.mods} mods: ${formatMb(preview.suggestedMemoryMb)}. Expect about ${formatMb(estimateProcessMemoryMb(memoryMb))} in use.`}
            </p>
          </div>
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="pack-port">Port</Label>
            <Input
              id="pack-port"
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pack-online">Require a Microsoft account (online mode)</Label>
            <Switch id="pack-online" checked={onlineMode} onCheckedChange={setOnlineMode} />
          </div>
          {!onlineMode && <OfflineModeWarning existingWorld={false} />}
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
              .
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={install.isPending}>
          <ArrowLeft /> Other packs
        </Button>
        <div className="flex items-center gap-3">
          {!valid.success && eula && name && (
            <p className="text-xs text-destructive">{valid.error.issues[0]?.message}</p>
          )}
          <Button
            disabled={!valid.success || install.isPending}
            onClick={() => install.mutate(input)}
          >
            {install.isPending ? <Loader2 className="animate-spin" /> : <Package />} Install modpack
          </Button>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
