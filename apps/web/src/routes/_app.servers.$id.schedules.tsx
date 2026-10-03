import type { ScheduleAction } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Loader2,
  Megaphone,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Square,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { describeCron, type Frequency, fromCron, toCron, WEEKDAYS } from "@/lib/cron";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { formatDate, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/schedules")({
  component: Schedules,
});

const ACTIONS: Record<ScheduleAction, { label: string; Icon: typeof Play; hint: string }> = {
  restart: { label: "Restart", Icon: RotateCw, hint: "Restarts the server if it is running." },
  backup: {
    label: "Back up",
    Icon: Archive,
    hint: "Full backup; counts toward the automatic backups kept.",
  },
  command: {
    label: "Run command",
    Icon: Terminal,
    hint: "Runs a console command if the server is running.",
  },
  broadcast: {
    label: "Broadcast message",
    Icon: Megaphone,
    hint: "Says a message in chat if the server is running.",
  },
  start: { label: "Start", Icon: Play, hint: "Starts the server if it is stopped." },
  stop: { label: "Stop", Icon: Square, hint: "Stops the server if it is running." },
};

const DEFAULT_NAMES: Record<ScheduleAction, string> = {
  restart: "Daily restart",
  backup: "Nightly backup",
  command: "Routine command",
  broadcast: "Announcement",
  start: "Morning start",
  stop: "Nightly stop",
};

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  action: string;
  payload: string | null;
  warnSeconds: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  lastMessage: string | null;
  nextRunAt: string | null;
}

