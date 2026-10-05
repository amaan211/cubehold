import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { inferOutput } from "@trpc/tanstack-react-query";
import { Cloud, Info, Wallet } from "lucide-react";
import { useState } from "react";
import { ConnectAccountDialog } from "@/components/cloud-accounts";
import {
  CleanupCard,
  CloudInventory,
  type PickedOther,
  useCloudScan,
} from "@/components/cloud-cleanup";
import { DailyCostChart } from "@/components/cost-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useTRPC } from "@/lib/trpc";
import { cn, formatMoney } from "@/lib/utils";

export const Route = createFileRoute("/_app/costs")({
  validateSearch: (s: Record<string, unknown>): { month?: string } => ({
    month: typeof s.month === "string" && /^\d{4}-\d{2}$/.test(s.month) ? s.month : undefined,
  }),
  component: Costs,
});

type Trpc = ReturnType<typeof useTRPC>;
type Summary = inferOutput<Trpc["cloud"]["costs"]>;

function monthName(month: string, withYear = false) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString(undefined, {
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

const STATE: Record<Summary["hosts"][number]["state"], string> = {
  creating: "being created",
  running: "running",
  starting: "starting",
  stopping: "stopping",
  stopped: "stopped",
  hibernating: "saving a snapshot",
  hibernated: "deleted, snapshot kept",
  restoring: "being restored",
  missing: "missing at the provider",
  deleted: "deleted",
};

function Costs() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { month } = Route.useSearch();
  const accounts = useQuery(trpc.cloud.accounts.queryOptions());
  const costs = useQuery(
    trpc.cloud.costs.queryOptions(month ? { month } : undefined, { refetchInterval: 60_000 }),
  );
  const hasAccounts = (accounts.data?.length ?? 0) > 0;
  const scan = useCloudScan(hasAccounts);
  const [picked, setPicked] = useState<PickedOther[]>([]);
  const [connecting, setConnecting] = useState(false);
  const c = costs.data;
  const empty = c && c.hosts.length === 0 && c.currencies.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cloud costs</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            What the VMs cubehold runs in your cloud accounts cost, worked out from the providers'
            prices and how long each VM was on, stopped or saved. Your provider's invoice has the
            final word: it adds VAT or sales tax, traffic beyond the free allowance, and any
            credits.
          </p>
        </div>
        {c && c.months.length > 1 && (
          <Select
            aria-label="Month"
            className="w-44"
            value={c.month}
            onChange={(e) =>
              void navigate({
                to: "/costs",
                search: { month: e.target.value === c.months[0] ? undefined : e.target.value },
              })
            }
          >
            {c.months.map((m) => (
              <option key={m} value={m}>
                {monthName(m, true)}
              </option>
            ))}
          </Select>
        )}
      </div>

      {accounts.data && !hasAccounts && empty && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-start gap-3 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Cloud className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">No cloud accounts connected</p>
                <p className="text-muted-foreground">
                  Costs show here once the panel runs VMs in your Hetzner, DigitalOcean, Vultr,
                  Linode or AWS account. A VPS you added yourself is billed by its provider; see its
                  control panel.
                </p>
              </div>
            </div>
            <Button variant="outline" className="shrink-0" onClick={() => setConnecting(true)}>
              Connect an account
            </Button>
          </CardContent>
        </Card>
      )}

      {c?.currencies.map((cur) => (
        <CurrencySection key={cur.currency} summary={c} cur={cur} />
      ))}
      {c && hasAccounts && c.currencies.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No cloud VMs in {monthName(c.month)} so far, so nothing to pay for them.
        </p>
      )}

      {c && c.hosts.length > 0 && <HostsCard summary={c} />}

      {hasAccounts && <CloudInventory scan={scan} picked={picked} onPick={setPicked} />}
      {hasAccounts && <CleanupCard scan={scan} picked={picked} />}

      <ConnectAccountDialog open={connecting} onClose={() => setConnecting(false)} />
    </div>
  );
}

