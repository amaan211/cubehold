import type { AddonSource } from "@cubehold/shared";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowUpCircle,
  Check,
  Download,
  ExternalLink,
  Loader2,
  Package,
  Search,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, trpcClient, useTRPC } from "@/lib/trpc";
import { cn, formatBytes } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/addons")({
  component: Addons,
});

const SOURCE_LABEL: Record<AddonSource, string> = {
  modrinth: "Modrinth",
  hangar: "Hangar",
  geysermc: "GeyserMC",
};

function compact(n: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function AddonIcon({ url, className }: { url: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-md bg-muted text-muted-foreground",
          className,
        )}
      >
        <Package className="size-1/2" />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={cn("shrink-0 rounded-md object-cover", className)}
      onError={() => setBroken(true)}
    />
  );
}

function Addons() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const info = useQuery(trpc.addons.info.queryOptions({ serverId: id }));
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const platform = info.data?.platform;
  if (info.error) return <p className="text-sm text-destructive">{errorMessage(info.error)}</p>;
  if (!info.data) return null;
  if (!platform) {
    return (
      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Vanilla servers cannot load plugins or mods. Create a Paper, Purpur or Fabric server for
        that.
      </p>
    );
  }
  const noun = platform.kind === "plugin" ? "plugins" : "mods";

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-border p-0.5" role="tablist">
        {(["installed", "browse"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              tab === t
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "installed" ? `Installed ${noun}` : `Find ${noun}`}
          </button>
        ))}
      </div>
      {tab === "installed" ? (
        <Installed serverId={id} noun={noun} onBrowse={() => setTab("browse")} />
      ) : (
        <Browse
          serverId={id}
          hangar={platform.hangar}
          noun={noun}
          mcVersion={info.data.mcVersion}
        />
      )}
    </div>
  );
}

