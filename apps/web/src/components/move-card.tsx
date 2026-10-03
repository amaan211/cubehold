import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightLeft, Laptop, Loader2, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { formatMb } from "@/lib/utils";

/** Which host runs the server, and moving it to another one. */
export function MoveCard({ serverId, disabled }: { serverId: string; disabled: boolean }) {
  const trpc = useTRPC();
  const server = useQuery(trpc.servers.get.queryOptions({ serverId }));
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const [open, setOpen] = useState(false);
  const s = server.data;
  if (!s || !hosts.data) return null;
  const current = hosts.data.find((h) => h.id === s.hostId);
  const targets = hosts.data.filter((h) => h.id !== s.hostId);
  const Icon = current?.kind === "local" ? Laptop : TerminalSquare;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Host</CardTitle>
        <CardDescription>
          The machine that runs this server. Moving takes the world, settings, player history,
          schedules and backups along.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {current?.name ?? s.hostId}
          <span className="text-muted-foreground">
            {current?.kind === "local"
              ? "(this computer)"
              : current?.address
                ? `(${current.address})`
                : ""}
          </span>
        </span>
        {targets.length > 0 ? (
          <Button variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
            <ArrowRightLeft /> Move to another host
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link to="/hosts/new">Add a VPS to move it to</Link>
          </Button>
        )}
      </CardContent>
      {open && (
        <MoveDialog
          serverId={serverId}
          name={s.name}
          port={s.port}
          memoryMb={s.memoryMb}
          targets={targets}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

function MoveDialog({
  serverId,
  name,
  port: currentPort,
  memoryMb,
  targets,
  onClose,
}: {
  serverId: string;
  name: string;
  port: number;
  memoryMb: number;
  targets: Array<{
    id: string;
    name: string;
    state: string;
    kind: string;
    totalMemMb: number | null;
    diskFreeMb: number | null;
  }>;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const online = targets.filter((t) => t.state === "online");
  const [hostId, setHostId] = useState(online[0]?.id ?? "");
  const [port, setPort] = useState(currentPort);
  const [includeBackups, setIncludeBackups] = useState(true);
  const move = useMutation(
    trpc.servers.move.mutationOptions({
      onSuccess: () => {
        toast.message(`Moving ${name}. Progress shows at the top of the page.`);
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const target = targets.find((t) => t.id === hostId);
  return (
    <Dialog open onClose={onClose} title={`Move ${name}`}>
      <div className="space-y-4 text-sm">
        {online.length === 0 ? (
          <p className="text-muted-foreground">No other host is online right now.</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="move-host">To</Label>
              <Select id="move-host" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.state !== "online"}>
                    {t.name}
                    {t.kind === "local" ? " (this computer)" : ""}
                    {t.state !== "online" ? ` (${t.state})` : ""}
                  </option>
                ))}
              </Select>
              {target?.totalMemMb != null && (
                <p className="text-xs text-muted-foreground">
                  {formatMb(target.totalMemMb)} memory
                  {target.diskFreeMb != null ? `, ${formatMb(target.diskFreeMb)} free disk` : ""}.
                  This server uses a {formatMb(memoryMb)} heap.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="move-port">Port there</Label>
              <Input
                id="move-port"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="move-backups">Bring backups along</Label>
              <Switch
                id="move-backups"
                checked={includeBackups}
                onCheckedChange={setIncludeBackups}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The server stops, its files are copied and counted, and only then does it switch
              hosts; the old copy is deleted last. If it was running, it starts again on the new
              host. Players need the new address afterwards.
              {!includeBackups && " Backups left behind are deleted with the old copy."}
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!hostId || move.isPending || online.length === 0}
            onClick={() => move.mutate({ serverId, hostId, port, includeBackups })}
          >
            {move.isPending && <Loader2 className="animate-spin" />} Move
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
