import type { GameMode, Location, PlayerCommand, PlayerDetails } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Ban,
  BedDouble,
  Copy,
  Crown,
  Gift,
  Heart,
  ListChecks,
  Loader2,
  LogOut,
  MapPin,
  MessageSquare,
  Navigation,
  RefreshCw,
  Skull,
  Trash2,
  Utensils,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { dimensionName, type ItemAssets, useItemAssets } from "@/components/minecraft/assets";
import { Hearts, Hunger, XpBar } from "@/components/minecraft/hud";
import { EnderChestGui, InventoryGui, useGuiScale } from "@/components/minecraft/inventory";
import { ItemIcon } from "@/components/minecraft/item-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, trpcClient, useTRPC } from "@/lib/trpc";
import { cn, formatDuration, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/players_/$name")({
  component: PlayerPage,
});

const GAME_MODES: GameMode[] = ["survival", "creative", "adventure", "spectator"];

function PlayerPage() {
  const { id, name } = Route.useParams();
  const trpc = useTRPC();
  const live = useServerLive(id);
  const onlineNow = live.players.some((p) => p.toLowerCase() === name.toLowerCase());
  const details = useQuery(
    trpc.players.details.queryOptions(
      { serverId: id, name },
      { refetchInterval: onlineNow ? 5_000 : 60_000, retry: false },
    ),
  );
  const [refreshing, setRefreshing] = useState(false);
  const d = details.data;

  const ids = d ? collectIds(d) : [];
  const assets = useItemAssets(d?.mcVersion, ids);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await trpcClient.players.details.query({ serverId: id, name, fresh: true });
      queryClient.setQueryData(trpc.players.details.queryKey({ serverId: id, name }), fresh);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/servers/$id/players" params={{ id }}>
        <ArrowLeft /> Players
      </Link>
    </Button>
  );
  if (details.error) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-destructive">{errorMessage(details.error)}</p>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="space-y-4">
        {back}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading {name}…
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {back}
      <Header d={d} onRefresh={refresh} refreshing={refreshing} />
      {assets.isLoading && (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Getting Minecraft {d.mcVersion} textures
          (first time only, about 25 MB)…
        </p>
      )}
      {assets.error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage(assets.error)}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <HealthCard d={d} serverId={id} assets={assets.data} />
        <ControlCard d={d} serverId={id} />
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Inventory</CardTitle>
              <InventoryActions d={d} serverId={id} />
            </div>
          </CardHeader>
          <CardContent>
            {d.inventory ? (
              <InventoryGui inventory={d.inventory} assets={assets.data} playerName={d.name} />
            ) : (
              <p className="text-sm text-muted-foreground">No saved inventory yet.</p>
            )}
          </CardContent>
        </Card>
        <InfoCard d={d} serverId={id} />
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Ender chest</CardTitle>
          </CardHeader>
          <CardContent>
            {d.enderChest ? (
              <EnderChestGui items={d.enderChest} assets={assets.data} />
            ) : (
              <p className="text-sm text-muted-foreground">No saved ender chest yet.</p>
            )}
          </CardContent>
        </Card>
        <StatsCard d={d} assets={assets.data} />
      </div>
    </div>
  );
}

function collectIds(d: PlayerDetails): string[] {
  const items = [
    ...(d.inventory
      ? [
          ...d.inventory.hotbar,
          ...d.inventory.main,
          ...Object.values(d.inventory.armor),
          d.inventory.offhand,
        ]
      : []),
    ...(d.enderChest ?? []),
  ].filter((i) => i !== null);
  return [
    ...items.map((i) => i.id),
    ...items.flatMap((i) => i.enchantments.map((e) => e.id)),
    ...[d.stats?.mostMined?.id, d.stats?.mostKilled?.id, d.stats?.killedBy?.id].filter(
      (x): x is string => Boolean(x),
    ),
  ];
}

