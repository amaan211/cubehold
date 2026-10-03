import { useMutation } from "@tanstack/react-query";
import type { inferOutput } from "@trpc/tanstack-react-query";
import {
  AlertTriangle,
  Cable,
  Cloud,
  Download,
  ExternalLink,
  LogIn,
  Radar,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Address, CopyButton, TunnelStateBadge } from "@/components/network";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type NetView = inferOutput<ReturnType<typeof useTRPC>["network"]["server"]>;

function useRefresh() {
  const trpc = useTRPC();
  return () => {
    void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.security.pathKey() });
  };
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="text-primary hover:underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>;
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <span>{children}</span>
    </p>
  );
}

function Log({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Log</summary>
      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap">
        {lines.join("\n")}
      </pre>
    </details>
  );
}

/** Paste box for a token, used by ngrok and Cloudflare. */
function TokenForm({
  id,
  label,
  placeholder,
  pending,
  onSave,
}: {
  id: string;
  label: string;
  placeholder: string;
  pending: boolean;
  onSave: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) onSave(token.trim());
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={pending || !token.trim()}>
        Save
      </Button>
    </form>
  );
}

function Controls({ provider }: { provider: "ngrok" | "cloudflared" }) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const restart = useMutation(
    trpc.network.tunnelRestart.mutationOptions({
      onSuccess: refresh,
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const clear = useMutation(
    trpc.network.tunnelClear.mutationOptions({
      onSuccess: () => {
        toast.success("Removed. The token is deleted from the panel.");
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => restart.mutate({ provider })}
        disabled={restart.isPending}
      >
        <RefreshCw className={cn(restart.isPending && "animate-spin")} /> Restart
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive"
        onClick={() => clear.mutate({ provider })}
        disabled={clear.isPending}
      >
        <Trash2 /> Remove token
      </Button>
    </div>
  );
}

// --- ngrok -----------------------------------------------------------------------------------

export function NgrokCard({ serverId, n }: { serverId: string; n: NetView }) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const save = useMutation(
    trpc.network.ngrokSetToken.mutationOptions({
      onSuccess: () => {
        toast.success("Saved. ngrok is downloaded and started when a server is shared.");
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const share = useMutation(
    trpc.network.ngrokShare.mutationOptions({
      onSuccess: refresh,
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const g = n.ngrok;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Cable className="size-4" /> ngrok
          {g?.configured && g.shared && <TunnelStateBadge state={g.state} />}
        </CardTitle>
        <CardDescription>
          A public TCP address from ngrok. Quick to set up, but the address changes whenever ngrok
          restarts (unless you pay for a reserved one).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!g ? (
          <p className="text-muted-foreground">ngrok runs on this computer only.</p>
        ) : !g.supported ? (
          <p className="text-muted-foreground">ngrok has no build for this system.</p>
        ) : !g.configured ? (
          <>
            <Steps>
              <li>
                Create a free account at{" "}
                <ExtLink href="https://dashboard.ngrok.com/signup">ngrok.com</ExtLink>.
              </li>
              <li>
                Add a card to the account:{" "}
                <ExtLink href="https://dashboard.ngrok.com/settings#id-verification">
                  Settings → Verification
                </ExtLink>
                . ngrok requires one before it gives out TCP addresses, even on the free plan; it is
                not charged.
              </li>
              <li>
                Copy your authtoken from{" "}
                <ExtLink href="https://dashboard.ngrok.com/get-started/your-authtoken">
                  Your Authtoken
                </ExtLink>{" "}
                and paste it here. The panel downloads ngrok, checks its signature and runs it for
                you.
              </li>
            </Steps>
            <TokenForm
              id="ngrok-token"
              label="ngrok authtoken"
              placeholder="2abc…"
              pending={save.isPending}
              onSave={(token) => save.mutate({ token })}
            />
          </>
        ) : g.locked ? (
          <p className="text-muted-foreground">
            Log in again to start ngrok: the authtoken is stored encrypted with your password.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <Label htmlFor="ngrok-share">Share this server through ngrok</Label>
                <p className="text-xs text-muted-foreground">
                  TCP {n.port}. Java Edition only: ngrok does not carry Bedrock (UDP).
                </p>
              </div>
              <Switch
                id="ngrok-share"
                checked={g.shared}
                disabled={share.isPending}
                onCheckedChange={(v) => share.mutate({ serverId, enabled: v })}
              />
            </div>
            {g.shared && g.address && (
              <div className="space-y-1">
                <Address value={g.address} />
                <p className="text-xs text-muted-foreground">
                  Share this address. It changes if ngrok or this computer restarts; check here
                  again then.
                </p>
              </div>
            )}
            {g.error && (
              <Warning>
                {g.error}
                {/card/i.test(g.error) && (
                  <>
                    {" "}
                    <ExtLink href="https://dashboard.ngrok.com/settings#id-verification">
                      Add a card
                    </ExtLink>
                  </>
                )}
              </Warning>
            )}
            <Controls provider="ngrok" />
            <Log lines={g.lines} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --- Tailscale ---------------------------------------------------------------------------------

export function TailscaleCard({ serverId, n }: { serverId: string; n: NetView }) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const [port, setPort] = useState<number | null>(null);
  const [enableUrl, setEnableUrl] = useState<string | null>(null);
  const login = useMutation(
    trpc.network.tailscaleLogin.mutationOptions({
      onSuccess: (r) => {
        if (r.authUrl) window.open(r.authUrl, "_blank", "noopener");
        else toast.message(r.output || "Tailscale is signing in.");
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const install = useMutation(
    trpc.network.tailscaleInstall.mutationOptions({
      onSuccess: (r) => {
        if (r.ok) toast.success("Tailscale is installed. Sign in next.");
        else toast.error(`Installing failed: ${r.output.slice(-300)}`);
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const funnel = useMutation(
    trpc.network.tailscaleFunnel.mutationOptions({
      onSuccess: (r) => {
        setEnableUrl(r.enableUrl);
        if (r.enableUrl) toast.message("Allow Funnel on your tailnet first, then try again.");
        else if (!r.ok) toast.error(r.output.slice(-300) || "Funnel did not start");
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const t = n.tailscale;
  const running = t?.state === "Running";
  const freePorts = (t?.funnelPorts ?? []).filter((p) => !t?.funnelTaken.includes(p));
  const chosen = port ?? t?.funnelPort ?? freePorts[0] ?? 10000;
  const isWindows = navigator.userAgent.includes("Windows");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radar className="size-4" /> Tailscale
        </CardTitle>
        <CardDescription>
          Private: friends who join your tailnet reach the server directly, nothing is opened to the
          internet. Or public through Funnel, with nothing to install for players.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!t ? (
          <p className="text-muted-foreground">Tailscale runs on this computer only.</p>
        ) : !t.installed ? (
          <>
            <p>Tailscale is not installed on this computer.</p>
            <div className="flex flex-wrap gap-2">
              {isWindows && (
                <Button
                  size="sm"
                  onClick={() => install.mutate({ serverId })}
                  disabled={install.isPending}
                >
                  <Download className={cn(install.isPending && "animate-pulse")} />
                  {install.isPending
                    ? "Installing (Windows asks for permission)…"
                    : "Install Tailscale"}
                </Button>
              )}
              <Button asChild size="sm" variant="outline">
                <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                  <ExternalLink /> Download page
                </a>
              </Button>
            </div>
          </>
        ) : !running ? (
          <>
            <p>
              Tailscale is installed but not signed in{t.state ? ` (${t.state})` : ""}. Signing in
              creates your tailnet (free for personal use).
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => login.mutate({ serverId })}
                disabled={login.isPending}
              >
                <LogIn /> Sign in to Tailscale
              </Button>
              {t.authUrl && <ExtLink href={t.authUrl}>Open the sign-in page</ExtLink>}
            </div>
            {t.error && <Warning>{t.error}</Warning>}
          </>
        ) : (
          <>
            <div className="space-y-2">
              <p className="font-medium">Private: for people in your tailnet</p>
              {t.address && <Address value={t.address} />}
              {t.ipAddress && t.ipAddress !== t.address && (
                <p className="text-xs text-muted-foreground">
                  Or by IP: <code className="rounded bg-muted px-1">{t.ipAddress}</code>
                </p>
              )}
              <Steps>
                <li>
                  Open <ExtLink href="https://login.tailscale.com/admin/machines">Machines</ExtLink>
                  , find this computer, choose <strong>⋯ → Share</strong> and send your friend the
                  invite link.
                </li>
                <li>
                  They install Tailscale (
                  <ExtLink href="https://tailscale.com/download">tailscale.com/download</ExtLink>),
                  open the link and accept.
                </li>
                <li>They join the address above in Minecraft.</li>
              </Steps>
            </div>
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="font-medium">Public: Tailscale Funnel</p>
              {t.funnelAddress ? (
                <>
                  <Address value={t.funnelAddress} />
                  <p className="text-xs text-muted-foreground">
                    Anyone can join at this address; players need nothing installed.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => funnel.mutate({ serverId, port: null })}
                    disabled={funnel.isPending}
                  >
                    Stop Funnel
                  </Button>
                </>
              ) : freePorts.length === 0 ? (
                <p className="text-muted-foreground">
                  All three Funnel ports (443, 8443, 10000) are used by other servers.
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="funnel-port">Public port</Label>
                    <Select
                      id="funnel-port"
                      className="w-32"
                      value={String(chosen)}
                      onChange={(e) => setPort(Number(e.target.value))}
                    >
                      {freePorts.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => funnel.mutate({ serverId, port: chosen as 443 | 8443 | 10000 })}
                    disabled={funnel.isPending}
                  >
                    Share publicly
                  </Button>
                </div>
              )}
              {enableUrl && (
                <Warning>
                  Your tailnet does not allow Funnel yet.{" "}
                  <ExtLink href={enableUrl}>Allow it</ExtLink> (one click in the Tailscale admin
                  page), then press Share publicly again.
                </Warning>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --- Cloudflare Tunnel -----------------------------------------------------------------------------

export function CloudflareCard({ n }: { n: NetView }) {
  const trpc = useTRPC();
  const refresh = useRefresh();
  const save = useMutation(
    trpc.network.cloudflaredSetToken.mutationOptions({
      onSuccess: () => {
        toast.success("Saved. cloudflared is downloaded and started.");
        refresh();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const c = n.cloudflare;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Cloud className="size-4" /> Cloudflare Tunnel
          {c?.configured && <TunnelStateBadge state={c.state} />}
        </CardTitle>
        <CardDescription>
          Your own hostname (e.g. mc.yourdomain.com) through Cloudflare, with no port opened. Needs
          a domain on Cloudflare. Cloudflare only passes Minecraft's raw TCP to another cloudflared,
          so every player runs one small command before joining.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!c ? (
          <p className="text-muted-foreground">Cloudflare Tunnel runs on this computer only.</p>
        ) : !c.supported ? (
          <p className="text-muted-foreground">cloudflared has no build for this system.</p>
        ) : !c.configured ? (
          <>
            <Steps>
              <li>
                In the{" "}
                <ExtLink href="https://one.dash.cloudflare.com/">
                  Cloudflare Zero Trust dashboard
                </ExtLink>{" "}
                open <strong>Networks → Tunnels → Create a tunnel</strong>, pick{" "}
                <strong>Cloudflared</strong> and name it (for example "minecraft").
              </li>
              <li>
                On the connector page, copy the install command for any system and paste it below.
                The panel takes the token from it and runs cloudflared itself; do not run the
                command.
              </li>
              <li>
                Under <strong>Public Hostname</strong>, add one: subdomain{" "}
                <code className="rounded bg-muted px-1">mc</code>, your domain, service type{" "}
                <strong>TCP</strong>, URL{" "}
                <code className="rounded bg-muted px-1">localhost:{n.port}</code>.
              </li>
            </Steps>
            <TokenForm
              id="cf-token"
              label="Tunnel token (or the whole install command)"
              placeholder="cloudflared service install eyJh…"
              pending={save.isPending}
              onSave={(token) => save.mutate({ token })}
            />
          </>
        ) : c.locked ? (
          <p className="text-muted-foreground">
            Log in again to start the tunnel: its token is stored encrypted with your password.
          </p>
        ) : (
          <>
            {c.error && <Warning>{c.error}</Warning>}
            {c.mine.length === 0 ? (
              <Warning>
                No public hostname leads to <code>localhost:{n.port}</code> yet. In the tunnel's{" "}
                <strong>Public Hostname</strong> tab, add one with service type TCP and URL{" "}
                <code>localhost:{n.port}</code>
                {c.state === "connected" ? "; it shows up here within seconds." : "."}
              </Warning>
            ) : (
              c.mine.map((r) => <FriendSteps key={r.hostname} hostname={r.hostname} />)
            )}
            {c.routes.filter((r) => r.port !== n.port).length > 0 && (
              <p className="text-xs text-muted-foreground">
                Other hostnames on this tunnel:{" "}
                {c.routes
                  .filter((r) => r.port !== n.port)
                  .map((r) => `${r.hostname} → ${r.service ?? "?"}`)
                  .join(", ")}
              </p>
            )}
            <Controls provider="cloudflared" />
            <Log lines={c.lines} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** What a player does to join through Cloudflare: run cloudflared access, then join localhost. */
function FriendSteps({ hostname }: { hostname: string }) {
  const access = `cloudflared access tcp --hostname ${hostname} --url 127.0.0.1:25565`;
  const os = [
    ["Windows", `winget install --id Cloudflare.cloudflared -e\n${access}`],
    ["macOS", `brew install cloudflared\n${access}`],
    ["Linux", access],
  ] as const;
  return (
    <div className="space-y-2">
      <Address value={hostname} />
      <p>Send players these steps. They keep the command running while they play:</p>
      <div className="grid gap-2 md:grid-cols-3">
        {os.map(([name, cmd]) => (
          <div key={name} className="rounded-md border border-border p-2">
            <div className="flex items-center justify-between text-xs font-medium">
              {name} <CopyButton value={cmd} label={`Copy the ${name} commands`} />
            </div>
            <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">{cmd}</pre>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground">
        Then in Minecraft they join <code className="rounded bg-muted px-1">localhost</code>. On
        Linux, install cloudflared from{" "}
        <ExtLink href="https://pkg.cloudflare.com/">pkg.cloudflare.com</ExtLink> first.
      </p>
    </div>
  );
}
