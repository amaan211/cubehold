import type { BackupInfo, BackupScope } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, ArchiveRestore, Download, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { formatBytes, formatDate } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/backups")({
  component: Backups,
});

const KIND_LABEL: Record<BackupInfo["kind"], string> = {
  manual: "manual",
  scheduled: "scheduled",
  "pre-restore": "before restore",
};

function Backups() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const live = useServerLive(id);
  const server = useQuery(trpc.servers.get.queryOptions({ serverId: id }));
  const creating = live.tasks.some((t) => t.kind === "backup");
  const list = useQuery(
    trpc.backups.list.queryOptions(
      { serverId: id },
      { refetchInterval: creating ? 2_000 : 30_000 },
    ),
  );
  const [scope, setScope] = useState<BackupScope>("full");
  const [label, setLabel] = useState("");
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState<BackupInfo | null>(null);
  const [keep, setKeep] = useState<number | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.backups.pathKey() });
  const create = useMutation(
    trpc.backups.create.mutationOptions({
      onSuccess: () => {
        setLabel("");
        void invalidate();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const remove = useMutation(
    trpc.backups.remove.mutationOptions({
      onSuccess: () => {
        setDeleting(null);
        toast.success("Backup deleted");
        void invalidate();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const saveKeep = useMutation(
    trpc.servers.update.mutationOptions({
      onSuccess: () => {
        toast.success("Retention saved");
        void invalidate();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  useEffect(() => {
    if (list.data && keep === null) setKeep(list.data.keep);
  }, [list.data, keep]);

  const backups = list.data?.backups ?? [];
  const busy = live.status === "installing" || live.tasks.some((t) => t.kind === "restore");
  const backupTask = live.tasks.find((t) => t.kind === "backup");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Back up now</CardTitle>
          <CardDescription>
            A running server keeps running: saving pauses for a moment while the world is copied.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-[12rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ serverId: id, scope, label: label.trim() || undefined });
            }}
          >
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as BackupScope)}
              aria-label="What to back up"
            >
              <option value="full">Everything</option>
              <option value="world">World only</option>
            </Select>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional), e.g. before the update"
              maxLength={80}
              aria-label="Label"
            />
            <Button type="submit" disabled={create.isPending || creating || busy}>
              {create.isPending || creating ? <Loader2 className="animate-spin" /> : <Plus />} Back
              up
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            {scope === "full"
              ? "Worlds, plugins or mods and their configs, server settings and player lists. Not included: the server jar, libraries and logs, which are downloaded again."
              : "Just the world folders (overworld, nether, end)."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <CardTitle>Backups</CardTitle>
              <CardDescription>
                {backups.length} backup{backups.length === 1 ? "" : "s"} ·{" "}
                {formatBytes(list.data?.totalBytes ?? 0)} on this machine
              </CardDescription>
            </div>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (keep) saveKeep.mutate({ serverId: id, backupKeep: keep });
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="keep" className="text-xs text-muted-foreground">
                  Keep automatic backups
                </Label>
                <Input
                  id="keep"
                  type="number"
                  min={1}
                  max={200}
                  className="w-24"
                  value={keep ?? ""}
                  onChange={(e) => setKeep(Number(e.target.value) || null)}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!keep || keep === list.data?.keep || saveKeep.isPending}
              >
                Save
              </Button>
            </form>
          </div>
          <p className="text-xs text-muted-foreground">
            Scheduled backups and the safety copies taken before a restore are pruned to the newest{" "}
            {list.data?.keep ?? 10}. Backups you make here are kept until you delete them.
          </p>
        </CardHeader>
        <CardContent>
          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No backups yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {backups.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {b.label ?? formatDate(b.createdAt)}
                      <Badge variant="outline">{KIND_LABEL[b.kind]}</Badge>
                      {b.scope === "world" && <Badge variant="outline">world only</Badge>}
                      {b.state === "failed" && <Badge variant="danger">failed</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {b.label ? `${formatDate(b.createdAt)} · ` : ""}
                      {b.state === "creating"
                        ? `Writing… ${backupTask?.percent != null ? `${backupTask.percent}%` : ""}`
                        : b.state === "failed"
                          ? b.error
                          : `${formatBytes(b.sizeBytes ?? 0)} · ${b.files ?? 0} files`}
                      {b.mcVersion ? ` · Minecraft ${b.mcVersion}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {b.state === "ready" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setRestoring(b)}
                          disabled={busy}
                        >
                          <ArchiveRestore /> Restore
                        </Button>
                        <Button size="icon" variant="ghost" className="size-8" asChild>
                          <a
                            href={`/api/servers/${id}/backups/${b.id}/download`}
                            download
                            title="Download"
                            aria-label="Download backup"
                          >
                            <Download />
                          </a>
                        </Button>
                      </>
                    )}
                    {b.state !== "creating" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 hover:text-destructive"
                        title="Delete"
                        aria-label="Delete backup"
                        onClick={() => setDeleting(b)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <RestoreDialog
        serverId={id}
        backup={restoring}
        currentVersion={server.data?.mcVersion ?? null}
        running={live.status === "running" || live.status === "starting"}
        onClose={() => setRestoring(null)}
      />
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this backup?"
        description={
          deleting
            ? `${deleting.label ?? formatDate(deleting.createdAt)} · ${formatBytes(deleting.sizeBytes ?? 0)}`
            : ""
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => deleting && remove.mutate({ serverId: id, backupId: deleting.id })}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function RestoreDialog({
  serverId,
  backup,
  currentVersion,
  running,
  onClose,
}: {
  serverId: string;
  backup: BackupInfo | null;
  currentVersion: string | null;
  running: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const [safety, setSafety] = useState(true);
  const [startAfter, setStartAfter] = useState(true);
  const restore = useMutation(
    trpc.backups.restore.mutationOptions({
      onSuccess: () => {
        toast.info("Restoring… progress shows at the top of the page.");
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  if (!backup) return null;
  const versionMismatch = backup.mcVersion && currentVersion && backup.mcVersion !== currentVersion;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Restore this backup?"
      description={`${backup.label ?? formatDate(backup.createdAt)} · ${backup.scope === "world" ? "world only" : "everything"}`}
      className="max-w-lg"
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          {backup.scope === "world"
            ? "The current world folders are replaced with the ones in this backup."
            : "Worlds, plugins or mods, configs and player lists are replaced with the ones in this backup. The server jar and logs are kept."}
          {running && " The server is stopped first and started again afterwards."}
        </p>
        {versionMismatch && (
          <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            This backup was made on Minecraft {backup.mcVersion}; the server now runs{" "}
            {currentVersion}. An older world is upgraded when loaded; a world from a newer version
            may not load.
          </p>
        )}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={safety}
            onChange={(e) => setSafety(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Back up the current files first
            <span className="block text-xs text-muted-foreground">
              So you can undo this restore.
            </span>
          </span>
        </label>
        {!running && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={startAfter}
              onChange={(e) => setStartAfter(e.target.checked)}
            />
            Start the server when done
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate({
                serverId,
                backupId: backup.id,
                safetyBackup: safety,
                startAfter: !running && startAfter,
              })
            }
          >
            {restore.isPending && <Loader2 className="animate-spin" />} Restore
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