function useCommand(serverId: string, name: string) {
  const trpc = useTRPC();
  return useMutation(
    trpc.players.command.mutationOptions({
      onSuccess: (r) => {
        if (r.reply) toast.success(r.reply);
        setTimeout(
          () =>
            void queryClient.invalidateQueries({
              queryKey: trpc.players.details.queryKey({ serverId, name }),
            }),
          500,
        );
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
}

function Header({
  d,
  onRefresh,
  refreshing,
}: {
  d: PlayerDetails;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {broken ? (
          <span className="grid size-12 place-items-center rounded-md bg-muted text-lg font-semibold uppercase">
            {d.name.slice(0, 2)}
          </span>
        ) : (
          <img
            src={`https://mc-heads.net/avatar/${encodeURIComponent(d.name)}/48`}
            alt=""
            width={48}
            height={48}
            className="size-12 rounded-md [image-rendering:pixelated]"
            onError={() => setBroken(true)}
          />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{d.name}</h1>
            {d.online ? (
              <Badge variant="success" dot>
                online
              </Badge>
            ) : (
              <Badge variant="outline">offline</Badge>
            )}
            {d.gameMode && <Badge variant="outline">{d.gameMode}</Badge>}
            {d.status.op && (
              <Badge variant="warning">
                <Crown className="size-3" /> operator
              </Badge>
            )}
            {d.status.banned && <Badge variant="danger">banned</Badge>}
          </div>
          {d.uuid && (
            <button
              type="button"
              className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(d.uuid ?? "")
                  .then(() => toast.success("UUID copied"))
              }
              title="Copy UUID"
            >
              {d.uuid} <Copy className="size-3" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {d.online ? "Health and position live" : "Offline"}
          {d.savedAt && ` · inventory saved ${timeAgo(d.savedAt)}`}
        </span>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn(refreshing && "animate-spin")} /> Refresh
        </Button>
      </div>
    </div>
  );
}

function HealthCard({
  d,
  serverId,
  assets,
}: {
  d: PlayerDetails;
  serverId: string;
  assets: ItemAssets | undefined;
}) {
  const run = useCommand(serverId, d.name);
  const { ref, scale } = useGuiScale(100, 3);
  const act = (command: PlayerCommand) => run.mutate({ serverId, name: d.name, command });
  const disabled = !d.online || run.isPending;
  const title = d.online ? undefined : "The player is offline";
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Health and experience</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div ref={ref} className="w-full" />
        {assets && d.xpLevel !== null ? (
          <div className="flex justify-center">
            <XpBar
              level={d.xpLevel}
              progress={d.xpProgress ?? 0}
              assets={assets}
              width={Math.min(182 * scale, 546)}
            />
          </div>
        ) : (
          d.xpLevel !== null && <p className="text-center text-sm">Level {d.xpLevel}</p>
        )}
        <div className="grid grid-cols-[7rem_1fr_7rem] items-center gap-3">
          <Button
            variant="destructive"
            disabled={disabled}
            title={title}
            onClick={() => act({ type: "kill" })}
          >
            <Skull /> Kill
          </Button>
          <div className="flex justify-center">
            {assets && d.health !== null ? (
              <Hearts
                health={d.health}
                max={d.maxHealth}
                absorption={d.absorption}
                assets={assets}
                scale={scale}
              />
            ) : (
              <span className="text-sm">
                {d.health ?? "?"} / {d.maxHealth}
              </span>
            )}
          </div>
          <Button disabled={disabled} title={title} onClick={() => act({ type: "heal" })}>
            <Heart /> Heal
          </Button>
          <Button
            variant="destructive"
            disabled={disabled}
            title={title}
            onClick={() => act({ type: "starve" })}
          >
            <Skull /> Starve
          </Button>
          <div className="flex justify-center">
            {assets && d.food !== null ? (
              <Hunger food={d.food} assets={assets} scale={scale} />
            ) : (
              <span className="text-sm">{d.food ?? "?"} / 20</span>
            )}
          </div>
          <Button disabled={disabled} title={title} onClick={() => act({ type: "feed" })}>
            <Utensils /> Feed
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground tabular-nums">
          {d.health !== null && `${Math.round(d.health * 10) / 10} / ${d.maxHealth} health`}
          {d.food !== null && ` · ${d.food} / 20 food`}
          {d.saturation !== null && ` · ${Math.round(d.saturation * 10) / 10} saturation`}
          {d.xpTotal !== null && ` · ${d.xpTotal} total XP`}
        </p>
      </CardContent>
    </Card>
  );
}

function ControlCard({ d, serverId }: { d: PlayerDetails; serverId: string }) {
  const trpc = useTRPC();
  const run = useCommand(serverId, d.name);
  const [dialog, setDialog] = useState<"ban" | "kick" | "message" | null>(null);
  const [text, setText] = useState("");
  const refresh = () =>
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: trpc.players.pathKey() }), 600);
  const action = useMutation(
    trpc.players.action.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.reply ?? "Saved; takes effect when the server starts.");
        setDialog(null);
        setText("");
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const act = (a: Parameters<typeof action.mutate>[0]["action"], reason?: string) =>
    action.mutate({ serverId, action: a, target: d.name, reason });
  const busy = action.isPending;
  const named = /^[A-Za-z0-9_]{1,16}$/.test(d.name);

  const rows: Array<{
    key: string;
    icon: React.ReactNode;
    label: string;
    on: boolean;
    toggle: (v: boolean) => void;
  }> = [
    {
      key: "wl",
      icon: <ListChecks className="size-4" />,
      label: "Whitelisted",
      on: d.status.whitelisted,
      toggle: (v) => act(v ? "whitelist_add" : "whitelist_remove"),
    },
    {
      key: "ban",
      icon: <Ban className="size-4" />,
      label: "Banned",
      on: d.status.banned,
      toggle: (v) => (v ? setDialog("ban") : act("pardon")),
    },
    {
      key: "op",
      icon: <Crown className="size-4" />,
      label: "Operator",
      on: d.status.op,
      toggle: (v) => act(v ? "op" : "deop"),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Control</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((r) => (
          <div
            key={r.key}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <Label htmlFor={`ctl-${r.key}`} className="flex items-center gap-2">
              {r.icon} {r.label}
            </Label>
            <Switch
              id={`ctl-${r.key}`}
              checked={r.on}
              disabled={busy || !named}
              onCheckedChange={r.toggle}
            />
          </div>
        ))}
        {d.status.banned && d.status.banReason && (
          <p className="text-xs text-muted-foreground">Ban reason: {d.status.banReason}</p>
        )}
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <Label htmlFor="ctl-mode">Game mode</Label>
          <Select
            id="ctl-mode"
            className="w-36"
            value={d.gameMode ?? ""}
            disabled={!d.online || run.isPending}
            onChange={(e) =>
              run.mutate({
                serverId,
                name: d.name,
                command: { type: "gamemode", mode: e.target.value as GameMode },
              })
            }
          >
            {!d.gameMode && <option value="">unknown</option>}
            {GAME_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={!d.online} onClick={() => setDialog("kick")}>
            <LogOut /> Kick
          </Button>
          <Button variant="outline" disabled={!d.online} onClick={() => setDialog("message")}>
            <MessageSquare /> Message
          </Button>
        </div>
        {!d.online && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <WifiOff className="size-3.5" /> In-game actions need the player online. List changes
            still apply.
          </p>
        )}
      </CardContent>
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog === "ban"
            ? `Ban ${d.name}?`
            : dialog === "kick"
              ? `Kick ${d.name}?`
              : `Message ${d.name}`
        }
        description={
          dialog === "message" ? "Sent as a private message from the server." : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (dialog === "message") {
              if (!text.trim()) return;
              run.mutate({
                serverId,
                name: d.name,
                command: { type: "message", text: text.trim() },
              });
              setDialog(null);
              setText("");
            } else if (dialog) act(dialog, text.trim() || undefined);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ctl-text">
              {dialog === "message" ? "Message" : "Reason shown to the player"}
            </Label>
            <Input
              id="ctl-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              maxLength={256}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={dialog === "ban" ? "destructive" : "default"}
              disabled={busy || run.isPending}
            >
              {dialog === "ban" ? "Ban" : dialog === "kick" ? "Kick" : "Send"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function InventoryActions({ d, serverId }: { d: PlayerDetails; serverId: string }) {
  const trpc = useTRPC();
  const run = useCommand(serverId, d.name);
  const [give, setGive] = useState(false);
  const [clear, setClear] = useState(false);
  const [item, setItem] = useState("");
  const [count, setCount] = useState(1);
  const catalog = useQuery(
    trpc.assets.catalog.queryOptions(
      { mcVersion: d.mcVersion },
      { enabled: give, staleTime: Number.POSITIVE_INFINITY },
    ),
  );
  const toId = (v: string) => {
    const t = v.trim();
    const byName = catalog.data?.find((c) => c.name.toLowerCase() === t.toLowerCase());
    return byName?.id ?? t.toLowerCase().replace(/\s+/g, "_");
  };
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={!d.online} onClick={() => setGive(true)}>
        <Gift /> Give item
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="hover:text-destructive"
        disabled={!d.online}
        onClick={() => setClear(true)}
      >
        <Trash2 /> Clear
      </Button>
      <Dialog open={give} onClose={() => setGive(false)} title={`Give ${d.name} an item`}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!item.trim()) return;
            run.mutate({
              serverId,
              name: d.name,
              command: { type: "give", item: toId(item), count },
            });
            setGive(false);
            setItem("");
          }}
        >
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="give-item">Item</Label>
              <Input
                id="give-item"
                list="give-catalog"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="Diamond Sword"
                autoFocus
              />
              <datalist id="give-catalog">
                {catalog.data?.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.id}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="give-count">Count</Label>
              <Input
                id="give-count"
                type="number"
                min={1}
                max={6400}
                value={count}
                onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setGive(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!item.trim()}>
              Give
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={clear}
        onClose={() => setClear(false)}
        title={`Clear ${d.name}'s inventory?`}
        description="Every item in their inventory, armor and off-hand is deleted. The ender chest is kept. This cannot be undone, except by restoring a backup."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setClear(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              run.mutate({ serverId, name: d.name, command: { type: "clear" } });
              setClear(false);
            }}
          >
            Clear inventory
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function InfoCard({ d, serverId }: { d: PlayerDetails; serverId: string }) {
  const live = useServerLive(serverId);
  const run = useCommand(serverId, d.name);
  const [tp, setTp] = useState(false);
  const goTo = (l: Location) =>
    run.mutate({
      serverId,
      name: d.name,
      command: {
        type: "teleport",
        x: Math.round(l.x * 100) / 100,
        y: Math.round(l.y * 100) / 100,
        z: Math.round(l.z * 100) / 100,
        dimension: l.dimension,
      },
    });
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Information</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        <LocationRow
          icon={<MapPin className="size-4" />}
          title={d.online ? "Current position" : "Last position"}
          loc={d.position}
          empty="Unknown"
          action={
            <Button size="sm" variant="outline" disabled={!d.online} onClick={() => setTp(true)}>
              <Navigation /> Teleport
            </Button>
          }
        />
        <LocationRow
          icon={<BedDouble className="size-4" />}
          title="Respawn point"
          loc={d.respawn}
          empty="World spawn (no bed or respawn anchor set)"
          action={
            d.respawn && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!d.online}
                onClick={() => d.respawn && goTo(d.respawn)}
              >
                Go there
              </Button>
            )
          }
        />
        <LocationRow
          icon={<Skull className="size-4" />}
          title="Last death"
          loc={d.lastDeath}
          empty={d.stats?.deaths ? "Not recorded" : "Never died"}
          action={
            d.lastDeath && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!d.online}
                onClick={() => d.lastDeath && goTo(d.lastDeath)}
              >
                Go there
              </Button>
            )
          }
        />
        <div className="grid grid-cols-2 gap-2 pt-3 text-xs text-muted-foreground">
          <span>
            First seen: {d.sessions.firstSeen ? timeAgo(d.sessions.firstSeen) : "before tracking"}
          </span>
          <span>
            Last seen:{" "}
            {d.online
              ? "now"
              : d.sessions.lastSeen
                ? timeAgo(d.sessions.lastSeen)
                : d.savedAt
                  ? timeAgo(d.savedAt)
                  : "unknown"}
          </span>
        </div>
      </CardContent>
      <TeleportDialog
        open={tp}
        onClose={() => setTp(false)}
        d={d}
        others={live.players.filter((p) => p.toLowerCase() !== d.name.toLowerCase())}
        onTeleport={(command) => {
          run.mutate({ serverId, name: d.name, command });
          setTp(false);
        }}
      />
    </Card>
  );
}

