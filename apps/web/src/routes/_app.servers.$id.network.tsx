import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { inferOutput } from "@trpc/tanstack-react-query";
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Globe,
  Home,
  Loader2,
  Radar,
  Router,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import {
  Address,
  PlayitLink,
  type Reachability,
  ReachabilityResult,
  TunnelStateBadge,
} from "@/components/network";
import { CloudflareCard, NgrokCard, TailscaleCard } from "@/components/tunnel-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/network")({
  component: NetworkTab,
});

function NetworkTab() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const net = useQuery(
    trpc.network.server.queryOptions(
      { serverId: id },
      {
        // Faster while waiting for a tunnel to show up after linking.
        refetchInterval: (q) =>
          q.state.data?.playit?.linked && q.state.data.playit.java.length === 0 ? 5_000 : 15_000,
      },
    ),
  );
  const n = net.data;
  if (net.isError) return <p className="text-sm text-destructive">{errorMessage(net.error)}</p>;
  if (!n) return <p className="text-sm text-muted-foreground">Looking at your network…</p>;

  if (n.vps) {
    return (
      <div className="space-y-6">
        <VpsCard serverId={id} n={n} />
        <BedrockCard serverId={id} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <JoinCard n={n} />
      <div className="grid gap-6 xl:grid-cols-2">
        <PlayitCard serverId={id} n={n} />
        <PortForwardCard serverId={id} n={n} />
      </div>
      <BedrockCard serverId={id} />
      <div className="grid gap-6 xl:grid-cols-2">
        <NgrokCard serverId={id} n={n} />
        <TailscaleCard serverId={id} n={n} />
      </div>
      <CloudflareCard n={n} />
    </div>
  );
}

type NetView = inferOutput<ReturnType<typeof useTRPC>["network"]["server"]>;

/** A server on a VPS: one public address, the host firewall, and the outside test. */
function VpsCard({ serverId, n }: { serverId: string; n: NetView }) {
  const test = useTest(serverId);
  const v = n.vps;
  if (!v) return null;
  const testing = test.isPending && test.variables?.via === "public";
  const firewallText =
    v.firewall === "active"
      ? v.gameOpen
        ? `The firewall on ${n.host.name} lets players in on TCP ${n.port}.`
        : `The firewall on ${n.host.name} does not allow TCP ${n.port} yet; the panel opens it within seconds of a change.`
      : v.firewall === null
        ? "Could not read the host firewall."
        : `${n.host.name} has no active firewall, so every port is open. Turn it on under Hosts → Security.`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>How players join</CardTitle>
        <CardDescription>
          This server runs on {n.host.name}, which has its own public address: no port forwarding or
          tunnel needed. Java Edition players add it in Multiplayer → Add Server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2.5">
            <Globe className="size-4 text-muted-foreground" /> Anywhere
          </span>
          {n.addresses.publicIpv4 ? <Address value={n.addresses.publicIpv4} /> : "—"}
        </div>
        {n.addresses.bedrockPublic && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2.5">
              <Smartphone className="size-4 text-muted-foreground" /> Bedrock (address, port)
            </span>
            <Address value={n.addresses.bedrockPublic} />
          </div>
        )}
        <p className="flex gap-1.5 text-muted-foreground">
          {v.firewall === "active" && v.gameOpen ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          {firewallText}
        </p>
        <p className="text-xs text-muted-foreground">
          Some providers also filter traffic before it reaches the VPS (AWS, Oracle and Google
          always; others only if you set it up). If the test below fails, allow TCP {n.port}
          {n.bedrockPort ? ` and UDP ${n.bedrockPort}` : ""} there.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate({ serverId, via: "public" })}
            disabled={test.isPending}
          >
            {testing ? <Loader2 className="animate-spin" /> : <Radar />} Test from the internet
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/hosts">Host settings</Link>
          </Button>
        </div>
        {n.checks.public && <ReachabilityResult result={n.checks.public} />}
      </CardContent>
    </Card>
  );
}

