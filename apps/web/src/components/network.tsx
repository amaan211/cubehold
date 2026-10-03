import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  Unlink,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, timeAgo } from "@/lib/utils";

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={label ?? `Copy ${value}`}
      title="Copy"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error("Could not copy"),
        )
      }
    >
      {copied ? <CheckCircle2 className="text-primary" /> : <Copy />}
    </Button>
  );
}

/** An address players type, with a copy button. */
export function Address({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={value}>
      <code
        className={cn(
          "min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
          muted && "text-muted-foreground",
        )}
      >
        {value}
      </code>
      <CopyButton value={value} />
    </span>
  );
}

export interface Reachability {
  reachable: boolean;
  address: string;
  checkedAt: string;
  detail: string;
  hint: string | null;
  answeredBy: "server" | "sleeper" | "test" | null;
}

export function ReachabilityResult({ result }: { result: Reachability }) {
  return (
    <div
      role="status"
      className={cn(
        "flex gap-2 rounded-md border p-2.5 text-sm",
        result.reachable
          ? "border-primary/30 bg-primary/5"
          : "border-destructive/30 bg-destructive/5",
      )}
    >
      {result.reachable ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">
          {result.reachable ? "Reachable" : "Not reachable"} at {result.address}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {timeAgo(result.checkedAt)}
          </span>
        </p>
        <p className="text-muted-foreground">
          {result.detail}
          {result.reachable && result.answeredBy === "test" && (
            <> The server is stopped, so a short test listener answered in its place.</>
          )}
          {result.reachable && result.answeredBy === "sleeper" && (
            <> The server is sleeping; joining will start it.</>
          )}
        </p>
        {result.hint && <p>{result.hint}</p>}
      </div>
    </div>
  );
}

type ClaimView = {
  url: string;
  state: keyof typeof claimText;
  error: string | null;
  startedAt: string;
};

const CLAIM_ACTIVE: string[] = ["waiting-visit", "waiting-approval", "linking"];

const claimText = {
  "waiting-visit": "Waiting for you to open the link…",
  "waiting-approval": "Approve the agent on playit.gg…",
  linking: "Approved; finishing setup…",
  done: "Linked.",
  rejected: "The agent was not approved on playit.gg.",
  expired: "The link expired. Start again.",
  failed: "Linking failed.",
} as const;

/**
 * Link this machine to a playit.gg account: shows the approval link and
 * follows the claim until playit.gg hands over the agent's secret.
 */
export function PlayitLink({ onLinked }: { onLinked?: () => void }) {
  const trpc = useTRPC();
  // The claim just started, until the status query reports it: a status request already in
  // flight when linking starts would otherwise answer "no claim" and stop the polling.
  const [started, setStarted] = useState<ClaimView | null>(null);
  const startedRef = useRef(false);
  const status = useQuery(
    trpc.network.playitStatus.queryOptions(undefined, {
      refetchInterval: (q) => {
        const claim = q.state.data?.claim;
        return startedRef.current || (claim && CLAIM_ACTIVE.includes(claim.state)) ? 1_500 : false;
      },
    }),
  );
  const reported = status.data?.claim ?? null;
  const reportedUrl = reported?.url ?? null;
  useEffect(() => {
    if (started && reportedUrl === started.url) {
      startedRef.current = false;
      setStarted(null);
    }
  }, [reportedUrl, started]);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() }).then(() => onLinked?.());
  const claimState = status.data?.claim?.state;
  // Once playit.gg hands over the agent, everything that shows tunnels needs a refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the claim finishes, not on every render
  useEffect(() => {
    if (claimState === "done") void invalidate();
  }, [claimState]);
  const link = useMutation(
    trpc.network.playitLink.mutationOptions({
      onSuccess: (claim) => {
        window.open(claim.url, "_blank", "noopener");
        startedRef.current = true;
        setStarted(claim);
        void status.refetch();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const cancel = useMutation(
    trpc.network.playitCancel.mutationOptions({
      onSuccess: () => {
        startedRef.current = false;
        setStarted(null);
        void invalidate();
      },
    }),
  );
  // Until the server reports the new claim, show it rather than an older finished one.
  const claim = started && reportedUrl !== started.url ? started : reported;
  const active = claim && CLAIM_ACTIVE.includes(claim.state);

  if (active && claim) {
    return (
      <div className="space-y-3 rounded-md border border-border p-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <Loader2 className="size-4 animate-spin" /> {claimText[claim.state]}
        </p>
        <p className="text-muted-foreground">
          A playit.gg page opened in a new tab. Sign in (or create a free account) and approve the
          agent. If no tab opened, use the button.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={claim.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open playit.gg
            </a>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        </div>
        {claim.error && <p className="text-xs text-muted-foreground">{claim.error}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {claim && claim.state !== "done" && (
        <p className="text-sm text-destructive">
          {claimText[claim.state]} {claim.error}
        </p>
      )}
      <Button
        size="sm"
        onClick={() => link.mutate()}
        disabled={link.isPending || status.data?.supported === false}
      >
        {link.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} Link playit.gg
      </Button>
      {status.data?.supported === false && (
        <p className="text-xs text-muted-foreground">
          playit.gg has no agent for this operating system.
        </p>
      )}
    </div>
  );
}

const tunnelBadge = {
  connected: { variant: "success", label: "Connected" },
  starting: { variant: "warning", label: "Connecting" },
  error: { variant: "danger", label: "Problem" },
  stopped: { variant: "outline", label: "Stopped" },
} as const;

export function TunnelStateBadge({ state }: { state: keyof typeof tunnelBadge }) {
  const b = tunnelBadge[state];
  return (
    <Badge variant={b.variant} dot>
      {b.label}
    </Badge>
  );
}

/** playit.gg on the Hosts page: link, status, daemon log, unlink. */
export function PlayitHostPanel() {
  const trpc = useTRPC();
  const status = useQuery(
    trpc.network.playitStatus.queryOptions(undefined, { refetchInterval: 5_000 }),
  );
  const restart = useMutation(
    trpc.network.playitRestart.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() }),
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const unlink = useMutation(
    trpc.network.playitUnlink.mutationOptions({
      onSuccess: () => {
        toast.success("Unlinked. The agent stays listed on playit.gg until you delete it there.");
        void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const s = status.data;
  if (!s) return null;
  if (!s.linked) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          playit.gg gives your servers a public address without touching the router, and works
          behind any provider. Free; you need a playit.gg account.
        </p>
        <PlayitLink />
      </div>
    );
  }
  const state = s.tunnel?.state ?? "stopped";
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <TunnelStateBadge state={state} />
        {s.accountStatus && (
          <span className="text-xs text-muted-foreground">
            {s.accountStatus === "guest" ? "Guest account" : `Account: ${s.accountStatus}`}
          </span>
        )}
        {s.agentId && (
          <span className="font-mono text-xs text-muted-foreground" title="playit.gg agent id">
            {s.agentId.slice(0, 8)}
          </span>
        )}
      </div>
      {s.locked && (
        <p className="text-muted-foreground">
          Log in again to start the tunnel: its key is stored encrypted with your password.
        </p>
      )}
      {(s.error || s.tunnel?.error) && (
        <p className="text-destructive">{s.error ?? s.tunnel?.error}</p>
      )}
      {s.notices.map((n) => (
        <p key={n.message} className="flex gap-1.5 text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" /> {n.message}
          {n.link && (
            <a
              className="text-primary hover:underline"
              href={n.link}
              target="_blank"
              rel="noreferrer"
            >
              Resolve
            </a>
          )}
        </p>
      ))}
      <ul className="space-y-1">
        {s.tunnels.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2">
            <Address value={t.address} />
            <span className="text-xs text-muted-foreground">
              {t.tunnelTypeLabel} → {t.localIp}:{t.localPort ?? "?"}
              {t.disabledReason ? ` · disabled: ${t.disabledReason}` : ""}
            </span>
          </li>
        ))}
        {s.tunnels.length === 0 && (
          <li className="text-muted-foreground">
            No tunnels yet. Each server's Network tab shows what to add on playit.gg.
          </li>
        )}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <a href="https://playit.gg/account/tunnels" target="_blank" rel="noreferrer">
            <ExternalLink /> Tunnels on playit.gg
          </a>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => restart.mutate()}
          disabled={restart.isPending}
        >
          <RefreshCw className={cn(restart.isPending && "animate-spin")} /> Restart agent
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => unlink.mutate()}
          disabled={unlink.isPending}
        >
          <Unlink /> Unlink
        </Button>
      </div>
      {s.tunnel && s.tunnel.lines.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">playit log</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap">
            {s.tunnel.lines.slice(-40).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