function LocationRow({
  icon,
  title,
  loc,
  empty,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  loc: Location | null;
  empty: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 first:pt-0">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {icon} {title}
        </p>
        {loc ? (
          <p className="mt-1 font-mono text-xs tabular-nums">
            <span className="text-muted-foreground">X</span> {loc.x.toFixed(1)}{" "}
            <span className="ml-2 text-muted-foreground">Y</span> {loc.y.toFixed(1)}{" "}
            <span className="ml-2 text-muted-foreground">Z</span> {loc.z.toFixed(1)}
            <span className="ml-2 font-sans text-muted-foreground">
              {dimensionName(loc.dimension)}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{empty}</p>
        )}
      </div>
      {action}
    </div>
  );
}

function TeleportDialog({
  open,
  onClose,
  d,
  others,
  onTeleport,
}: {
  open: boolean;
  onClose: () => void;
  d: PlayerDetails;
  others: string[];
  onTeleport: (c: PlayerCommand) => void;
}) {
  const [mode, setMode] = useState<"coords" | "player">("coords");
  const [x, setX] = useState(String(Math.round(d.position?.x ?? 0)));
  const [y, setY] = useState(String(Math.round(d.position?.y ?? 64)));
  const [z, setZ] = useState(String(Math.round(d.position?.z ?? 0)));
  const [dim, setDim] = useState(d.position?.dimension ?? "minecraft:overworld");
  const [target, setTarget] = useState(others[0] ?? "");
  return (
    <Dialog open={open} onClose={onClose} title={`Teleport ${d.name}`}>
      <div className="mb-4 inline-flex rounded-lg border border-border p-0.5">
        {(["coords", "player"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "rounded-md px-3 py-1 text-sm",
              mode === m ? "bg-muted font-medium" : "text-muted-foreground",
            )}
          >
            {m === "coords" ? "To coordinates" : "To a player"}
          </button>
        ))}
      </div>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "player") {
            if (target) onTeleport({ type: "teleportToPlayer", target });
            return;
          }
          const [nx, ny, nz] = [Number(x), Number(y), Number(z)];
          if ([nx, ny, nz].some((n) => !Number.isFinite(n)))
            return toast.error("Enter numbers for X, Y and Z");
          onTeleport({ type: "teleport", x: nx, y: ny, z: nz, dimension: dim });
        }}
      >
        {mode === "coords" ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["X", x, setX],
                  ["Y", y, setY],
                  ["Z", z, setZ],
                ] as const
              ).map(([l, v, set]) => (
                <div key={l} className="space-y-1.5">
                  <Label htmlFor={`tp-${l}`}>{l}</Label>
                  <Input
                    id={`tp-${l}`}
                    inputMode="decimal"
                    value={v}
                    onChange={(e) => set(e.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tp-dim">Dimension</Label>
              <Select id="tp-dim" value={dim} onChange={(e) => setDim(e.target.value)}>
                <option value="minecraft:overworld">Overworld</option>
                <option value="minecraft:the_nether">Nether</option>
                <option value="minecraft:the_end">The End</option>
              </Select>
            </div>
          </>
        ) : others.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody else is online.</p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="tp-target">Player</Label>
            <Select id="tp-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {others.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mode === "player" && !target}>
            Teleport
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function StatsCard({ d, assets }: { d: PlayerDetails; assets: ItemAssets | undefined }) {
  const s = d.stats;
  const n = (v: number) => v.toLocaleString();
  const tiles: Array<[string, string]> = s
    ? [
        ["Play time", formatDuration(s.playTimeMs)],
        ["Deaths", n(s.deaths)],
        ["Mob kills", n(s.mobKills)],
        ["Player kills", n(s.playerKills)],
        ["Distance travelled", `${n(s.distanceBlocks)} blocks`],
        ["Blocks mined", n(s.blocksMined)],
        ["Items crafted", n(s.itemsCrafted)],
        ["Jumps", n(s.jumps)],
        ["Damage dealt", `${n(Math.round(s.damageDealt / 2))} ♥`],
        ["Damage taken", `${n(Math.round(s.damageTaken / 2))} ♥`],
        ["Fish caught", n(s.fishCaught)],
        ["Animals bred", n(s.animalsBred)],
        ["Times joined", n(Math.max(s.timesLeft + (d.online ? 1 : 0), d.sessions.count))],
        ["Advancements", d.advancements !== null ? n(d.advancements) : "–"],
        ...(s.timeSinceDeathMs !== null
          ? ([["Alive for", formatDuration(s.timeSinceDeathMs)]] as Array<[string, string]>)
          : []),
      ]
    : [];
  const name = (id: string) => assets?.names[id] ?? id.replace("minecraft:", "").replace(/_/g, " ");
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Statistics</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!s ? (
          <p className="text-sm text-muted-foreground">
            The game has no statistics for this player yet.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {tiles.map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1"
                >
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <ul className="space-y-1.5 text-sm">
              {s.mostMined && (
                <li className="flex items-center gap-2">
                  {assets && (
                    <ItemIcon
                      icon={assets.icons[s.mostMined.id]}
                      version={assets.version}
                      size={24}
                      label={name(s.mostMined.id)}
                    />
                  )}
                  <span className="text-muted-foreground">Mined most:</span> {name(s.mostMined.id)}{" "}
                  × {n(s.mostMined.count)}
                </li>
              )}
              {s.mostKilled && (
                <li>
                  <span className="text-muted-foreground">Killed most:</span>{" "}
                  {name(s.mostKilled.id)} × {n(s.mostKilled.count)}
                </li>
              )}
              {s.killedBy && (
                <li>
                  <span className="text-muted-foreground">Killed most often by:</span>{" "}
                  {name(s.killedBy.id)} × {n(s.killedBy.count)}
                </li>
              )}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
