import type { CheckStatus } from "@cubehold/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Address } from "@/components/network";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export const statusIcon: Record<
  CheckStatus,
  { Icon: typeof Info; className: string; label: string }
> = {
  pass: { Icon: CheckCircle2, className: "text-primary", label: "Passed" },
  warn: { Icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400", label: "Warning" },
  fail: { Icon: XCircle, className: "text-destructive", label: "Problem" },
  info: { Icon: Info, className: "text-muted-foreground", label: "Note" },
};

export function gradeClass(grade: string): string {
  return grade === "A" || grade === "B"
    ? "text-primary"
    : grade === "C"
      ? "text-amber-600 dark:text-amber-400"
      : "text-destructive";
}

/**
 * Overview summary: the address to share and the security grade with the
 * most important thing to fix.
 */
export function AccessCard({ serverId }: { serverId: string }) {
  const trpc = useTRPC();
  const report = useQuery(
    trpc.security.report.queryOptions({ serverId }, { refetchInterval: 60_000 }),
  );
  const net = useQuery(trpc.network.server.queryOptions({ serverId }, { refetchInterval: 60_000 }));
  const r = report.data;
  const n = net.data;
  const tunnel = n?.playit?.java.find((t) => !t.disabledReason)?.address ?? null;
  const forwarded =
    n?.upnp.mappings.some((m) => m.key.endsWith(":java") && m.status === "active") ||
    n?.checks.public?.reachable === true;
  // On a VPS or cloud VM players connect straight to the machine's own address.
  const vmDown = n?.host.vmDown === true;
  const direct = n?.vps?.ip && !vmDown ? n.addresses.publicIpv4 : null;
  const share = direct ?? tunnel ?? (forwarded ? n?.addresses.publicIpv4 : null) ?? null;
  const worst =
    r?.checks.find((c) => c.status === "fail") ?? r?.checks.find((c) => c.status === "warn");

  return (
    <section className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center justify-between text-muted-foreground">
            Join address
            <Link
              to="/servers/$id/network"
              params={{ id: serverId }}
              className="inline-flex items-center text-xs font-normal text-primary hover:underline"
            >
              Network <ChevronRight className="size-3.5" />
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {share ? (
            <>
              <Address value={share} />
              <p className="text-xs text-muted-foreground">
                {direct
                  ? n?.host.kind === "cloud"
                    ? "The cloud VM's address, from anywhere. It usually changes when the VM is restored or restarted."
                    : "The VPS's address, from anywhere."
                  : tunnel
                    ? "Through playit.gg, from anywhere."
                    : "Your public address (port forwarding)."}
              </p>
            </>
          ) : vmDown ? (
            <p className="text-muted-foreground">
              The cloud VM is down to save money. Its address shows here once the server starts.
            </p>
          ) : n?.addresses.lan ? (
            <>
              <Address value={n.addresses.lan} />
              <p className="text-xs text-muted-foreground">
                Same network only. Set up playit.gg or port forwarding for friends elsewhere.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">{net.isLoading ? "…" : "Unknown"}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center justify-between text-muted-foreground">
            Security
            <Link
              to="/servers/$id/security"
              params={{ id: serverId }}
              className="inline-flex items-center text-xs font-normal text-primary hover:underline"
            >
              Details <ChevronRight className="size-3.5" />
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 text-sm">
          {r ? (
            <>
              <span
                className={cn("text-3xl font-bold", gradeClass(r.grade))}
                role="img"
                aria-label={`Grade ${r.grade}, ${r.score} of 100`}
              >
                {r.grade}
              </span>
              <div className="min-w-0">
                <p className="tabular-nums text-muted-foreground">{r.score}/100</p>
                {worst ? (
                  <p className="flex items-start gap-1.5">
                    {(() => {
                      const s = statusIcon[worst.status];
                      return (
                        <s.Icon
                          className={cn("mt-0.5 size-4 shrink-0", s.className)}
                          aria-label={s.label}
                        />
                      );
                    })()}
                    <span className="truncate">{worst.title}</span>
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5">
                    <ShieldCheck className="size-4 text-primary" /> Nothing to fix
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">
              {report.isLoading ? "Checking…" : "Unavailable"}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
