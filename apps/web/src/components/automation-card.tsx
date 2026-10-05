import { alwaysOnMonthly, hourlyRate } from "@cubehold/providers/pricing";
import { CLOUD_IDLE_STOP_MINUTES, type ServerAutomation } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CloudOff, Moon, PiggyBank, RotateCw, Timer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { formatMoney } from "@/lib/utils";

const IDLE_OPTIONS = [0, 5, 10, 15, 30, 60, 120];

const VM_CHOICE: Record<ServerAutomation["vmIdle"], string> = {
  keep: "Keep it running",
  hibernate: "Delete it, keep a snapshot",
  stop: "Stop it, keep its disk",
};

/**
 * Crash restarts, idle stop and wake-on-join, and on a cloud VM what happens
 * to the VM. The agent applies these right away, even to a running server,
 * and keeps doing so with the panel closed.
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

  const cur = cloud?.price.currency ?? "USD";
  const listed = cloud && {
    priceHourly: cloud.price.hourly,
    priceMonthly: cloud.price.monthly,
    diskGb: cloud.size.diskGb,
    noMonthlyCap: cloud.size.noMonthlyCap,
  };
  const perHour =
    cloud && listed ? formatMoney(hourlyRate(cloud.provider, listed, "running"), cur) : "";
  const perMonth = cloud && listed ? formatMoney(alwaysOnMonthly(cloud.provider, listed), cur) : "";
  const savingMode = cloud?.idleModes.find((m) => m !== "keep") ?? "keep";
  const saving = !!cloud && a.idleStopMinutes > 0 && a.vmIdle !== "keep";

  const vmText = !cloud
    ? ""
    : a.idleStopMinutes === 0
      ? "Applies once the server stops when nobody is online (above)."
      : a.vmIdle === "hibernate"
        ? `2 minutes after the last server on this VM stops, cubehold saves the VM's disk as a snapshot and then deletes the VM. Until the server starts again you pay only for the snapshot (${formatMoney(cloud.snapshotPerGbMonth, cur)} per GB a month) instead of ${perHour} an hour. Your worlds are in the snapshot: Start makes a new VM from it in 2 to 5 minutes, usually at a new IP address.`
        : a.vmIdle === "stop"
          ? `2 minutes after the last server on this VM stops, cubehold shuts the VM down without deleting it. ${cloud.providerLabel} then bills only its disk. Start boots it again in about a minute, usually at a new IP address.`
          : cloud.stopSavesMoney
            ? `The VM keeps running, and billing ${perHour} an hour, while nobody plays.`
            : `The VM keeps running, and billing ${perHour} an hour, while nobody plays. ${cloud.providerLabel} bills a stopped VM in full, so deleting it and keeping a snapshot is what saves money.`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
        <CardDescription>
          Applies immediately and keeps working while the panel is closed.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {cloud && !saving && (
          <div className="mb-3 flex flex-col gap-3 rounded-lg bg-muted/60 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="flex gap-2">
              <PiggyBank className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>
                This server's VM runs all the time, about {perMonth} a month. The money-saving
                settings stop the server after {CLOUD_IDLE_STOP_MINUTES} minutes with nobody online
                and then{" "}
                {savingMode === "hibernate" ? "delete the VM, keeping a snapshot" : "stop the VM"}.
              </span>
            </p>
            <Button
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => set({ idleStopMinutes: CLOUD_IDLE_STOP_MINUTES, vmIdle: savingMode })}
            >
              Use the money-saving settings
            </Button>
          </div>
        )}
        <Row
          icon={<RotateCw className="size-4" />}
          id="auto-restart"
          label="Restart the server after a crash"
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
          label="Stop the server when nobody is online"
          description={
            cloud
              ? "The Minecraft server stops after this long with no players. What then happens to the VM is set below."
              : "The Minecraft server stops after this long with no players, freeing CPU and memory."
          }
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
          label="Start the server when a player joins"
          description={
            vmDown
              ? "Not possible while the VM is down: nothing is left to answer the player. Start the server from the panel instead."
              : a.idleStopMinutes > 0
                ? "After an idle stop the server shows as sleeping in the server list. The first player to join starts it and reconnects about 30 seconds later."
                : "Works together with stopping when nobody is online."
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
            label="What happens to the VM"
            description={vmText}
          >
            <Select
              id="vm-idle"
              className="w-52"
              value={a.vmIdle}
              disabled={busy || a.idleStopMinutes === 0}
              onChange={(e) => set({ vmIdle: e.target.value as ServerAutomation["vmIdle"] })}
            >
              {cloud.idleModes.map((m) => (
                <option key={m} value={m}>
                  {VM_CHOICE[m]}
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
