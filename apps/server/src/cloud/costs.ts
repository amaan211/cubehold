import {
  BILLING,
  type BillingState,
  exactCostOf,
  hourlyRate,
  PROVIDERS,
  type ProviderId,
} from "@cubehold/providers";
import type { CloudUsageSize } from "../db/schema.js";
import type { PowerState } from "./types.js";

/** One host's hours on one UTC day, as kept in cloud_usage. */
export interface UsageRow {
  hostId: string;
  day: string;
  hostName: string;
  accountId: string | null;
  provider: string;
  region: string | null;
  size: CloudUsageSize;
  running: number;
  stopped: number;
  hibernated: number;
  snapshotGbHours: number;
}

/** A cloud host that still exists, with what it is doing now. */
export interface LiveHost {
  hostId: string;
  name: string;
  provider: ProviderId;
  accountLabel: string | null;
  region: string;
  size: CloudUsageSize;
  power: PowerState;
  snapshotGb: number;
  servers: Array<{ id: string; name: string }>;
  /** Last month's total from before the usage log existed. */
  lastMonth: { month: string; total: number } | null;
}

type Currency = "EUR" | "USD";
type Bucket = "running" | "stopped" | "hibernated";

export interface Money {
  compute: number;
  storage: number;
  ip: number;
  total: number;
}

export interface CostSummary {
  month: string;
  /** The month is still going, so `projected` and `perHour` mean something. */
  current: boolean;
  /** Months with any usage, newest first. */
  months: string[];
  currencies: Array<{
    currency: Currency;
    soFar: Money;
    /** If every VM stays as it is until the month ends. */
    projected: number | null;
    /** What the VMs cost per hour right now. */
    perHour: number;
    lastMonth: number | null;
    days: Array<Money & { day: string }>;
  }>;
  hosts: Array<{
    hostId: string;
    name: string;
    provider: ProviderId;
    providerLabel: string;
    accountLabel: string | null;
    region: string | null;
    sizeLabel: string;
    currency: Currency;
    /** "deleted" once the host is gone from the panel. */
    state: PowerState | "deleted";
    hours: { running: number; stopped: number; hibernated: number };
    cost: Money;
    projected: number | null;
    perHour: number;
    servers: Array<{ id: string; name: string }>;
  }>;
}

const ZERO: Money = { compute: 0, storage: 0, ip: 0, total: 0 };

/** Split [from, to) at UTC midnights into hours per day. */
export function splitByDay(from: Date, to: Date): Array<{ day: string; hours: number }> {
  const out: Array<{ day: string; hours: number }> = [];
  let t = from.getTime();
  const end = to.getTime();
  while (t < end) {
    const d = new Date(t);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const stop = Math.min(next, end);
    out.push({ day: d.toISOString().slice(0, 10), hours: (stop - t) / 3_600_000 });
    t = stop;
  }
  return out;
}

/** Which billing bucket a power state's time goes into; null when nothing is billed. */
export function bucketOf(power: PowerState): Bucket | null {
  if (power === "missing") return null;
  if (power === "stopped" || power === "hibernating") return "stopped";
  if (power === "hibernated") return "hibernated";
  return "running";
}

function billingState(power: PowerState | "deleted"): BillingState {
  if (power === "deleted" || power === "missing") return "gone";
  const b = bucketOf(power);
  return b === "stopped" ? "stopped" : b === "hibernated" ? "hibernated" : "running";
}

function add(a: Money, b: Money): Money {
  return {
    compute: a.compute + b.compute,
    storage: a.storage + b.storage,
    ip: a.ip + b.ip,
    total: a.total + b.total,
  };
}

function sub(a: Money, b: Money): Money {
  return {
    compute: a.compute - b.compute,
    storage: a.storage - b.storage,
    ip: a.ip - b.ip,
    total: a.total - b.total,
  };
}

interface Hours {
  running: number;
  stopped: number;
  hibernated: number;
  snapshotGbHours: number;
}

function money(provider: ProviderId, size: CloudUsageSize, h: Hours): Money {
  const c = exactCostOf(provider, size, { ...h, snapshotGb: 0 });
  return { compute: c.compute, storage: c.storage, ip: c.ip, total: c.total };
}

function monthEnd(month: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1));
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/**
 * What the month cost so far, day by day and VM by VM, and where it is heading.
 * Each provider caps a VM at its monthly price, so a day's cost is the
 * difference between the running total after it and before it.
 */
