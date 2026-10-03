import { estimateJvmOverheadMb, estimateProcessMemoryMb } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { formatMb } from "@/lib/utils";

/** Name, memory, port and extra JVM arguments. */
export function GeneralCard({ serverId, disabled }: { serverId: string; disabled?: boolean }) {
  const trpc = useTRPC();
  const server = useQuery(trpc.servers.get.queryOptions({ serverId }));
  const limits = useQuery(trpc.mc.limits.queryOptions());
  const [name, setName] = useState("");
  const [memoryMb, setMemoryMb] = useState(0);
  const [port, setPort] = useState(0);
  const [jvm, setJvm] = useState("");
  const s = server.data;

  useEffect(() => {
    if (!s) return;
    setName(s.name);
    setMemoryMb(s.memoryMb);
    setPort(s.port);
    setJvm(s.extraJvmArgs.join("\n"));
  }, [s]);

  const save = useMutation(
    trpc.servers.update.mutationOptions({
      onSuccess: async (data) => {
        queryClient.setQueryData(trpc.servers.get.queryKey({ serverId }), (old) =>
          old ? { ...old, ...data } : old,
        );
        await queryClient.invalidateQueries({ queryKey: trpc.servers.pathKey() });
        toast.success(data.status === "running" ? "Saved. Restart the server to apply." : "Saved");
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  if (!s) return null;

  const jvmArgs = jvm
    .split(/\n+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const changes = {
    ...(name.trim() !== s.name ? { name: name.trim() } : {}),
    ...(memoryMb !== s.memoryMb ? { memoryMb } : {}),
    ...(port !== s.port ? { port } : {}),
    ...(jvmArgs.join("\n") !== s.extraJvmArgs.join("\n") ? { extraJvmArgs: jvmArgs } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const max = limits.data?.maxMemMb ?? 16384;

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>
          Memory, port and JVM changes apply the next time the server starts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate({ serverId, ...changes });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="g-name">Name</Label>
              <Input
                id="g-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={48}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-port">Port</Label>
              <Input
                id="g-port"
                type="number"
                min={1024}
                max={65535}
                value={port || ""}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-4">
              <Label htmlFor="g-memory">Memory (heap)</Label>
              <span className="text-sm font-medium tabular-nums">{formatMb(memoryMb)}</span>
            </div>
            <input
              id="g-memory"
              type="range"
              min={512}
              max={Math.max(max, s.memoryMb)}
              step={512}
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value))}
              className="w-full accent-[var(--primary)]"
            />
            <p className="text-xs text-muted-foreground">
              Java uses about {formatMb(estimateProcessMemoryMb(memoryMb))} in total: the heap plus
              roughly {formatMb(estimateJvmOverheadMb(memoryMb))} for itself.
              {limits.data && ` This machine has ${formatMb(limits.data.totalMemMb)}.`}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="g-jvm">Extra JVM arguments</Label>
            <textarea
              id="g-jvm"
              rows={3}
              value={jvm}
              onChange={(e) => setJvm(e.target.value)}
              placeholder={"One per line, e.g.\n-Dpaper.playerconnection.keepalive=60"}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
            <p className="text-xs text-muted-foreground">
              Added after the tuned G1 flags. Memory (-Xms/-Xmx) is set above.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!dirty}
              onClick={() => {
                setName(s.name);
                setMemoryMb(s.memoryMb);
                setPort(s.port);
                setJvm(s.extraJvmArgs.join("\n"));
              }}
            >
              Discard
            </Button>
            <Button type="submit" disabled={!dirty || save.isPending || disabled}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