function Schedules() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const list = useQuery(
    trpc.schedules.list.queryOptions({ serverId: id }, { refetchInterval: 30_000 }),
  );
  const [editing, setEditing] = useState<ScheduleRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<ScheduleRow | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.schedules.pathKey() });
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const toggle = useMutation(
    trpc.schedules.update.mutationOptions({ onSuccess: invalidate, onError }),
  );
  const runNow = useMutation(
    trpc.schedules.runNow.mutationOptions({
      onSuccess: (s) => {
        void invalidate();
        if (s.lastResult === "failed") toast.error(`${s.name}: ${s.lastMessage}`);
        else toast.success(`${s.name}: ${s.lastMessage}`);
      },
      onError,
    }),
  );
  const remove = useMutation(
    trpc.schedules.remove.mutationOptions({
      onSuccess: () => {
        setDeleting(null);
        void invalidate();
      },
      onError,
    }),
  );

  const rows = (list.data ?? []) as ScheduleRow[];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>Schedules</CardTitle>
              <CardDescription>
                Run tasks on a timetable, in this computer's time zone. The panel must be running
                for schedules to fire.
              </CardDescription>
            </div>
            <Button onClick={() => setEditing("new")}>
              <Plus /> New schedule
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
              <CalendarClock className="size-6" />
              No schedules yet. A daily restart and a nightly backup are a good start.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((s) => {
                const a = ACTIONS[s.action as ScheduleAction];
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                    <a.Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm font-medium">
                        {s.name}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {a.label}
                          {s.payload ? `: ${s.payload}` : ""}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {describeCron(s.cron)}
                        {s.enabled && s.nextRunAt ? ` · next ${formatDate(s.nextRunAt)}` : ""}
                        {!s.enabled && " · paused"}
                      </p>
                      {s.lastRunAt && (
                        <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <ResultIcon result={s.lastResult} />
                          Last run {timeAgo(s.lastRunAt)}: {s.lastMessage}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={s.enabled}
                        aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
                        onCheckedChange={(enabled) =>
                          toggle.mutate({
                            serverId: id,
                            scheduleId: s.id,
                            name: s.name,
                            cron: s.cron,
                            action: s.action as ScheduleAction,
                            payload: s.payload ?? undefined,
                            warnSeconds: s.warnSeconds ?? undefined,
                            enabled,
                          })
                        }
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        title="Run now"
                        aria-label="Run now"
                        disabled={runNow.isPending}
                        onClick={() => runNow.mutate({ serverId: id, scheduleId: s.id })}
                      >
                        {runNow.isPending && runNow.variables?.scheduleId === s.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Play />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        title="Edit"
                        aria-label="Edit"
                        onClick={() => setEditing(s)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 hover:text-destructive"
                        title="Delete"
                        aria-label="Delete"
                        onClick={() => setDeleting(s)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {editing && (
        <ScheduleDialog
          serverId={id}
          schedule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => deleting && remove.mutate({ serverId: id, scheduleId: deleting.id })}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function ResultIcon({ result }: { result: string | null }) {
  if (result === "ok")
    return <CheckCircle2 className="size-3.5 text-primary" aria-label="succeeded" />;
  if (result === "failed")
    return <XCircle className="size-3.5 text-destructive" aria-label="failed" />;
  return <CircleSlash className="size-3.5" aria-label="skipped" />;
}

function ScheduleDialog({
  serverId,
  schedule,
  onClose,
}: {
  serverId: string;
  schedule: ScheduleRow | null;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const [name, setName] = useState(schedule?.name ?? "Daily restart");
  const [action, setAction] = useState<ScheduleAction>(
    (schedule?.action as ScheduleAction) ?? "restart",
  );
  const [payload, setPayload] = useState(schedule?.payload ?? "");
  const [warn, setWarn] = useState(schedule?.warnSeconds ?? 60);
  const [freq, setFreq] = useState<Frequency>(
    schedule ? fromCron(schedule.cron) : { kind: "daily", time: "04:00" },
  );
  const cron = toCron(freq);
  const [debounced, setDebounced] = useState(cron);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(cron), 300);
    return () => clearTimeout(t);
  }, [cron]);
  const preview = useQuery(trpc.schedules.preview.queryOptions({ cron: debounced }));

  const opts = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trpc.schedules.pathKey() });
      toast.success(schedule ? "Schedule saved" : "Schedule created");
      onClose();
    },
    onError: (err: unknown) => toast.error(errorMessage(err)),
  };
  const create = useMutation(trpc.schedules.create.mutationOptions(opts));
  const update = useMutation(trpc.schedules.update.mutationOptions(opts));
  const pending = create.isPending || update.isPending;
  const needsPayload = action === "command" || action === "broadcast";
  const canWarn = action === "restart" || action === "stop";

  return (
    <Dialog
      open
      onClose={onClose}
      title={schedule ? "Edit schedule" : "New schedule"}
      className="max-w-lg"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const input = {
            serverId,
            name: name.trim(),
            cron,
            action,
            payload: needsPayload ? payload.trim() : undefined,
            warnSeconds: canWarn ? warn : undefined,
            enabled: schedule?.enabled ?? true,
          };
          if (schedule) update.mutate({ ...input, scheduleId: schedule.id });
          else create.mutate(input);
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-action">Action</Label>
            <Select
              id="s-action"
              value={action}
              onChange={(e) => {
                const next = e.target.value as ScheduleAction;
                setAction(next);
                if (!schedule) setName(DEFAULT_NAMES[next]);
              }}
            >
              {(Object.keys(ACTIONS) as ScheduleAction[]).map((k) => (
                <option key={k} value={k}>
                  {ACTIONS[k].label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-name">Name</Label>
            <Input
              id="s-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">{ACTIONS[action].hint}</p>

        {needsPayload && (
          <div className="space-y-1.5">
            <Label htmlFor="s-payload">
              {action === "command" ? "Command (without /)" : "Message"}
            </Label>
            <Input
              id="s-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder={action === "command" ? "save-all" : "Server restarts at 4 am!"}
              required
            />
          </div>
        )}

        <div className="space-y-2">
          <Label>When</Label>
          <FrequencyPicker value={freq} onChange={setFreq} />
          <div className="rounded-md bg-muted/60 p-2 text-xs">
            {preview.data?.valid ? (
              <>
                <span className="text-muted-foreground">Next: </span>
                {preview.data.next
                  .slice(0, 3)
                  .map((n) => formatDate(n))
                  .join(" · ")}
              </>
            ) : (
              <span className="text-destructive">{preview.data?.error ?? "…"}</span>
            )}
          </div>
        </div>

        {canWarn && (
          <div className="space-y-1.5">
            <Label htmlFor="s-warn">Warn players in chat</Label>
            <Select
              id="s-warn"
              value={String(warn)}
              onChange={(e) => setWarn(Number(e.target.value))}
            >
              <option value="0">No warning</option>
              <option value="30">30 seconds before</option>
              <option value="60">1 minute before</option>
              <option value="300">5 minutes before</option>
              <option value="600">10 minutes before</option>
            </Select>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              pending || !preview.data?.valid || !name.trim() || (needsPayload && !payload.trim())
            }
          >
            {pending && <Loader2 className="animate-spin" />} {schedule ? "Save" : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function FrequencyPicker({
  value,
  onChange,
}: {
  value: Frequency;
  onChange: (f: Frequency) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
      <Select
        aria-label="Frequency"
        value={value.kind}
        onChange={(e) => {
          const kind = e.target.value as Frequency["kind"];
          if (kind === "daily") onChange({ kind, time: "04:00" });
          else if (kind === "weekly") onChange({ kind, day: 0, time: "04:00" });
          else if (kind === "hours") onChange({ kind, every: 6 });
          else if (kind === "minutes") onChange({ kind, every: 30 });
          else onChange({ kind, cron: toCron(value) });
        }}
      >
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
        <option value="hours">Every few hours</option>
        <option value="minutes">Every few minutes</option>
        <option value="custom">Custom (cron)</option>
      </Select>
      <div className="flex gap-2">
        {value.kind === "weekly" && (
          <Select
            aria-label="Day"
            value={String(value.day)}
            onChange={(e) => onChange({ ...value, day: Number(e.target.value) })}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        )}
        {(value.kind === "daily" || value.kind === "weekly") && (
          <Input
            type="time"
            aria-label="Time"
            value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value || "00:00" })}
            required
          />
        )}
        {value.kind === "hours" && (
          <Select
            aria-label="Hours"
            value={String(value.every)}
            onChange={(e) => onChange({ ...value, every: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 6, 8, 12].map((n) => (
              <option key={n} value={n}>
                every {n} hour{n === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        )}
        {value.kind === "minutes" && (
          <Select
            aria-label="Minutes"
            value={String(value.every)}
            onChange={(e) => onChange({ ...value, every: Number(e.target.value) })}
          >
            {[5, 10, 15, 20, 30].map((n) => (
              <option key={n} value={n}>
                every {n} minutes
              </option>
            ))}
          </Select>
        )}
        {value.kind === "custom" && (
          <Input
            aria-label="Cron expression"
            className="font-mono"
            value={value.cron}
            onChange={(e) => onChange({ kind: "custom", cron: e.target.value })}
            placeholder="minute hour day month weekday"
          />
        )}
      </div>
    </div>
  );
}
