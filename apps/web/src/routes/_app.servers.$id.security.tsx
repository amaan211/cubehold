import type { CheckStatus, SecurityCheck } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { inferOutput } from "@trpc/tanstack-react-query";
import { Globe, Home, Loader2, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { gradeClass, statusIcon } from "@/components/access-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { cn, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/security")({
  component: SecurityTab,
});

type Report = inferOutput<ReturnType<typeof useTRPC>["security"]["report"]>;

function SecurityTab() {
  const { id } = Route.useParams();
  const trpc = useTRPC();
  const report = useQuery(
    trpc.security.report.queryOptions({ serverId: id }, { refetchInterval: 30_000 }),
  );
  const [hardening, setHardening] = useState(false);
  const refresh = useMutation({
    mutationFn: () =>
      queryClient.fetchQuery(trpc.security.report.queryOptions({ serverId: id, fresh: true })),
    onSuccess: (data) =>
      queryClient.setQueryData(trpc.security.report.queryKey({ serverId: id }), data),
  });
  const fix = useMutation(
    trpc.security.fix.mutationOptions({
      onSuccess: (r) => {
        queryClient.setQueryData(trpc.security.report.queryKey({ serverId: id }), r.report);
        void queryClient.invalidateQueries({ queryKey: trpc.network.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.players.pathKey() });
        toast.success(r.message);
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const r = report.data;
  if (report.isError)
    return <p className="text-sm text-destructive">{errorMessage(report.error)}</p>;
  if (!r) return <p className="text-sm text-muted-foreground">Checking…</p>;
  const problems = r.checks.filter((c) => c.status === "fail" || c.status === "warn");

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-6 pt-6">
          <ScoreRing score={r.score} grade={r.grade} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-lg font-semibold">
              {problems.length === 0
                ? "Nothing to fix."
                : `${problems.length} thing${problems.length === 1 ? "" : "s"} to look at.`}
            </p>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {r.exposure.internet ? (
                <>
                  <Globe className="size-4" /> Reachable from the internet (
                  {r.exposure.via
                    .map(
                      (v) =>
                        (
                          ({
                            upnp: "port forwarding",
                            playit: "playit.gg",
                            ngrok: "ngrok",
                            cloudflare: "Cloudflare Tunnel",
                            funnel: "Tailscale Funnel",
                            tested: "tested",
                            vps: "a VPS with a public address",
                          }) as Record<string, string>
                        )[v] ?? v,
                    )
                    .join(", ")}
                  ), so problems count more.
                </>
              ) : (
                <>
                  <Home className="size-4" /> Only reachable on your network, as far as the panel
                  knows.
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground">Checked {timeAgo(r.checkedAt)}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              <RefreshCw className={cn(refresh.isPending && "animate-spin")} /> Check again
            </Button>
            <Button size="sm" onClick={() => setHardening(true)}>
              <Sparkles /> Harden this server
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {sortChecks(r.checks).map((c) => (
              <CheckRow
                key={c.id}
                check={c}
                pending={fix.isPending && fix.variables?.checkId === c.id}
                onFix={() => fix.mutate({ serverId: id, checkId: c.id })}
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      {r.bundle.length > 0 && <BundleCard serverId={id} report={r} />}

      <HardenDialog serverId={id} report={r} open={hardening} onClose={() => setHardening(false)} />
    </div>
  );
}

const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
const SEVERITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function sortChecks(checks: SecurityCheck[]): SecurityCheck[] {
  return [...checks].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      (SEVERITY[a.severity] ?? 9) - (SEVERITY[b.severity] ?? 9),
  );
}

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div
      className="relative size-24 shrink-0"
      role="img"
      aria-label={`Security score ${score} of 100, grade ${grade}`}
    >
      <svg viewBox="0 0 80 80" className="size-24 -rotate-90">
        <title>Security score</title>
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
          className={cn("stroke-current transition-[stroke-dasharray]", gradeClass(grade))}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        <span>
          <span className={cn("block text-3xl font-bold", gradeClass(grade))}>{grade}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{score}/100</span>
        </span>
      </div>
    </div>
  );
}

function CheckRow({
  check: c,
  pending,
  onFix,
}: {
  check: SecurityCheck;
  pending: boolean;
  onFix: () => void;
}) {
  const s = statusIcon[c.status];
  const showFix = c.fix && (c.status === "fail" || c.status === "warn" || c.id === "whitelist");
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 gap-3">
        <s.Icon className={cn("mt-0.5 size-5 shrink-0", s.className)} aria-label={s.label} />
        <div className="min-w-0 space-y-0.5 text-sm">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {c.title}
            {(c.status === "fail" || c.status === "warn") && (
              <Badge
                variant={c.severity === "critical" || c.severity === "high" ? "danger" : "warning"}
              >
                {c.severity}
              </Badge>
            )}
          </p>
          <p>{c.summary}</p>
          {c.detail && <p className="text-muted-foreground">{c.detail}</p>}
        </div>
      </div>
      {showFix && c.fix && (
        <div className="flex flex-col items-end gap-1">
          <Button
            size="sm"
            variant={c.status === "fail" ? "default" : "outline"}
            onClick={onFix}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="animate-spin" />
            ) : c.fix.kind === "admin" ? (
              <ShieldCheck />
            ) : null}
            {c.fix.label}
          </Button>
          <span className="text-xs text-muted-foreground">
            {c.fix.kind === "admin"
              ? "Windows asks for permission"
              : c.fix.kind === "host"
                ? "Changes the VPS over SSH"
                : c.fix.restart
                  ? "Applies after a restart"
                  : null}
          </span>
        </div>
      )}
    </li>
  );
}

function BundleCard({ serverId, report }: { serverId: string; report: Report }) {
  const trpc = useTRPC();
  const install = useMutation(
    trpc.addons.install.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Installed ${r.installed.join(", ")}`);
        for (const n of r.notes) toast.message(n);
        void queryClient.invalidateQueries({ queryKey: trpc.security.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.addons.pathKey() });
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Recommended {report.bundle.some((b) => b.id === "ledger") ? "mods" : "plugins"}
        </CardTitle>
        <CardDescription>
          Useful the moment people you do not know well start playing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {report.bundle.map((b) => (
            <li
              key={b.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {b.name}
                  {!b.recommended && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">optional</span>
                  )}
                </p>
                <p className="text-muted-foreground">{b.description}</p>
              </div>
              {b.installed ? (
                <Badge variant="success" dot>
                  Installed
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={install.isPending}
                  onClick={() =>
                    install.mutate({
                      serverId,
                      source: "modrinth",
                      projectId: b.id,
                      withDependencies: true,
                    })
                  }
                >
                  {install.isPending && install.variables?.projectId === b.id && (
                    <Loader2 className="animate-spin" />
                  )}
                  Install
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function HardenDialog({
  serverId,
  report,
  open,
  onClose,
}: {
  serverId: string;
  report: Report;
  open: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const auto = report.checks.filter(
    (c) =>
      c.fix?.kind === "auto" &&
      c.id !== "grief-log" &&
      (c.status === "fail" || c.status === "warn" || c.id === "whitelist") &&
      c.status !== "pass",
  );
  const admin = report.checks.filter((c) => c.fix?.kind === "admin" && c.status !== "pass");
  const host = report.checks.filter((c) => c.fix?.kind === "host" && c.status !== "pass");
  const available = report.bundle.filter((b) => !b.installed);
  const [plugins, setPlugins] = useState<string[] | null>(null);
  const chosen = plugins ?? available.filter((b) => b.recommended).map((b) => b.id);
  const harden = useMutation(
    trpc.security.harden.mutationOptions({
      onSuccess: (r) => {
        queryClient.setQueryData(trpc.security.report.queryKey({ serverId }), r.report);
        void queryClient.invalidateQueries({ queryKey: trpc.addons.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.players.pathKey() });
        if (r.done.length) toast.success(r.done.join(" "));
        for (const f of r.failed) toast.error(f);
        if (!r.done.length && !r.failed.length) toast.message("Already hardened.");
        setPlugins(null);
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Harden this server"
      description="Applies the recommended settings in one go. Anything that needs a restart takes effect at the next start."
    >
      <div className="space-y-4 text-sm">
        {auto.length > 0 ? (
          <div>
            <p className="font-medium">Settings</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {auto.map((c) => (
                <li key={c.id}>{c.fix?.label}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground">The settings are already hardened.</p>
        )}
        {available.length > 0 && (
          <fieldset>
            <legend className="font-medium">Also install</legend>
            {available.map((b) => (
              <label key={b.id} className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={chosen.includes(b.id)}
                  onChange={(e) =>
                    setPlugins(
                      e.target.checked ? [...chosen, b.id] : chosen.filter((x) => x !== b.id),
                    )
                  }
                />
                <span>
                  {b.name}
                  <span className="block text-xs text-muted-foreground">{b.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {admin.length > 0 && (
          <p className="text-muted-foreground">
            The Windows Firewall fix is separate, since Windows asks for permission: use its button
            in the list.
          </p>
        )}
        {host.length > 0 && (
          <p className="text-muted-foreground">
            Changes to the VPS itself ({host.map((c) => c.title.toLowerCase()).join(", ")}) have
            their own buttons in the list, since they affect every server on it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={harden.isPending || (auto.length === 0 && chosen.length === 0)}
            onClick={() => harden.mutate({ serverId, plugins: chosen })}
          >
            {harden.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Apply
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
