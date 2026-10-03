import type { ServerStatus } from "@cubehold/shared";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Play, RotateCw, Skull, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

export function ServerActions({ serverId, status }: { serverId: string; status: ServerStatus }) {
  const trpc = useTRPC();
  const [confirmKill, setConfirmKill] = useState(false);
  const opts = {
    onError: (err: unknown) => toast.error(errorMessage(err)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() }),
  };
  const start = useMutation(trpc.servers.start.mutationOptions(opts));
  const stop = useMutation(trpc.servers.stop.mutationOptions(opts));
  const restart = useMutation(trpc.servers.restart.mutationOptions(opts));
  const kill = useMutation(trpc.servers.kill.mutationOptions(opts));
  const busy = start.isPending || stop.isPending || restart.isPending || kill.isPending;

  if (status === "installing") {
    return (
      <Button disabled>
        <Loader2 className="animate-spin" /> Installing…
      </Button>
    );
  }

  if (status === "stopped" || status === "crashed" || status === "sleeping") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => start.mutate({ serverId })} disabled={busy}>
          {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Start
        </Button>
        {/* Sleeping servers hold their port; a crashed one may have a restart pending. */}
        {status !== "stopped" && (
          <Button
            variant="secondary"
            onClick={() => stop.mutate({ serverId })}
            disabled={busy}
            title={
              status === "sleeping"
                ? "Stop waiting for players to join"
                : "Cancel an automatic restart"
            }
          >
            {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
            {status === "sleeping" ? "Stop sleeping" : "Stay stopped"}
          </Button>
        )}
      </div>
    );
  }

  const stopping = status === "stopping";
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        onClick={() => stop.mutate({ serverId })}
        disabled={busy || stopping}
      >
        {stopping || stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
        {stopping ? "Stopping…" : "Stop"}
      </Button>
      {!stopping && (
        <Button variant="outline" onClick={() => restart.mutate({ serverId })} disabled={busy}>
          {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />} Restart
        </Button>
      )}
      <Button
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirmKill(true)}
        disabled={kill.isPending}
      >
        <Skull /> Kill
      </Button>
      <Dialog
        open={confirmKill}
        onClose={() => setConfirmKill(false)}
        title="Force-kill the server?"
        description="The process ends immediately without saving. Anything since the last autosave is lost. Use Stop unless the server is stuck."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmKill(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmKill(false);
              kill.mutate({ serverId });
            }}
          >
            Kill process
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