function CurrencySection({
  summary,
  cur,
}: {
  summary: Summary;
  cur: Summary["currencies"][number];
}) {
  const m = monthName(summary.month);
  const today = summary.current ? new Date().toISOString().slice(0, 10) : null;
  const kinds = [
    {
      label: "VM time",
      hint: "The size's price for the hours each VM existed. Most providers bill a stopped VM in full; AWS does not.",
      value: cur.soFar.compute,
    },
    {
      label: "Storage",
      hint: "Snapshots kept while a VM is saved, and AWS disks.",
      value: cur.soFar.storage,
    },
    {
      label: "IPv4 addresses",
      hint: "Billed on top of the VM on Hetzner (€0.50 a month) and AWS ($0.005 an hour).",
      value: cur.soFar.ip,
    },
  ];
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label={`${m} so far`} value={formatMoney(cur.soFar.total, cur.currency)} strong />
        {cur.projected !== null && (
          <Stat
            label={`By the end of ${m}`}
            value={formatMoney(cur.projected, cur.currency)}
            hint="If every VM stays as it is now"
          />
        )}
        {summary.current && (
          <Stat
            label="Right now"
            value={`${formatMoney(cur.perHour, cur.currency)}/h`}
            hint={`About ${formatMoney(cur.perHour * 24, cur.currency)} a day`}
          />
        )}
        <Stat
          label="Last month"
          value={cur.lastMonth !== null ? formatMoney(cur.lastMonth, cur.currency) : "—"}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Cost per day</CardTitle>
            <CardDescription>
              {m}, in {cur.currency === "EUR" ? "euros" : "US dollars"}. A VM stops costing once it
              reaches its monthly price.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DailyCostChart days={cur.days} currency={cur.currency} today={today} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What you pay for</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {kinds.map((k) => {
              const share = cur.soFar.total > 0 ? k.value / cur.soFar.total : 0;
              return (
                <div key={k.label} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{k.label}</span>
                    <span className="tabular-nums">{formatMoney(k.value, cur.currency)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(share * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{k.hint}</p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {strong && <Wallet className="size-3.5" />}
          {label}
        </p>
        <p
          className={cn("tabular-nums", strong ? "text-2xl font-semibold" : "text-xl font-medium")}
        >
          {value}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function HostsCard({ summary }: { summary: Summary }) {
  const m = monthName(summary.month);
  const h1 = (n: number) => (n < 1 ? `${Math.round(n * 60)} min` : `${Math.round(n * 10) / 10} h`);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">By VM</CardTitle>
        <CardDescription>
          Every cloud VM that cost something in {m}, including ones deleted since.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0 sm:p-6 sm:pt-0">
        <ul className="divide-y divide-border border-t border-border sm:rounded-lg sm:border">
          {summary.hosts.map((h) => (
            <li
              key={h.hostId}
              className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {h.state === "deleted" ? (
                    h.name
                  ) : (
                    <Link to="/hosts" className="hover:underline">
                      {h.name}
                    </Link>
                  )}
                  <Badge variant={h.state === "running" ? "success" : "outline"}>
                    {STATE[h.state]}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {h.providerLabel}
                  {h.accountLabel ? ` (${h.accountLabel})` : ""} · {h.sizeLabel}
                  {h.region ? ` · ${h.region}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {h1(h.hours.running)} on
                  {h.hours.stopped > 0.05 ? `, ${h1(h.hours.stopped)} stopped` : ""}
                  {h.hours.hibernated > 0.05 ? `, ${h1(h.hours.hibernated)} as a snapshot` : ""}
                  {h.servers.length > 0 && (
                    <>
                      {" · "}
                      {h.servers.map((s, i) => (
                        <span key={s.id}>
                          {i > 0 && ", "}
                          <Link
                            to="/servers/$id"
                            params={{ id: s.id }}
                            className="text-primary hover:underline"
                          >
                            {s.name}
                          </Link>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </div>
              <div className="text-left sm:text-right">
                <p className="font-medium tabular-nums">{formatMoney(h.cost.total, h.currency)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {h.projected !== null && h.state !== "deleted"
                    ? `${formatMoney(h.projected, h.currency)} by month end`
                    : `in ${m}`}
                  {summary.current && h.perHour > 0
                    ? ` · ${formatMoney(h.perHour, h.currency)}/h now`
                    : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="flex gap-1.5 px-4 pt-3 pb-4 text-xs text-muted-foreground sm:px-0 sm:pb-0">
          <Info className="mt-0.5 size-3.5 shrink-0" /> To pay less, let servers stop when nobody is
          online and take their VM down meanwhile (the default for servers on a cloud VM; each
          server's Settings → Automation), and delete hosts you no longer use.
        </p>
      </CardContent>
    </Card>
  );
}