function Installed({
  serverId,
  noun,
  onBrowse,
}: {
  serverId: string;
  noun: string;
  onBrowse: () => void;
}) {
  const trpc = useTRPC();
  const live = useServerLive(serverId);
  const running =
    live.status === "running" || live.status === "starting" || live.status === "stopping";
  const list = useQuery(trpc.addons.installed.queryOptions({ serverId, checkUpdates: true }));
  const [removing, setRemoving] = useState<{ file: string; name: string; plugin: boolean } | null>(
    null,
  );
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: trpc.addons.installed.queryKey() });
  const onError = (err: unknown) => toast.error(errorMessage(err));
  const toggle = useMutation(
    trpc.addons.toggle.mutationOptions({ onSuccess: invalidate, onError }),
  );
  const update = useMutation(
    trpc.addons.update.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Updated to ${r.version}`);
        void invalidate();
      },
      onError,
    }),
  );

  if (list.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking installed {noun}…
      </p>
    );
  }
  if (list.error) return <p className="text-sm text-destructive">{errorMessage(list.error)}</p>;
  const items = list.data?.items ?? [];
  const updates = items.filter((i) => i.update).length;

  return (
    <div className="space-y-3">
      {running && (
        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          The server is running. New {noun} load after a restart; stop the server to update, disable
          or remove {noun}.
        </p>
      )}
      {list.data?.offline && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <WifiOff className="size-3.5" /> Modrinth is unreachable; names come from the files and
          updates are not checked.
        </p>
      )}
      {updates > 0 && (
        <p className="text-sm">
          <ArrowUpCircle className="mr-1 inline size-4 text-primary" />
          {updates} update{updates === 1 ? "" : "s"} available
        </p>
      )}
      <Card>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground">
              No {noun} installed yet.
              <Button variant="outline" onClick={onBrowse}>
                <Search /> Find {noun}
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((i) => (
                <li
                  key={i.file}
                  className={cn(
                    "flex flex-wrap items-center gap-3 p-3",
                    !i.enabled && "opacity-60",
                  )}
                >
                  <AddonIcon url={i.iconUrl} className="size-10" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {i.pageUrl ? (
                        <a
                          href={i.pageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {i.name}
                        </a>
                      ) : (
                        i.name
                      )}
                      {i.version && (
                        <span className="font-normal text-muted-foreground">{i.version}</span>
                      )}
                      {i.source && <Badge variant="outline">{SOURCE_LABEL[i.source]}</Badge>}
                      {!i.enabled && <Badge variant="outline">disabled</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={i.file}>
                      {i.description ?? i.file} · {formatBytes(i.sizeBytes)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {i.update && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={running || update.isPending}
                        title={running ? "Stop the server to update" : undefined}
                        onClick={() => update.mutate({ serverId, file: i.file })}
                      >
                        {update.isPending && update.variables?.file === i.file ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ArrowUpCircle />
                        )}
                        {i.update.versionName}
                      </Button>
                    )}
                    <Switch
                      checked={i.enabled}
                      disabled={running || toggle.isPending}
                      aria-label={i.enabled ? `Disable ${i.name}` : `Enable ${i.name}`}
                      onCheckedChange={(enabled) =>
                        toggle.mutate({ serverId, file: i.file, enabled })
                      }
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 hover:text-destructive"
                      disabled={running}
                      title={running ? "Stop the server to remove" : "Remove"}
                      aria-label={`Remove ${i.name}`}
                      onClick={() =>
                        setRemoving({ file: i.file, name: i.name, plugin: noun === "plugins" })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {removing && (
        <RemoveDialog serverId={serverId} target={removing} onClose={() => setRemoving(null)} />
      )}
    </div>
  );
}

function RemoveDialog({
  serverId,
  target,
  onClose,
}: {
  serverId: string;
  target: { file: string; name: string; plugin: boolean };
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const [deleteConfig, setDeleteConfig] = useState(false);
  const remove = useMutation(
    trpc.addons.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`Removed ${target.name}`);
        void queryClient.invalidateQueries({ queryKey: trpc.addons.installed.queryKey() });
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  return (
    <Dialog open onClose={onClose} title={`Remove ${target.name}?`} description={target.file}>
      <div className="space-y-4 text-sm">
        {target.plugin && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={deleteConfig}
              onChange={(e) => setDeleteConfig(e.target.checked)}
            />
            <span>
              Also delete its settings and data
              <span className="block text-xs text-muted-foreground">
                The plugin's folder under plugins/. Leave this off to keep them for a reinstall.
              </span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ serverId, file: target.file, deleteConfig })}
          >
            Remove
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Browse({
  serverId,
  hangar,
  noun,
  mcVersion,
}: {
  serverId: string;
  hangar: boolean;
  noun: string;
  mcVersion: string;
}) {
  const trpc = useTRPC();
  const [source, setSource] = useState<AddonSource>("modrinth");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const results = useInfiniteQuery({
    queryKey: ["addons.search", serverId, source, query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      trpcClient.addons.search.query({ serverId, source, query, offset: pageParam }),
    getNextPageParam: (last) =>
      last.offset + last.limit < last.total ? last.offset + last.limit : undefined,
    staleTime: 60_000,
  });
  const installed = useQuery(trpc.addons.installed.queryOptions({ serverId, checkUpdates: false }));
  const have = new Set((installed.data?.items ?? []).map((i) => i.projectId).filter(Boolean));
  const install = useMutation(
    trpc.addons.install.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Installed ${r.installed.join(", ")}`);
        for (const note of r.notes) toast.info(note);
        void queryClient.invalidateQueries({ queryKey: trpc.addons.installed.queryKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const hits = results.data?.pages.flatMap((p) => p.hits) ?? [];
  const total = results.data?.pages[0]?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={`Search ${noun} for Minecraft ${mcVersion}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={`Search ${noun}`}
          />
        </div>
        {hangar && (
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {(["modrinth", "hangar"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                aria-pressed={source === s}
                className={cn(
                  "rounded-md px-3 py-1 text-sm",
                  source === s
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s === "modrinth" ? "Modrinth" : "Hangar"}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {results.isLoading
          ? "Searching…"
          : `${compact(total)} ${noun} for Minecraft ${mcVersion}${query ? ` matching "${query}"` : ", most downloaded first"}. Required dependencies are installed too.`}
      </p>
      {results.error && <p className="text-sm text-destructive">{errorMessage(results.error)}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {hits.map((h) => {
          const isInstalled = have.has(h.projectId);
          const pending = install.isPending && install.variables?.projectId === h.projectId;
          return (
            <Card key={`${h.source}-${h.projectId}`} className="flex gap-3 p-3">
              <AddonIcon url={h.iconUrl} className="size-12" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <a
                      href={h.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                    >
                      <span className="truncate">{h.title}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                    </a>
                    <p className="text-xs text-muted-foreground">
                      by {h.author} · <Download className="inline size-3" /> {compact(h.downloads)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={isInstalled ? "ghost" : "outline"}
                    disabled={isInstalled || install.isPending}
                    onClick={() =>
                      install.mutate({
                        serverId,
                        source: h.source,
                        projectId: h.projectId,
                        withDependencies: true,
                      })
                    }
                  >
                    {pending ? (
                      <Loader2 className="animate-spin" />
                    ) : isInstalled ? (
                      <Check />
                    ) : (
                      <Download />
                    )}
                    {isInstalled ? "Installed" : "Install"}
                  </Button>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">{h.description}</p>
              </div>
            </Card>
          );
        })}
      </div>
      {results.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void results.fetchNextPage()}
            disabled={results.isFetchingNextPage}
          >
            {results.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
          </Button>
        </div>
      )}
    </div>
  );
}
