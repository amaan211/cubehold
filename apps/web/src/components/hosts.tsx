import { alwaysOnMonthly, hourlyRate } from "@cubehold/providers/pricing";
import type { HostHardenAction } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { inferOutput } from "@trpc/tanstack-react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleSlash,
  Cloud,
  HardDrive,
  KeyRound,
  Loader2,
  MemoryStick,
  MinusCircle,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Address } from "@/components/network";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatDuration, formatMb, formatMoney, timeAgo } from "@/lib/utils";

type Trpc = ReturnType<typeof useTRPC>;
export type HostView = inferOutput<Trpc["hosts"]["list"]>[number];
export type HostJob = NonNullable<inferOutput<Trpc["hosts"]["job"]>>;

const stateBadge: Record<
  HostView["state"],
  { label: string; variant: "success" | "warning" | "danger" | "outline" }
> = {
  online: { label: "online", variant: "success" },
  connecting: { label: "connecting", variant: "outline" },
  offline: { label: "offline", variant: "danger" },
  "agent-down": { label: "agent not running", variant: "danger" },
  locked: { label: "locked", variant: "warning" },
  error: { label: "cannot connect", variant: "danger" },
  "setting-up": { label: "setting up", variant: "outline" },
  "setup-failed": { label: "setup failed", variant: "danger" },
  creating: { label: "creating VM", variant: "outline" },
  "vm-starting": { label: "starting VM", variant: "outline" },
  "vm-stopping": { label: "stopping VM", variant: "outline" },
  "vm-stopped": { label: "VM off", variant: "outline" },
  hibernating: { label: "saving snapshot", variant: "outline" },
  hibernated: { label: "VM deleted, snapshot kept", variant: "outline" },
  restoring: { label: "restoring VM", variant: "outline" },
  "vm-missing": { label: "VM missing", variant: "danger" },
};

const BUSY_STATES = new Set([
  "setting-up",
  "connecting",
  "creating",
  "vm-starting",
  "vm-stopping",
  "hibernating",
  "restoring",
]);
/** A cloud VM that is deliberately off: nothing to reconnect to. */
const VM_OFF = new Set(["vm-stopped", "hibernated", "vm-missing", "creating"]);

export function HostStateBadge({ state }: { state: HostView["state"] }) {
  const b = stateBadge[state];
  return (
    <Badge variant={b.variant} dot>
      {BUSY_STATES.has(state) ? <Loader2 className="size-3 animate-spin" /> : null}
      {b.label}
    </Badge>
  );
}

const stepIcon = {
  pending: <Circle className="size-4 text-muted-foreground/50" />,
  running: <Loader2 className="size-4 animate-spin text-primary" />,
  done: <CheckCircle2 className="size-4 text-primary" />,
  failed: <XCircle className="size-4 text-destructive" />,
  skipped: <MinusCircle className="size-4 text-muted-foreground/60" />,
} as const;