/** Every address that works right now, most useful first. */
function JoinCard({ n }: { n: NetView }) {
  const tunnel = n.playit?.java.find((t) => !t.disabledReason);
  const forwarded = n.upnp.mappings.some((m) => m.key.endsWith(":java") && m.status === "active");
  const publicOk = n.checks.public?.reachable === true;
  const rows: Array<{ icon: React.ReactNode; label: string; value: string | null; note: string }> =
    [
      {
        icon: <Waypoints className="size-4" />,
        label: "Anywhere, via playit.gg",
        value: tunnel?.address ?? null,
        note: tunnel
          ? "Share this with friends."
          : n.playit?.linked
            ? "Add a tunnel below."
            : "Not set up.",
      },
      {
        icon: <Globe className="size-4" />,
        label: "Anywhere, via your public address",
        value: forwarded || publicOk ? n.addresses.publicIpv4 : null,
        note: publicOk
          ? "Tested from the internet."
          : forwarded
            ? "Forwarded; test it below."
            : "Needs port forwarding.",
      },
      {
        icon: <Home className="size-4" />,
        label: "Same Wi-Fi or network",
        value: n.addresses.lan,
        note: "Works for anyone on your network.",
      },
    ];
  if (n.ngrok?.shared && n.ngrok.configured) {
    rows.push({
      icon: <Cable className="size-4" />,
      label: "Anywhere, via ngrok",
      value: n.ngrok.address,
      note: n.ngrok.address ? "Changes when ngrok restarts." : (n.ngrok.error ?? "Starting ngrok…"),
    });
  }
  if (n.tailscale?.funnelAddress) {
    rows.push({
      icon: <Radar className="size-4" />,
      label: "Anywhere, via Tailscale Funnel",
      value: n.tailscale.funnelAddress,
      note: "Players need nothing installed.",
    });
  }
  for (const r of n.cloudflare?.mine ?? []) {
    rows.push({
      icon: <Cloud className="size-4" />,
      label: "Cloudflare Tunnel",
      value: r.hostname,
      note: "Players run cloudflared first (see below).",
    });
  }
  const tailnet = n.tailscale?.address ?? n.addresses.tailscale;
  if (tailnet) {
    rows.push({
      icon: <Radar className="size-4" />,
      label: "Tailscale (private)",
      value: tailnet,
      note: "For people in your tailnet or shared this computer.",
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>How players join</CardTitle>
        <CardDescription>
          Java Edition players add one of these in Multiplayer → Add Server.
          {n.bedrockPort ? ` Bedrock players use port ${n.bedrockPort} (see below).` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li
              key={r.label}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
            >
              <span className="flex items-center gap-2.5 text-sm">
                <span className="text-muted-foreground">{r.icon}</span>
                <span>
                  {r.label}
                  <span className="block text-xs text-muted-foreground">{r.note}</span>
                </span>
              </span>
              {r.value ? (
                <Address value={r.value} />
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function useTest(serverId: string) {
  const trpc = useTRPC();
  return useMutation(
    trpc.network.test.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({
          queryKey: trpc.network.server.queryKey({ serverId }),
        }),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
}

function PlayitCard({ serverId, n }: { serverId: string; n: NetView }) {
  const test = useTest(serverId);
  const p = n.playit;
  const testing = test.isPending && test.variables?.via === "playit";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Waypoints className="size-4" /> playit.gg tunnel
          <Badge variant="outline">Recommended</Badge>
          {p?.linked && <TunnelStateBadge state={p.state} />}
        </CardTitle>
        <CardDescription>
          A public address without touching your router. Works behind any internet provider, even
          ones that block port forwarding. Free.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!p ? (
          <p className="text-muted-foreground">playit.gg runs on this computer only.</p>
        ) : !p.linked ? (
          <PlayitLink />
        ) : p.locked ? (
          <p className="text-muted-foreground">
            Log in again to start the tunnel: its key is stored encrypted with your password.
          </p>
        ) : (
          <>
            {p.error && <p className="text-destructive">{p.error}</p>}
            {p.notices.map((x) => (
              <div
                key={x.message}
                className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  <p className="font-medium">playit.gg: {x.message}</p>
                  {/verif/i.test(x.message) && (
                    <p className="text-muted-foreground">
                      playit.gg does not hand out tunnel addresses until you confirm your email.
                      Open the email playit.gg sent you (check spam), then add the tunnel below.
                    </p>
                  )}
                  <a
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                    href={x.link ?? "https://playit.gg/account"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink className="size-3.5" /> Open playit.gg
                  </a>
                </div>
              </div>
            ))}
            {p.java.length > 0 ? (
              <div className="space-y-2">
                {p.java.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-2">
                    <Address value={t.address} />
                    <span className="text-xs text-muted-foreground">
                      {t.name} → {t.localIp}:{t.localPort}
                    </span>
                    {t.disabledReason && (
                      <Badge variant="danger">Disabled: {t.disabledReason}</Badge>
                    )}
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testing}
                  onClick={() => test.mutate({ serverId, via: "playit" })}
                >
                  {testing ? <Loader2 className="animate-spin" /> : <Radar />} Test the tunnel
                </Button>
              </div>
            ) : (
              <AddTunnelSteps
                serverId={serverId}
                port={n.port}
                kind="java"
                canCreate={!p.createRefused}
              />
            )}
            {n.bedrockPort && p.bedrock.length === 0 && (
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer">Bedrock players through playit.gg</summary>
                <div className="mt-3">
                  <AddTunnelSteps
                    serverId={serverId}
                    port={n.bedrockPort}
                    kind="bedrock"
                    canCreate={!p.createRefused}
                  />
                </div>
              </details>
            )}
            {p.bedrock.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Bedrock:</span>
                <Address value={t.address} />
              </div>
            ))}
            {p.others.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Other tunnels on this agent:{" "}
                {p.others
                  .map((t) => `${t.address} → ${t.localIp}:${t.localPort ?? "?"}`)
                  .join(", ")}
              </p>
            )}
            {p.pending.map((x) => (
              <p key={x.id} className="text-xs text-muted-foreground">
                {x.name}: {x.status}
              </p>
            ))}
          </>
        )}
        {test.data && test.variables?.via === "playit" ? (
          <ReachabilityResult result={test.data as Reachability} />
        ) : (
          n.checks.playit && <ReachabilityResult result={n.checks.playit as Reachability} />
        )}
        <p className="text-xs text-muted-foreground">
          The playit.gg agent runs in the background and keeps running while the panel is closed.
          Manage it on the{" "}
          <Link to="/hosts" className="text-primary hover:underline">
            Hosts
          </Link>{" "}
          page.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Linking gives playit.gg an agent, not an address: a tunnel has to exist
 * for this server's port. The panel tries to create it; playit.gg may only
 * allow that on its website, so the exact values to enter are always shown.
 */
function AddTunnelSteps({
  serverId,
  port,
  kind,
  canCreate,
}: {
  serverId: string;
  port: number;
  kind: "java" | "bedrock";
  canCreate: boolean;
}) {
  const trpc = useTRPC();
  const create = useMutation(
    trpc.network.playitCreateTunnel.mutationOptions({
      onSuccess: (r) => {
        if (r.created) toast.success(r.message);
        else toast.error(r.message);
        void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const label = kind === "bedrock" ? "Minecraft Bedrock" : "Minecraft Java";
  return (
    <div className="space-y-3">
      <p className="font-medium">
        Linked. One more step: this server needs a tunnel, which gives it its address.
      </p>
      {canCreate && (
        <Button
          size="sm"
          onClick={() => create.mutate({ serverId, kind })}
          disabled={create.isPending}
        >
          {create.isPending ? <Loader2 className="animate-spin" /> : <Waypoints />} Create the
          tunnel for me
        </Button>
      )}
      <div className="rounded-md border border-border p-3">
        <p>{canCreate ? "Or add it on playit.gg yourself:" : "Add it on playit.gg:"}</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Open playit.gg → <strong>Tunnels</strong> → <strong>Add Tunnel</strong>.
          </li>
          <li>
            Tunnel type: <strong>{label}</strong>.
          </li>
          <li>Agent: the one you linked (named after this computer, or "cubehold").</li>
          <li>
            Local address <code className="rounded bg-muted px-1">127.0.0.1</code>, local port{" "}
            <code className="rounded bg-muted px-1">{port}</code>, then <strong>Add</strong>.
          </li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button asChild size="sm" variant="outline">
            <a href="https://playit.gg/account/tunnels" target="_blank" rel="noreferrer">
              <ExternalLink /> Open playit.gg
            </a>
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Checking every 5 seconds; the address
            appears here once the tunnel exists.
          </span>
        </div>
      </div>
    </div>
  );
}

const wanText = {
  public: null,
  cgnat:
    "Your internet provider shares one public address between customers (CGNAT). Port forwarding cannot work here; use playit.gg.",
  "double-nat":
    "Another router sits in front of yours. Forward the port on both routers, or use playit.gg.",
  unknown:
    "No router answered UPnP. Forward the port by hand in your router's settings, or use playit.gg.",
} as const;

function PortForwardCard({ serverId, n }: { serverId: string; n: NetView }) {
  const trpc = useTRPC();
  const test = useTest(serverId);
  const setUpnp = useMutation(
    trpc.network.setUpnp.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(trpc.network.server.queryKey({ serverId }), data);
        const failed = data.upnp.mappings.find((m) => m.status === "failed");
        if (failed) toast.error(failed.error ?? "Port forwarding failed");
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const fixFirewall = useMutation(
    trpc.network.fixFirewall.mutationOptions({
      onSuccess: () => {
        toast.success("Windows Firewall updated");
        void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.security.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const router = n.network?.router;
  const wan = n.network?.vpn
    ? "Internet traffic goes through a VPN right now, so port forwarding will not reach this computer while it is on."
    : wanText[n.network?.wan ?? "unknown"];
  const testing = test.isPending && test.variables?.via === "public";
  const fw = n.firewall;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Router className="size-4" /> Port forwarding
        </CardTitle>
        <CardDescription>
          Players connect to your own public address and the router passes them to this computer.
          Fastest connection, but it depends on your router and provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-1.5">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Public address</span>
            {n.addresses.publicIpv4 ? <Address value={n.addresses.publicIpv4} /> : "unknown"}
          </p>
          {router && (
            <p className="text-muted-foreground">
              Router: {router.name ?? router.model ?? "found"}{" "}
              <a
                className="text-primary hover:underline"
                href={`http://${router.host}`}
                target="_blank"
                rel="noreferrer"
              >
                {router.host}
              </a>
            </p>
          )}
          {wan && (
            <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {wan}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <Label htmlFor="upnp">Forward automatically (UPnP)</Label>
            <p className="text-xs text-muted-foreground">
              Opens TCP {n.port}
              {n.bedrockPort ? ` and UDP ${n.bedrockPort}` : ""} on the router, renewed every 20
              minutes while this computer runs, and closed when the panel's agent stops.
            </p>
          </div>
          <Switch
            id="upnp"
            checked={n.upnp.enabled}
            disabled={setUpnp.isPending || !router}
            onCheckedChange={(v) => setUpnp.mutate({ serverId, enabled: v })}
          />
        </div>
        {n.upnp.mappings.length > 0 && (
          <ul className="space-y-1">
            {n.upnp.mappings.map((m) => (
              <li key={m.key} className="flex items-start gap-2">
                {m.status === "active" ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : m.status === "pending" ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <span>
                  {m.protocol} {m.port} → {m.internalClient ?? n.network?.lanIp ?? "this computer"}
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    {m.status === "active"
                      ? `· forwarded${m.updatedAt ? `, renewed ${timeAgo(m.updatedAt)}` : ""}${m.leaseSeconds === 0 ? " (permanent: the router does not support timed forwards)" : ""}`
                      : m.status === "failed"
                        ? `· ${m.error}`
                        : "· working on it"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {fw?.supported && (
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 rounded-md border p-3",
              fw.game?.allowed === false ? "border-destructive/40" : "border-border",
            )}
          >
            <p className="flex items-start gap-2">
              {fw.game?.allowed === false ? (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : fw.programWide ? (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              ) : (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
              )}
              <span>
                {fw.game?.allowed === false
                  ? `Windows Firewall blocks port ${n.port}.`
                  : fw.programWide
                    ? "Windows Firewall lets Java in on every port."
                    : `Windows Firewall allows port ${n.port}.`}
                {fw.network && (
                  <span className="block text-xs text-muted-foreground">
                    Network "{fw.network.name}" is set to {fw.network.category.toLowerCase()}.
                  </span>
                )}
              </span>
            </p>
            {(fw.game?.allowed === false || fw.programWide || fw.blocked) && (
              <Button
                size="sm"
                variant="outline"
                disabled={fixFirewall.isPending}
                onClick={() => fixFirewall.mutate({ serverId })}
                title="Windows asks for permission"
              >
                {fixFirewall.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {fw.game?.allowed === false ? "Allow the game port" : "Allow game ports only"}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Button
            size="sm"
            variant="outline"
            disabled={testing || !n.addresses.publicIpv4}
            onClick={() => test.mutate({ serverId, via: "public" })}
          >
            {testing ? <Loader2 className="animate-spin" /> : <Radar />} Test from the internet
          </Button>
          {testing && (
            <p className="text-xs text-muted-foreground">
              Asking mcstatus.io to connect from outside. Their answers are cached for a minute, so
              this can take up to a minute.
            </p>
          )}
          {test.data && test.variables?.via === "public" ? (
            <ReachabilityResult result={test.data as Reachability} />
          ) : (
            n.checks.public && <ReachabilityResult result={n.checks.public as Reachability} />
          )}
        </div>

        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer">Forward the port by hand</summary>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>
              Open your router's settings
              {router ? (
                <>
                  {" "}
                  at{" "}
                  <a
                    className="text-primary hover:underline"
                    href={`http://${router.host}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    http://{router.host}
                  </a>
                </>
              ) : (
                " (the address is usually on a sticker on the router)"
              )}
              .
            </li>
            <li>Find "Port forwarding" (sometimes under NAT, Virtual servers or Gaming).</li>
            <li>
              Forward TCP port <strong>{n.port}</strong> to{" "}
              <strong>{n.network?.lanIp ?? "this computer's address"}</strong>
              {n.bedrockPort ? (
                <>
                  , and UDP port <strong>{n.bedrockPort}</strong> for Bedrock players
                </>
              ) : null}
              .
            </li>
            <li>Test from the internet above.</li>
          </ol>
        </details>
      </CardContent>
    </Card>
  );
}

function BedrockCard({ serverId }: { serverId: string }) {
  const trpc = useTRPC();
  const status = useQuery(trpc.bedrock.status.queryOptions({ serverId }));
  const set = useMutation(
    trpc.bedrock.set.mutationOptions({
      onSuccess: (r, vars) => {
        toast.success(
          vars.enabled
            ? `Bedrock players can join on port ${r.port} after a restart.`
            : "Geyser and Floodgate removed.",
        );
        for (const n of r.notes) toast.message(n);
        void queryClient.invalidateQueries({ queryKey: trpc.bedrock.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.addons.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4" /> Bedrock players
        </CardTitle>
        <CardDescription>
          Let phones, tablets, consoles and Windows Bedrock join this Java server, through Geyser
          and Floodgate. Bedrock players do not need a Java account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!s ? (
          <p className="text-muted-foreground">
            {status.isError ? errorMessage(status.error) : "Checking…"}
          </p>
        ) : !s.supported ? (
          <p className="text-muted-foreground">{s.reason}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="bedrock">Allow Bedrock Edition</Label>
              <div className="flex items-center gap-2">
                {set.isPending && <Loader2 className="size-4 animate-spin" />}
                <Switch
                  id="bedrock"
                  checked={s.enabled}
                  disabled={set.isPending || (s.enabled && s.running)}
                  onCheckedChange={(v) => set.mutate({ serverId, enabled: v })}
                />
              </div>
            </div>
            {s.enabled && s.running && (
              <p className="text-xs text-muted-foreground">Stop the server to turn this off.</p>
            )}
            {s.enabled && (
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  Bedrock port:{" "}
                  <strong className="text-foreground">
                    UDP {s.port ?? "assigned at next start"}
                  </strong>
                </li>
                {[s.geyser, s.floodgate, s.viaversion].map(
                  (i) =>
                    i && (
                      <li key={i.file}>
                        {i.name} {i.version ?? ""}
                        {!i.enabled && " (disabled)"}
                      </li>
                    ),
                )}
                <li>
                  Bedrock players show up with a dot before their name (for example .Steve), so they
                  never clash with Java players.
                </li>
                <li>
                  With the whitelist on, add Bedrock players in the console with{" "}
                  <code className="rounded bg-muted px-1">fwhitelist add GamerTag</code>.
                </li>
              </ul>
            )}
            {!s.enabled && s.needsViaVersion && (
              <p className="text-xs text-muted-foreground">
                Geyser speaks the newest Minecraft version, so ViaVersion is added as well.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
