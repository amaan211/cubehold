import type { PlayerAction } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Ban, Crown, ListChecks, LogOut, Plus, ShieldOff, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, formatDuration, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/players")({
  component: Players,
});

const ACTION_LABEL: Record<PlayerAction, string> = {
  kick: "Kick",
  ban: "Ban",
  pardon: "Unban",
  op: "Make operator",
  deop: "Remove operator",
  whitelist_add: "Add to whitelist",
  whitelist_remove: "Remove from whitelist",
  ban_ip: "Ban IP",
  pardon_ip: "Unban IP",
};

function Players() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const live = useServerLive(id);
  const overview = useQuery(
    trpc.players.overview.queryOptions({ serverId: id }, { refetchInterval: 10_000 }),
  );
  const [reasonFor, setReasonFor] = useState<{ action: "kick" | "ban"; target: string } | null>(
    null,
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.players.pathKey() });
  const act = useMutation(
    trpc.players.action.mutationOptions({
      onSuccess: (res, vars) => {
        const label = `${ACTION_LABEL[vars.action]}: ${vars.target}`;
        if (res.live) toast.success(res.reply ? res.reply : label);
        else toast.success(`${label}. Saved; takes effect when the server starts.`);
        setReasonFor(null);
        // The server writes its JSON lists a moment after the command.
        setTimeout(() => void refresh(), 600);
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const whitelist = useMutation(
    trpc.players.setWhitelist.mutationOptions({
      onSuccess: (_d, vars) => {
        toast.success(vars.enabled ? "Whitelist on" : "Whitelist off");
        setTimeout(() => void refresh(), 600);
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const run = (action: PlayerAction, target: string, reason?: string) =>
    act.mutate({ serverId: id, action, target, reason });

  const data = overview.data;
  if (!data) {
    return overview.error ? (
      <p className="text-sm text-destructive">{errorMessage(overview.error)}</p>
    ) : null;
  }
  const online = live.ready ? live.players : data.online;
  const known = new Map(data.known.map((p) => [p.name.toLowerCase(), p]));
  const isOp = (n: string) => data.ops.some((o) => o.name.toLowerCase() === n.toLowerCase());
  const isWl = (n: string) => data.whitelist.some((o) => o.name.toLowerCase() === n.toLowerCase());
  const liveMode = live.status === "running";

  return (
    <div className="space-y-6">
      {!liveMode && (
        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          The server is not running. Changes are written to its player lists and apply when it
          starts.
          {data.onlineMode
            ? " Names are checked against Microsoft accounts."
            : " Offline mode: players get offline UUIDs."}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Online now ({online.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {online.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {liveMode ? "Nobody is online." : "The server is not running."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {online.map((name) => {
                const k = known.get(name.toLowerCase());
                return (
                  <li key={name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <PlayerName serverId={id} name={name} op={isOp(name)} online />
                    <span className="ml-auto mr-2 text-xs text-muted-foreground">
                      {k ? `${formatDuration(k.playtimeMs)} played` : ""}
                    </span>
                    <div className="flex gap-1">
                      <IconAction
                        label={isOp(name) ? "Remove operator" : "Make operator"}
                        onClick={() => run(isOp(name) ? "deop" : "op", name)}
                        active={isOp(name)}
                      >
                        <Crown />
                      </IconAction>
                      <IconAction
                        label="Kick"
                        onClick={() => setReasonFor({ action: "kick", target: name })}
                      >
                        <LogOut />
                      </IconAction>
                      <IconAction
                        label="Ban"
                        danger
                        onClick={() => setReasonFor({ action: "ban", target: name })}
                      >
                        <Ban />
                      </IconAction>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="flex items-center gap-2">
                <ListChecks className="size-4" /> Whitelist
              </CardTitle>
              <div className="flex items-center gap-2">
                <Label htmlFor="wl-toggle" className="text-xs text-muted-foreground">
                  {data.whitelistEnabled ? "On" : "Off"}
                </Label>
                <Switch
                  id="wl-toggle"
                  checked={data.whitelistEnabled}
                  disabled={whitelist.isPending}
                  onCheckedChange={(enabled) => whitelist.mutate({ serverId: id, enabled })}
                />
              </div>
            </div>
            <CardDescription>
              {data.whitelistEnabled
                ? "Only these players can join."
                : "Anyone can join. Turn it on to allow only the players listed."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <AddRow
              placeholder="Player name"
              button="Add"
              onSubmit={(n) => run("whitelist_add", n)}
            />
            <NameList
              names={data.whitelist.map((w) => w.name)}
              empty="Nobody yet."
              onRemove={(n) => run("whitelist_remove", n)}
              removeLabel="Remove from whitelist"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="size-4" /> Operators
            </CardTitle>
            <CardDescription>Operators can run every command in game.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <AddRow
              placeholder="Player name"
              button="Make operator"
              onSubmit={(n) => run("op", n)}
            />
            <NameList
              names={data.ops.map((o) => o.name)}
              empty="No operators."
              onRemove={(n) => run("deop", n)}
              removeLabel="Remove operator"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="size-4" /> Bans
          </CardTitle>
          <CardDescription>Banned players and IP addresses cannot join.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <BanForm onBan={(kind, target, reason) => run(kind, target, reason)} />
          {data.bans.length === 0 && data.ipBans.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is banned.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.bans.map((b) => (
                <li
                  key={`p-${b.name}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{b.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {b.reason} · by {b.source}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => run("pardon", b.name)}>
                    Unban
                  </Button>
                </li>
              ))}
              {data.ipBans.map((b) => (
                <li
                  key={`ip-${b.ip}`}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-mono">{b.ip}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      IP · {b.reason} · by {b.source}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => run("pardon_ip", b.ip)}>
                    Unban
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Player history</CardTitle>
          <CardDescription>
            Everyone who has ever joined, with playtime and deaths from the game's own statistics.
            Click a name for their inventory, ender chest and stats.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.known.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody has joined yet.</p>
          ) : (
            <div className="relative -mx-5 overflow-x-auto px-5">
              <table className="w-full min-w-[38rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Player</th>
                    <th className="py-2 font-medium">Last seen</th>
                    <th className="py-2 text-right font-medium">Playtime</th>
                    <th className="py-2 text-right font-medium">Deaths</th>
                    <th className="py-2 text-right font-medium">Joins</th>
                    <th className="py-2 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.known.map((p) => (
                    <tr key={p.name}>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <PlayerName
                            serverId={id}
                            name={p.name}
                            op={p.op}
                            online={p.online}
                            label={p.named ? p.name : `Unknown (${p.name.slice(0, 8)})`}
                          />
                          {p.whitelisted && <Badge variant="outline">whitelisted</Badge>}
                          {p.banned && <Badge variant="danger">banned</Badge>}
                        </div>
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {p.online ? "online now" : p.lastSeen ? timeAgo(p.lastSeen) : "unknown"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatDuration(p.playtimeMs)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{p.deaths ?? "–"}</td>
                      <td className="py-2 text-right tabular-nums">{p.sessions}</td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {p.named && !isWl(p.name) && (
                            <IconAction
                              label="Add to whitelist"
                              onClick={() => run("whitelist_add", p.name)}
                            >
                              <Plus />
                            </IconAction>
                          )}
                          {p.named && !p.banned && (
                            <IconAction
                              label="Ban"
                              danger
                              onClick={() => setReasonFor({ action: "ban", target: p.name })}
                            >
                              <Ban />
                            </IconAction>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ReasonDialog
        value={reasonFor}
        pending={act.isPending}
        onClose={() => setReasonFor(null)}
        onConfirm={(reason) => reasonFor && run(reasonFor.action, reasonFor.target, reason)}
      />
    </div>
  );
}

/** Avatar and name, linking to the player's page. `id` is the name, or a UUID when the name is unknown. */
function PlayerName({
  serverId,
  name,
  op,
  online,
  id = name,
  label = name,
}: {
  serverId: string;
  name: string;
  op: boolean;
  online: boolean;
  id?: string;
  label?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <Link
      to="/servers/$id/players/$name"
      params={{ id: serverId, name: id }}
      className="inline-flex items-center gap-2 hover:underline"
    >
      <span className="relative">
        {broken ? (
          <span className="grid size-6 place-items-center rounded bg-muted text-[10px] font-semibold uppercase">
            {label.slice(0, 2)}
          </span>
        ) : (
          <img
            src={`https://mc-heads.net/avatar/${encodeURIComponent(name)}/24`}
            alt=""
            width={24}
            height={24}
            loading="lazy"
            className="size-6 rounded [image-rendering:pixelated]"
            onError={() => setBroken(true)}
          />
        )}
        {online && (
          <>
            <span
              aria-hidden
              className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-primary ring-2 ring-card"
            />
            <span className="sr-only">online</span>
          </>
        )}
      </span>
      <span className="font-medium">{label}</span>
      {op && <Crown className="size-3.5 text-amber-500" aria-label="operator" />}
    </Link>
  );
}

function IconAction({
  label,
  onClick,
  children,
  danger,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn("size-8", danger && "hover:text-destructive", active && "text-amber-500")}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function AddRow({
  placeholder,
  button,
  onSubmit,
}: {
  placeholder: string;
  button: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (!v) return;
        onSubmit(v);
        setValue("");
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        maxLength={16}
        aria-label={placeholder}
      />
      <Button type="submit" variant="outline" disabled={!value.trim()}>
        {button}
      </Button>
    </form>
  );
}

function NameList({
  names,
  empty,
  onRemove,
  removeLabel,
}: {
  names: string[];
  empty: string;
  onRemove: (name: string) => void;
  removeLabel: string;
}) {
  if (names.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {names.map((n) => (
        <li
          key={n}
          className="inline-flex items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-2 text-sm"
        >
          {n}
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={`${removeLabel}: ${n}`}
            title={removeLabel}
            onClick={() => onRemove(n)}
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function BanForm({
  onBan,
}: {
  onBan: (kind: "ban" | "ban_ip", target: string, reason?: string) => void;
}) {
  const [kind, setKind] = useState<"ban" | "ban_ip">("ban");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!target.trim()) return;
        onBan(kind, target.trim(), reason.trim() || undefined);
        setTarget("");
        setReason("");
      }}
    >
      <Select
        value={kind}
        onChange={(e) => setKind(e.target.value as "ban" | "ban_ip")}
        aria-label="Ban type"
      >
        <option value="ban">Player</option>
        <option value="ban_ip">IP address</option>
      </Select>
      <Input
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder={kind === "ban" ? "Player name" : "IP address"}
        aria-label={kind === "ban" ? "Player name" : "IP address"}
      />
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        aria-label="Reason"
      />
      <Button type="submit" variant="destructive" disabled={!target.trim()}>
        Ban
      </Button>
    </form>
  );
}

function ReasonDialog({
  value,
  pending,
  onClose,
  onConfirm,
}: {
  value: { action: "kick" | "ban"; target: string } | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState("");
  if (!value) return null;
  const isBan = value.action === "ban";
  return (
    <Dialog
      open
      onClose={() => {
        setReason("");
        onClose();
      }}
      title={`${isBan ? "Ban" : "Kick"} ${value.target}?`}
      description={isBan ? "They cannot rejoin until unbanned." : "They can rejoin right away."}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim() || undefined);
          setReason("");
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="reason">Reason shown to the player</Label>
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={isBan ? "destructive" : "default"} disabled={pending}>
            {isBan ? "Ban" : "Kick"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
