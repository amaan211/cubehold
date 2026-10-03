import type { DowngradeWorldAction } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownCircle, ArrowUpCircle, History, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatBytes, formatDate } from "@/lib/utils";

const SOFTWARE_LABEL: Record<string, string> = {
  paper: "Paper",
  vanilla: "Vanilla",
  fabric: "Fabric",
  purpur: "Purpur",
  forge: "Forge",
  neoforge: "NeoForge",
};

/** Upgrade or downgrade Minecraft; Java and server files are handled by the panel. */
export function VersionCard({ serverId }: { serverId: string }) {
  const trpc = useTRPC();
  const live = useServerLive(serverId);
  const info = useQuery(trpc.servers.versionInfo.queryOptions({ serverId }));
  const [prereleases, setPrereleases] = useState(false);
  const [target, setTarget] = useState("");
  const [worldAction, setWorldAction] = useState<DowngradeWorldAction>("restore");

  const software = info.data?.software ?? "paper";
  const versions = useQuery(
    trpc.mc.versions.queryOptions(
      { software, includeSnapshots: prereleases },
      { enabled: !!info.data, staleTime: 5 * 60_000 },
    ),
  );
  const current = info.data?.mcVersion;
  const choosing = !!target && target !== current;
  const preview = useQuery(
    trpc.servers.previewVersionChange.queryOptions(
      { serverId, mcVersion: target },
      { enabled: choosing, staleTime: 30_000 },
    ),
  );
  const p = preview.data;

  useEffect(() => {
    if (p?.direction === "downgrade") setWorldAction(p.restoreSnapshot ? "restore" : "keep");
  }, [p?.direction, p?.restoreSnapshot]);

  // Refresh once a background change finishes.
  const busy = live.status === "installing";
  useEffect(() => {
    if (!busy) {
      void queryClient.invalidateQueries({
        queryKey: trpc.servers.versionInfo.queryKey({ serverId }),
      });
    }
  }, [busy, serverId, trpc]);

  const change = useMutation(
    trpc.servers.changeVersion.mutationOptions({
      onSuccess: async () => {
        toast.success(`Switching to ${target}. Progress shows at the top of the page.`);
        setTarget("");
        await queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  if (!info.data) return null;
  const snapshots = info.data.snapshots;
  const downgrade = p?.direction === "downgrade";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Minecraft version</CardTitle>
        <CardDescription>
          Move to any {SOFTWARE_LABEL[software]} version, newer or older. The right Java runtime and
          server files are downloaded for you, and the world is snapshotted first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Running</span>
          <Badge variant="outline">
            {SOFTWARE_LABEL[software]} {current}
          </Badge>
          <Badge variant="outline">Java {info.data.javaVersion || "…"}</Badge>
          {busy && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Changing…
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="target-version">Switch to</Label>
            <Select
              id="target-version"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy || versions.isPending}
            >
              <option value="">
                {versions.isPending ? "Loading versions…" : "Choose a version"}
              </option>
              {versions.data?.map((v) => (
                <option key={v.id} value={v.id} disabled={v.id === current}>
                  {v.id}
                  {v.id === current ? " (current)" : ""}
                  {v.kind === "snapshot" ? " (pre-release)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch id="show-pre" checked={prereleases} onCheckedChange={setPrereleases} />
            <Label htmlFor="show-pre" className="font-normal text-muted-foreground">
              Pre-releases
            </Label>
          </div>
        </div>

        {choosing && preview.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking {target}…
          </p>
        )}
        {preview.error && <p className="text-sm text-destructive">{errorMessage(preview.error)}</p>}

        {choosing && p && p.direction !== "same" && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              {downgrade ? (
                <ArrowDownCircle className="size-4 text-amber-500" />
              ) : (
                <ArrowUpCircle className="size-4 text-primary" />
              )}
              {downgrade ? "Downgrade" : "Upgrade"} from {p.from} to {p.to}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
              <li>
                {p.toJava === p.fromJava
                  ? `Keeps using Java ${p.toJava}.`
                  : `Switches from Java ${p.fromJava} to Java ${p.toJava}${p.javaDownloadNeeded ? ", downloaded automatically" : ""}. Runtimes no server uses any more are deleted.`}
              </li>
              <li>
                The current world is saved as a snapshot tagged {p.from} before anything changes.
              </li>
              <li>Plugins and mods are left as they are; check they support {p.to}.</li>
              {p.running && <li>The server stops, switches, and starts again on its own.</li>}
            </ul>

            {downgrade && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium">What happens to the world?</legend>
                <WorldOption
                  value="restore"
                  current={worldAction}
                  onChange={setWorldAction}
                  disabled={!p.restoreSnapshot}
                  title={
                    p.restoreSnapshot
                      ? `Restore the world saved on ${p.to} (${formatDate(p.restoreSnapshot.createdAt)})`
                      : `Restore a world saved on ${p.to}`
                  }
                  detail={
                    p.restoreSnapshot
                      ? "Safest. Everything built since then stays in the snapshot being taken now."
                      : `There is no snapshot from ${p.to} for this server.`
                  }
                />
                <WorldOption
                  value="keep"
                  current={worldAction}
                  onChange={setWorldAction}
                  title="Keep the current world"
                  detail={`Minecraft does not support opening a world in an older version. ${p.to} may refuse to load it or lose chunks. The snapshot lets you undo this.`}
                />
                <WorldOption
                  value="fresh"
                  current={worldAction}
                  onChange={setWorldAction}
                  title="Start a new world"
                  detail="The current world is kept in the snapshot."
                />
              </fieldset>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTarget("")}>
                Cancel
              </Button>
              <Button
                variant={downgrade && worldAction === "keep" ? "destructive" : "default"}
                disabled={busy || change.isPending}
                onClick={() =>
                  change.mutate({
                    serverId,
                    mcVersion: p.to,
                    worldAction: downgrade ? worldAction : undefined,
                  })
                }
              >
                {change.isPending && <Loader2 className="animate-spin" />}
                {downgrade ? "Downgrade" : "Upgrade"} to {p.to}
              </Button>
            </div>
          </div>
        )}

        {info.data.lastError && !busy && (
          <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            Last version change failed: {info.data.lastError}
          </p>
        )}

        {snapshots.length > 0 && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <History className="size-3.5" /> World snapshots from version changes
            </p>
            <ul className="divide-y divide-border rounded-md border border-border text-sm">
              {snapshots.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span>
                    {s.mcVersion}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatDate(s.createdAt)}
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatBytes(s.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              The newest snapshot per version is kept, up to five. They are deleted with the server.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorldOption({
  value,
  current,
  onChange,
  title,
  detail,
  disabled,
}: {
  value: DowngradeWorldAction;
  current: DowngradeWorldAction;
  onChange: (v: DowngradeWorldAction) => void;
  title: string;
  detail: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border p-2.5",
        current === value ? "border-primary bg-accent/50" : "border-border",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="radio"
        name="world-action"
        className="mt-1 accent-[var(--primary)]"
        checked={current === value}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>
        <span className="block text-sm">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}
