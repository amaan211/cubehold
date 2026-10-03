import type { BackupCategory } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderOutput, Loader2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { formatBytes } from "@/lib/utils";

interface Props {
  serverId: string;
  serverName: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Delete a server and everything it downloaded. Offers to copy worlds, mods
 * and settings to a folder first; the copy is verified before anything is
 * deleted.
 */
export function DeleteServerDialog({ serverId, serverName, open, onClose }: Props) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const plan = useQuery(
    trpc.servers.deletePlan.queryOptions({ serverId }, { enabled: open, staleTime: 0 }),
  );
  const [backup, setBackup] = useState(true);
  const [selected, setSelected] = useState<Set<BackupCategory>>(new Set());
  const [destination, setDestination] = useState("");
  const [typed, setTyped] = useState("");

  // Reset choices each time the dialog opens with a fresh plan.
  useEffect(() => {
    if (!open || !plan.data) return;
    setSelected(new Set(plan.data.categories.filter((c) => c.selected).map((c) => c.id)));
    setDestination(plan.data.defaultDestination);
    setTyped("");
    setBackup(plan.data.categories.length > 0);
  }, [open, plan.data]);

  const remove = useMutation(
    trpc.servers.remove.mutationOptions({
      onSuccess: async (res) => {
        onClose();
        await navigate({ to: "/" });
        for (const key of [
          trpc.servers.get.queryKey({ serverId }),
          trpc.servers.properties.queryKey({ serverId }),
          trpc.servers.versionInfo.queryKey({ serverId }),
          trpc.servers.deletePlan.queryKey({ serverId }),
        ]) {
          queryClient.removeQueries({ queryKey: key });
        }
        await queryClient.invalidateQueries({ queryKey: trpc.servers.list.queryKey() });
        const java = res.removedJava.length
          ? ` Removed unused Java ${res.removedJava.map((j) => j.major).join(", ")}.`
          : "";
        toast.success(
          res.exported
            ? `Deleted ${serverName}. Backup saved to ${res.exported.path}. Freed ${formatBytes(res.freedBytes)}.${java}`
            : `Deleted ${serverName}. Freed ${formatBytes(res.freedBytes)}.${java}`,
          { duration: 10_000 },
        );
      },
    }),
  );

  const p = plan.data;
  const exportBytes = useMemo(
    () => p?.categories.filter((c) => selected.has(c.id)).reduce((n, c) => n + c.sizeBytes, 0) ?? 0,
    [p, selected],
  );
  const doBackup = backup && (p?.categories.length ?? 0) > 0;
  const canSubmit =
    !!p &&
    !p.running &&
    !remove.isPending &&
    (doBackup ? selected.size > 0 && destination.trim() !== "" : typed.trim() === serverName);

  return (
    <Dialog
      open={open}
      onClose={() => !remove.isPending && onClose()}
      title={`Delete ${serverName}?`}
      description="The server, every file it downloaded, and its world snapshots are removed from this machine."
      className="max-w-lg"
    >
      {!p ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Measuring files…
        </p>
      ) : (
        <div className="space-y-5">
          {p.running && (
            <p className="rounded-md bg-amber-500/10 p-2.5 text-sm text-amber-700 dark:text-amber-300">
              Stop the server before deleting it.
            </p>
          )}

          {p.categories.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="do-backup" className="flex items-center gap-2">
                  <FolderOutput className="size-4" /> Back up before deleting
                </Label>
                <Switch id="do-backup" checked={backup} onCheckedChange={setBackup} />
              </div>
              {backup && (
                <>
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {p.categories.map((c) => (
                      <li key={c.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--primary)]"
                            checked={selected.has(c.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(c.id);
                              else next.delete(c.id);
                              setSelected(next);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm">{c.label}</span>
                            {c.paths.length > 0 && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {c.paths.join(", ")}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatBytes(c.sizeBytes)}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="grid gap-1.5">
                    <Label htmlFor="backup-dest">Save to folder</Label>
                    <Input
                      id="backup-dest"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      A new or empty folder on this machine, outside the panel's data folder.{" "}
                      {formatBytes(exportBytes)} will be copied and checked before anything is
                      deleted.
                    </p>
                  </div>
                </>
              )}
            </section>
          )}

          <section className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Trash2 className="size-4 text-destructive" /> Permanently deleted
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li className="flex justify-between gap-3">
                <span>Server folder (world, jar, libraries, logs, configs)</span>
                <span className="tabular-nums">{formatBytes(p.freed.serverFilesBytes)}</span>
              </li>
              {p.freed.snapshotsBytes > 0 && (
                <li className="flex justify-between gap-3">
                  <span>World snapshots from version changes</span>
                  <span className="tabular-nums">{formatBytes(p.freed.snapshotsBytes)}</span>
                </li>
              )}
              {p.freed.java &&
                (p.freed.java.removed ? (
                  <li className="flex justify-between gap-3">
                    <span>Java {p.freed.java.major} runtime (no other server uses it)</span>
                    <span className="tabular-nums">{formatBytes(p.freed.java.sizeBytes)}</span>
                  </li>
                ) : (
                  <li>
                    Java {p.freed.java.major} is kept: {p.freed.java.usedBy} other server
                    {p.freed.java.usedBy === 1 ? " uses" : "s use"} it.
                  </li>
                ))}
              {p.freed.assets?.removed && (
                <li className="flex justify-between gap-3">
                  <span>
                    Minecraft {p.freed.assets.version} textures (no other server uses them)
                  </span>
                  <span className="tabular-nums">{formatBytes(p.freed.assets.sizeBytes)}</span>
                </li>
              )}
            </ul>
          </section>

          {!doBackup && (
            <div className="grid gap-1.5">
              <Label htmlFor="confirm-name">
                Type <span className="font-mono">{serverName}</span> to confirm
              </Label>
              <Input
                id="confirm-name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {remove.error && (
            <p className="rounded-md bg-destructive/10 p-2.5 text-sm text-destructive" role="alert">
              {errorMessage(remove.error)}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!canSubmit}
              onClick={() =>
                remove.mutate({
                  serverId,
                  backup: doBackup ? { destination, include: [...selected] } : undefined,
                })
              }
            >
              {remove.isPending && <Loader2 className="animate-spin" />}
              {remove.isPending
                ? doBackup
                  ? "Backing up and deleting…"
                  : "Deleting…"
                : doBackup
                  ? "Back up and delete"
                  : "Delete permanently"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