/** Steps of a setup, repair or update, with the command output underneath. */
export function JobSteps({
  job,
  defaultLog = false,
  logLabel = "what ran on the server",
}: {
  job: HostJob;
  defaultLog?: boolean;
  logLabel?: string;
}) {
  const [showLog, setShowLog] = useState(defaultLog);
  return (
    <div className="space-y-3">
      <ol className="space-y-1.5">
        {job.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2.5 text-sm">
            <span className="mt-0.5 shrink-0">{stepIcon[s.state]}</span>
            <span className="min-w-0">
              <span className={cn(s.state === "pending" && "text-muted-foreground")}>
                {s.label}
              </span>
              {s.detail && (
                <span
                  className={cn(
                    "block text-xs break-words",
                    s.state === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {s.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {job.lines.length > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowLog((v) => !v)}
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", !showLog && "-rotate-90")}
            />
            {showLog ? "Hide" : "Show"} {logLabel}
          </button>
          {showLog && (
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
              {job.lines.slice(-200).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Poll a host's job while it runs. */
export function useHostJob(hostId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.hosts.job.queryOptions(
      { hostId: hostId ?? "" },
      {
        enabled: !!hostId,
        refetchInterval: (q) => (q.state.data?.state === "running" ? 1_000 : false),
      },
    ),
  );
}

function UsageBar({
  icon,
  label,
  used,
  total,
}: {
  icon: React.ReactNode;
  label: string;
  used: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        <span>
          {formatMb(used)} of {formatMb(total)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", pct > 90 ? "bg-destructive" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** A VPS the panel manages over SSH. */
export function SshHostCard({ h }: { h: HostView }) {
  const trpc = useTRPC();
  const job = useHostJob(h.job ? h.id : null);
  const [removing, setRemoving] = useState(false);
  const [openSecurity, setOpenSecurity] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
  const opts = {
    onSuccess: () => void refresh(),
    onError: (err: unknown) => toast.error(errorMessage(err)),
  };
  const reconnect = useMutation(trpc.hosts.reconnect.mutationOptions(opts));
  const repair = useMutation(trpc.hosts.repair.mutationOptions(opts));
  const retry = useMutation(trpc.hosts.retry.mutationOptions(opts));
  const running = job.data?.state === "running";
  const failedSetup = h.state === "setup-failed";
  const cloud = h.cloud;
  const HostIcon = cloud ? Cloud : TerminalSquare;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
            <HostIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{h.name}</CardTitle>
            <CardDescription className="truncate">
              {cloud ? (
                `${cloud.providerLabel} · ${cloud.region} · ${cloud.size.label}`
              ) : (
                <>
                  {h.sshUser}@{h.address}
                  {h.sshPort && h.sshPort !== 22 ? `:${h.sshPort}` : ""}
                  {h.os ? ` · ${h.os}` : ""}
                </>
              )}
            </CardDescription>
          </div>
        </div>
        <HostStateBadge state={h.state} />
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {h.error && h.state !== "online" && (
          <p className="flex gap-1.5 text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{h.error}</span>
          </p>
        )}
        {cloud && <CloudPanel h={h} busy={running} />}
        {h.state === "offline" && h.lastSeenAt && (
          <p className="text-xs text-muted-foreground">
            Last connected {timeAgo(h.lastSeenAt)}. Reconnecting by itself.
          </p>
        )}
        {h.state === "online" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {h.totalMemMb != null && h.freeMemMb != null && (
              <UsageBar
                icon={<MemoryStick className="size-3.5" />}
                label="Memory"
                used={h.totalMemMb - h.freeMemMb}
                total={h.totalMemMb}
              />
            )}
            {h.diskTotalMb != null && h.diskFreeMb != null && (
              <UsageBar
                icon={<HardDrive className="size-3.5" />}
                label="Disk"
                used={h.diskTotalMb - h.diskFreeMb}
                total={h.diskTotalMb}
              />
            )}
          </div>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {h.address && (
            <>
              <dt className="text-muted-foreground">Players join at</dt>
              <dd>
                <Address value={h.address} />
              </dd>
            </>
          )}
          {h.cpus != null && (
            <>
              <dt className="text-muted-foreground">Machine</dt>
              <dd>
                {h.cpus} CPU · {h.arch}
                {h.totalMemMb ? ` · ${formatMb(h.totalMemMb)}` : ""}
                {h.uptimeSec != null ? ` · up ${formatDuration(h.uptimeSec * 1000)}` : ""}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Servers</dt>
          <dd>
            {h.servers} ({h.running} running)
          </dd>
          {h.agent && (
            <>
              <dt className="text-muted-foreground">Agent</dt>
              <dd>
                build {h.agent.build}
                {h.agent.node ? ` on Node ${h.agent.node}` : ""}
                {!h.agent.upToDate && (
                  <Badge variant="warning" className="ml-2">
                    update available
                  </Badge>
                )}
              </dd>
            </>
          )}
          {h.hostKey && (
            <>
              <dt className="text-muted-foreground">Host key</dt>
              <dd className="font-mono text-[11px] break-all">{h.hostKey}</dd>
            </>
          )}
        </dl>

        {job.data && (running || job.data.state === "failed" || failedSetup) && (
          <div className="rounded-lg border border-border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground uppercase">
              {job.data.kind === "setup"
                ? "Setup"
                : job.data.kind === "update"
                  ? "Update"
                  : job.data.kind === "power"
                    ? "VM"
                    : "Repair"}
              {running ? " in progress" : job.data.state === "failed" ? " failed" : " finished"}
            </p>
            <JobSteps job={job.data} />
          </div>
        )}

        {h.warnings.length > 0 && h.state === "online" && (
          <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
            {h.warnings.map((w) => (
              <li key={w} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {h.state === "online" && (
            <Button asChild size="sm">
              <Link to="/servers/new" search={{ hostId: h.id }}>
                <Plus /> New server here
              </Link>
            </Button>
          )}
          {failedSetup && h.keyInstalled && (
            <Button
              size="sm"
              disabled={retry.isPending || running}
              onClick={() => retry.mutate({ hostId: h.id })}
            >
              <RefreshCw /> Try setup again
            </Button>
          )}
          {failedSetup && !h.keyInstalled && (
            <Button asChild size="sm">
              <Link to="/hosts/new" search={{ retry: h.id }}>
                <RefreshCw /> Try setup again
              </Link>
            </Button>
          )}
          {!failedSetup &&
            !["online", "setting-up", "locked"].includes(h.state) &&
            !VM_OFF.has(h.state) &&
            !BUSY_STATES.has(h.state) && (
              <Button
                size="sm"
                variant="outline"
                disabled={reconnect.isPending}
                onClick={() => reconnect.mutate({ hostId: h.id })}
              >
                <RefreshCw className={cn(reconnect.isPending && "animate-spin")} /> Reconnect
              </Button>
            )}
          {h.state === "error" && /identity changed/.test(h.error ?? "") && (
            <Button asChild size="sm" variant="outline">
              <Link to="/hosts/new" search={{ retry: h.id }}>
                <KeyRound /> Accept the new identity
              </Link>
            </Button>
          )}
          {!failedSetup && h.keyInstalled && (h.state === "online" || h.state === "agent-down") && (
            <Button
              size="sm"
              variant="outline"
              disabled={repair.isPending || running}
              onClick={() =>
                repair.mutate({ hostId: h.id, update: !!h.agent && !h.agent.upToDate })
              }
              title="Reinstall Node.js and the agent, and restart it"
            >
              <Wrench /> {h.agent && !h.agent.upToDate ? "Update agent" : "Repair"}
            </Button>
          )}
          {h.state === "online" && (
            <Button size="sm" variant="ghost" onClick={() => setOpenSecurity((v) => !v)}>
              <ShieldCheck /> Security
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={() => setRemoving(true)}
            disabled={running}
          >
            <Trash2 /> Remove
          </Button>
        </div>
        {openSecurity && h.state === "online" && <HostSecurityPanel hostId={h.id} />}
      </CardContent>
      {cloud ? (
        <DeleteCloudHostDialog h={h} open={removing} onClose={() => setRemoving(false)} />
      ) : (
        <RemoveHostDialog h={h} open={removing} onClose={() => setRemoving(false)} />
      )}
    </Card>
  );
}

/** Price, this month's cost, and the power buttons of a cloud VM. */
function CloudPanel({ h, busy }: { h: HostView; busy: boolean }) {
  const trpc = useTRPC();
  const c = h.cloud;
  const power = useMutation(
    trpc.cloud.power.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() }),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  if (!c) return null;
  const cur = c.price.currency;
  const listed = {
    priceHourly: c.price.hourly,
    priceMonthly: c.price.monthly,
    diskGb: c.size.diskGb,
    noMonthlyCap: c.size.noMonthlyCap,
  };
  const extra =
    c.provider === "hetzner"
      ? "IPv4 included"
      : c.provider === "aws"
        ? "IPv4 and disk included"
        : "";
  const off = h.state === "vm-stopped" || h.state === "hibernated";
  const up = h.state === "online" || h.state === "agent-down" || h.state === "offline";
  return (
    <div className="space-y-3 rounded-lg bg-muted/50 p-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Price</dt>
        <dd>
          {formatMoney(hourlyRate(c.provider, listed, "running"), cur)}/h while on,{" "}
          {formatMoney(alwaysOnMonthly(c.provider, listed), cur)} if never off
          {extra ? ` (${extra}, before tax)` : " (before tax)"}
          {c.price.estimate ? ", estimated" : ""}
        </dd>
        <dt className="text-muted-foreground">
          {new Date(`${c.month.month}-01`).toLocaleString(undefined, { month: "long" })} so far
        </dt>
        <dd>
          <strong>{formatMoney(c.month.total, cur)}</strong>{" "}
          <span className="text-muted-foreground">
            ({c.month.hours.running} h on
            {c.month.hours.stopped ? `, ${c.month.hours.stopped} h stopped` : ""}
            {c.month.hours.hibernated ? `, ${c.month.hours.hibernated} h saved` : ""}; estimate)
          </span>
        </dd>
        {c.lastMonth && (
          <>
            <dt className="text-muted-foreground">Last month</dt>
            <dd>about {formatMoney(c.lastMonth.total, cur)}</dd>
          </>
        )}
        {h.state === "hibernated" && c.snapshotGb != null && (
          <>
            <dt className="text-muted-foreground">Snapshot</dt>
            <dd>
              {c.snapshotGb} GB, about {formatMoney(c.snapshotGb * c.snapshotPerGbMonth, cur)}/month
            </dd>
          </>
        )}
      </dl>
      {h.state === "vm-stopped" && !c.stopSavesMoney && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {c.providerLabel} bills a stopped VM in full. Delete it and keep a snapshot to pay only
          for storage.
        </p>
      )}
      {h.state === "hibernated" && (
        <p className="text-xs text-muted-foreground">
          Saved as a snapshot; the VM does not exist right now. Start restores it in 2 to 5 minutes,
          usually at a new address.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {off && (
          <Button
            size="sm"
            disabled={busy || power.isPending}
            onClick={() => power.mutate({ hostId: h.id, action: "start" })}
          >
            <Play /> {h.state === "hibernated" ? "Restore and start" : "Start VM"}
          </Button>
        )}
        {up && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || power.isPending}
            onClick={() => power.mutate({ hostId: h.id, action: "stop" })}
            title={
              c.stopSavesMoney
                ? "Stops billing for the VM; the disk is kept"
                : "The VM stays billed while stopped"
            }
          >
            <Power /> Stop VM
          </Button>
        )}
        {up && c.snapshots && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || power.isPending}
            onClick={() => power.mutate({ hostId: h.id, action: "hibernate" })}
            title="Stop the servers, save the disk as a snapshot, then delete the VM"
          >
            <Save /> Delete VM, keep snapshot
          </Button>
        )}
      </div>
    </div>
  );
}

function DeleteCloudHostDialog({
  h,
  open,
  onClose,
}: {
  h: HostView;
  open: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const remove = useMutation(
    trpc.cloud.removeHost.mutationOptions({
      onSuccess: (r) => {
        if (r.problems.length) toast.warning(`Deleted; clean up by hand: ${r.problems.join("; ")}`);
        else toast.success(`${h.name} and its VM are deleted`);
        void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  return (
    <Dialog open={open} onClose={onClose} title={`Delete ${h.name}?`}>
      <div className="space-y-4 text-sm">
        {h.servers > 0 ? (
          <p className="text-destructive">
            {h.servers} server(s) still live here. Move them to another host or delete them first.
          </p>
        ) : (
          <p className="text-muted-foreground">
            Deletes the VM at {h.cloud?.providerLabel} with its disk, and the firewall, SSH key and
            snapshot the panel made for it. Billing for them stops.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending || h.servers > 0}
            onClick={() => remove.mutate({ hostId: h.id })}
          >
            {remove.isPending && <Loader2 className="animate-spin" />} Delete VM
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const hardenLabel: Record<HostHardenAction, string> = {
  firewall: "Turn on",
  fail2ban: "Turn on",
  "auto-updates": "Turn on",
  "password-login-off": "Keys only",
};

export function HostSecurityPanel({ hostId }: { hostId: string }) {
  const trpc = useTRPC();
  const sec = useQuery(trpc.hosts.security.queryOptions({ hostId }));
  const harden = useMutation(
    trpc.hosts.harden.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(trpc.hosts.security.queryKey({ hostId }), data);
        void queryClient.invalidateQueries({ queryKey: trpc.security.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
        toast.success("Done");
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const s = sec.data;
  if (sec.isError) return <p className="text-xs text-destructive">{errorMessage(sec.error)}</p>;
  if (!s) return <p className="text-xs text-muted-foreground">Checking the host…</p>;
  const rows: Array<{
    ok: boolean;
    title: string;
    text: string;
    action: HostHardenAction | null;
  }> = [
    {
      ok: s.firewall === "active",
      title: "Firewall",
      text:
        s.firewall === "active"
          ? `On. Open: SSH${s.openPorts.length ? `, ${s.openPorts.map((p) => `${p.port}/${p.protocol}`).join(", ")}` : ""}.`
          : s.firewall === "missing"
            ? "Not installed: every listening port is reachable."
            : "Off: every listening port is reachable.",
      action: s.firewall === "active" ? null : "firewall",
    },
    {
      ok: s.fail2ban === "active",
      title: "fail2ban",
      text:
        s.fail2ban === "active"
          ? "Blocks addresses that keep failing to log in."
          : "Not running: nothing slows down password guessing.",
      action: s.fail2ban === "active" ? null : "fail2ban",
    },
    {
      ok: s.autoUpdates,
      title: "Automatic security updates",
      text: s.autoUpdates
        ? `Installed daily.${s.rebootRequired ? " Some wait for a restart of the VPS." : ""}`
        : "Off.",
      action: s.autoUpdates ? null : "auto-updates",
    },
    {
      ok: s.passwordLogin === false,
      title: "SSH logins",
      text:
        s.passwordLogin === false
          ? "Keys only."
          : "Passwords are accepted. The panel uses a key; your provider's web console keeps working either way.",
      action: s.passwordLogin === false ? null : "password-login-off",
    },
  ];
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {rows.map((r) => (
        <li key={r.title} className="flex items-start justify-between gap-3 p-3">
          <span className="flex gap-2">
            {r.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <CircleSlash className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span>
              <span className="font-medium">{r.title}</span>
              <span className="block text-xs text-muted-foreground">{r.text}</span>
            </span>
          </span>
          {r.action && (
            <Button
              size="sm"
              variant="outline"
              disabled={harden.isPending}
              onClick={() => {
                const a = r.action;
                if (a) harden.mutate({ hostId, action: a });
              }}
            >
              {harden.isPending && harden.variables?.action === r.action && (
                <Loader2 className="animate-spin" />
              )}
              {hardenLabel[r.action]}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function RemoveHostDialog({
  h,
  open,
  onClose,
}: {
  h: HostView;
  open: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const [uninstall, setUninstall] = useState(true);
  const [deleteData, setDeleteData] = useState(false);
  const remove = useMutation(
    trpc.hosts.remove.mutationOptions({
      onSuccess: (r) => {
        if (r.uninstallError)
          toast.warning(`Removed; cleaning up the VPS failed: ${r.uninstallError}`);
        else
          toast.success(r.uninstalled ? `${h.name} removed and cleaned up` : `${h.name} removed`);
        void queryClient.invalidateQueries({ queryKey: trpc.hosts.pathKey() });
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  return (
    <Dialog open={open} onClose={onClose} title={`Remove ${h.name}?`}>
      <div className="space-y-4 text-sm">
        {h.servers > 0 ? (
          <p className="text-destructive">
            {h.servers} server(s) still live here. Move them to another host or delete them first.
          </p>
        ) : (
          <p className="text-muted-foreground">
            The panel stops managing this machine. The VPS itself keeps running and billing; delete
            it in your provider's control panel if you no longer need it.
          </p>
        )}
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="uninstall">Remove the agent and the panel's key from the VPS</Label>
          <Switch id="uninstall" checked={uninstall} onCheckedChange={setUninstall} />
        </div>
        {uninstall && (
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="delete-data">Also delete leftover worlds and backups there</Label>
            <Switch id="delete-data" checked={deleteData} onCheckedChange={setDeleteData} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending || h.servers > 0}
            onClick={() => remove.mutate({ hostId: h.id, uninstall, deleteData })}
          >
            {remove.isPending && <Loader2 className="animate-spin" />} Remove
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