export function summarizeCosts(
  month: string,
  rows: UsageRow[],
  previousRows: UsageRow[],
  live: LiveHost[],
  months: string[],
  now: Date,
): CostSummary {
  const current = now.toISOString().slice(0, 7) === month;
  const remaining = current
    ? Math.max(0, (monthEnd(month).getTime() - now.getTime()) / 3_600_000)
    : 0;
  const liveById = new Map(live.map((h) => [h.hostId, h]));

  const byHost = new Map<string, UsageRow[]>();
  for (const r of [...rows].sort((a, b) => a.day.localeCompare(b.day))) {
    byHost.set(r.hostId, [...(byHost.get(r.hostId) ?? []), r]);
  }
  // A live host with no hours yet this month (created a minute ago) still shows.
  if (current) for (const h of live) if (!byHost.has(h.hostId)) byHost.set(h.hostId, []);

  const perCurrency = new Map<
    Currency,
    { soFar: Money; projected: number; perHour: number; days: Map<string, Money> }
  >();
  const slot = (c: Currency) => {
    let s = perCurrency.get(c);
    if (!s) {
      s = { soFar: { ...ZERO }, projected: 0, perHour: 0, days: new Map() };
      perCurrency.set(c, s);
    }
    return s;
  };

  const hosts: CostSummary["hosts"] = [];
  for (const [hostId, list] of byHost) {
    const h = liveById.get(hostId);
    const last = list.at(-1);
    const provider = (h?.provider ?? last?.provider) as ProviderId;
    const size = h?.size ?? last?.size;
    if (!size || !BILLING[provider]) continue;
    const currency = size.currency;
    const s = slot(currency);
    const cum: Hours = { running: 0, stopped: 0, hibernated: 0, snapshotGbHours: 0 };
    let before = { ...ZERO };
    for (const r of list) {
      cum.running += r.running;
      cum.stopped += r.stopped;
      cum.hibernated += r.hibernated;
      cum.snapshotGbHours += r.snapshotGbHours;
      const after = money(provider, size, cum);
      const day = sub(after, before);
      s.days.set(r.day, add(s.days.get(r.day) ?? ZERO, day));
      before = after;
    }
    const cost = before;
    s.soFar = add(s.soFar, cost);

    const state: PowerState | "deleted" = h ? h.power : "deleted";
    const billedSoFar = cum.running + (BILLING[provider].stoppedBilled ? cum.stopped : 0);
    const perHour =
      current && h ? hourlyRate(provider, size, billingState(state), h.snapshotGb, billedSoFar) : 0;
    let projected: number | null = null;
    if (current) {
      const rest = { ...cum };
      const b = h ? bucketOf(h.power) : null;
      if (b) rest[b] += remaining;
      if (b === "hibernated" && h) rest.snapshotGbHours += remaining * h.snapshotGb;
      projected = money(provider, size, rest).total;
      s.projected += projected;
      s.perHour += perHour;
    }
    hosts.push({
      hostId,
      name: h?.name ?? last?.hostName ?? hostId,
      provider,
      providerLabel: PROVIDERS[provider].label,
      accountLabel: h?.accountLabel ?? null,
      region: h?.region ?? last?.region ?? null,
      sizeLabel: size.label,
      currency,
      state,
      hours: { running: cum.running, stopped: cum.stopped, hibernated: cum.hibernated },
      cost,
      projected,
      perHour,
      servers: h?.servers ?? [],
    });
  }

  // Last month, from the log, or from the hosts' own record for months before it existed.
  const prev = previousMonth(month);
  const lastMonth = new Map<Currency, number>();
  const prevByHost = new Map<string, UsageRow[]>();
  for (const r of previousRows) prevByHost.set(r.hostId, [...(prevByHost.get(r.hostId) ?? []), r]);
  for (const list of prevByHost.values()) {
    const last = list.at(-1) as UsageRow;
    const provider = last.provider as ProviderId;
    if (!BILLING[provider]) continue;
    const sum = list.reduce(
      (a, r) => ({
        running: a.running + r.running,
        stopped: a.stopped + r.stopped,
        hibernated: a.hibernated + r.hibernated,
        snapshotGbHours: a.snapshotGbHours + r.snapshotGbHours,
      }),
      { running: 0, stopped: 0, hibernated: 0, snapshotGbHours: 0 },
    );
    const c = last.size.currency;
    lastMonth.set(c, (lastMonth.get(c) ?? 0) + money(provider, last.size, sum).total);
  }
  for (const h of live) {
    if (h.lastMonth?.month === prev && !prevByHost.has(h.hostId)) {
      const c = h.size.currency;
      lastMonth.set(c, (lastMonth.get(c) ?? 0) + h.lastMonth.total);
    }
  }
  for (const c of lastMonth.keys()) slot(c);

  const daysIn = new Date(monthEnd(month).getTime() - 86_400_000).getUTCDate();
  const currencies: CostSummary["currencies"] = [...perCurrency.entries()]
    .map(([currency, s]) => ({
      currency,
      soFar: s.soFar,
      projected: current ? s.projected : null,
      perHour: s.perHour,
      lastMonth: lastMonth.get(currency) ?? null,
      days: Array.from({ length: daysIn }, (_, i) => {
        const day = `${month}-${String(i + 1).padStart(2, "0")}`;
        return { day, ...(s.days.get(day) ?? ZERO) };
      }),
    }))
    .sort((a, b) => b.soFar.total - a.soFar.total);

  hosts.sort(
    (a, b) =>
      Number(b.state !== "deleted") - Number(a.state !== "deleted") || b.cost.total - a.cost.total,
  );
  return { month, current, months, currencies, hosts };
}
