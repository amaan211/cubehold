import type { ServerAutomation } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CloudOff, Moon, RotateCw, Timer } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

const IDLE_OPTIONS = [0, 5, 10, 15, 30, 60, 120];

/**
 * Crash restarts, idle stop and wake-on-join. The agent applies these right
 * away, even to a running server, and keeps doing so with the panel closed.
 */
export function AutomationCard({ serverId, disabled }: { serverId: string; disabled?: boolean }) {
  const trpc = useTRPC();
  const server = useQuery(trpc.servers.get.queryOptions({ serverId }));
  const hosts = useQuery(trpc.hosts.list.queryOptions());
  const cloud = hosts.data?.find((h) => h.id === server.data?.hostId)?.cloud ?? null;
  const save = useMutation(
    trpc.servers.update.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(trpc.servers.get.queryKey({ serverId }), (old) =>
          old ? { ...old, ...data } : old,
        );
        toast.success("Saved");
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const a = server.data?.automation;
  if (!a) return null;
  const set = (patch: Partial<ServerAutomation>) => save.mutate({ serverId, automation: patch });
  const busy = disabled || save.isPending;
  const vmDown = !!cloud && a.vmIdle !== "keep";
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cloud?.price.currency ?? "USD",
    }).format(n);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
        <CardDescription>
          Applies immediately and keeps working while the panel is closed.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        <Row
          icon={<RotateCw className="size-4" />}
          id="auto-restart"
          label="Restart after a crash"
          description="Up to 3 times in 10 minutes, waiting 10 s, 30 s, then 60 s. Not for problems a restart cannot fix, like a taken port."
        >
          <Switch
            id="auto-restart"
            checked={a.autoRestart}
            disabled={busy}
            onCheckedChange={(v) => set({ autoRestart: v })}
          />
        </Row>
        <Row
          icon={<Timer className="size-4" />}
          id="idle-stop"
          label="Stop when nobody plays"
          description="Saves CPU and memory (and money, on a cloud machine) while the server is empty."
        >
          <Select
            id="idle-stop"
            className="w-40"
            value={String(a.idleStopMinutes)}
            disabled={busy}
            onChange={(e) => set({ idleStopMinutes: Number(e.target.value) })}
          >
            {IDLE_OPTIONS.includes(a.idleStopMinutes) ? null : (
              <option value={a.idleStopMinutes}>after {a.idleStopMinutes} min</option>
            )}
            {IDLE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Never" : m < 60 ? `after ${m} min` : `after ${m / 60} h`}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          icon={<Moon className="size-4" />}
          id="wake"
          label="Start when a player joins"
          description={
            a.idleStopMinutes > 0
              ? "After an idle stop the server shows as sleeping in the server list. The first player to join starts it and reconnects about 30 seconds later."
              : "Works together with stopping when nobody plays."
          }
        >
          <Switch
            id="wake"
            checked={a.wakeOnJoin && a.idleStopMinutes > 0 && !vmDown}
            disabled={busy || a.idleStopMinutes === 0 || vmDown}
            onCheckedChange={(v) => set({ wakeOnJoin: v })}
          />
        </Row>
        {cloud && (
          <Row
            icon={<CloudOff className="size-4" />}
            id="vm-idle"
            label="Then turn the VM off"
            description={
              a.idleStopMinutes === 0
                ? "Works together with stopping when nobody plays."
                : a.vmIdle === "hibernate"
                  ? `Once no server here runs, the VM is saved as a snapshot and deleted: it costs only storage (${money(cloud.snapshotPerGbMonth)} per GB a month) until you press Start, which restores it in 2 to 5 minutes at a new address.`
                  : a.vmIdle === "stop"
                    ? `Once no server here runs, the VM is stopped: ${cloud.providerLabel} then only bills its disk. Start boots it again in about a minute; players cannot wake it by joining.`
                    : cloud.stopSavesMoney
                      ? "The VM keeps running (and billing) while the server sleeps."
                      : `${cloud.providerLabel} bills a stopped VM in full, so saving it as a snapshot is what saves money.`
            }
          >
            <Select
              id="vm-idle"
              className="w-44"
              value={a.vmIdle}
              disabled={busy || a.idleStopMinutes === 0}
              onChange={(e) => set({ vmIdle: e.target.value as ServerAutomation["vmIdle"] })}
            >
              {cloud.idleModes.map((m) => (
                <option key={m} value={m}>
                  {m === "keep"
                    ? "Keep it running"
                    : m === "stop"
                      ? "Stop the VM"
                      : "Save and delete"}
                </option>
              ))}
            </Select>
          </Row>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  icon,
  id,
  label,
  description,
  children,
}: {
  icon: React.ReactNode;
  id: string;
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex gap-3">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div>
          <Label htmlFor={id}>{label}</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
