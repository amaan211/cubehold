import type { CloudSize, ProviderId } from "./types.js";

/**
 * How a provider bills a VM beyond its list price. Rates checked in
 * October 2026; the panel labels every figure as an estimate. This file has
 * no runtime imports so the web app can load it too (`@cubehold/providers/pricing`).
 */
export interface BillingRules {
  currency: "EUR" | "USD";
  /** A powered-off VM keeps costing the full price (only deleting it stops the bill). */
  stoppedBilled: boolean;
  /** A calendar month never costs more than the monthly price, however long the month. */
  capAtMonthly: boolean;
  /** Snapshot or image storage. */
  snapshotPerGbMonth: number;
  /** Disk storage billed on top of the size's price while the VM exists, running or stopped (AWS EBS). */
  diskPerGbMonth: number;
  /** Public IPv4 per hour, charged on top of the size's price. */
  ipv4Hourly: number;
  /** A month of IPv4 never costs more than this. */
  ipv4MonthlyCap: number | null;
  /** IPv4 is charged while the VM is stopped too (it is kept); otherwise only while running. */
  ipv4WhileStopped: boolean;
}

export const HOURS_PER_MONTH = 730;

export const BILLING: Record<ProviderId, BillingRules> = {
  hetzner: {
    currency: "EUR",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.0143,
    diskPerGbMonth: 0,
    // Hetzner publishes only the monthly price (€0.50); billed pro rata by the hour.
    ipv4Hourly: 0.5 / HOURS_PER_MONTH,
    ipv4MonthlyCap: 0.5,
    ipv4WhileStopped: true,
  },
  digitalocean: {
    currency: "USD",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.06,
    diskPerGbMonth: 0,
    ipv4Hourly: 0,
    ipv4MonthlyCap: null,
    ipv4WhileStopped: false,
  },
  vultr: {
    currency: "USD",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.05,
    diskPerGbMonth: 0,
    ipv4Hourly: 0,
    ipv4MonthlyCap: null,
    ipv4WhileStopped: false,
  },
  linode: {
    currency: "USD",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.1,
    diskPerGbMonth: 0,
    ipv4Hourly: 0,
    ipv4MonthlyCap: null,
    ipv4WhileStopped: false,
  },
  aws: {
    currency: "USD",
    stoppedBilled: false,
    capAtMonthly: false,
    snapshotPerGbMonth: 0.05,
    diskPerGbMonth: 0.08,
    ipv4Hourly: 0.005,
    ipv4MonthlyCap: null,
    ipv4WhileStopped: false,
  },
};

export interface UsageHours {
  running: number;
  stopped: number;
  /** Snapshotted and deleted. */
  hibernated: number;
  /** Snapshot size while hibernated. */
  snapshotGb: number;
  /** Snapshot storage actually used (GB × hours); overrides hibernated × snapshotGb when the size changed. */
  snapshotGbHours?: number;
}

export interface CostBreakdown {
  /** The VM itself (the size's price). */
  compute: number;
  /** Snapshots, and disks billed separately (AWS). */
  storage: number;
  /** Public IPv4 addresses billed separately (Hetzner, AWS). */
  ip: number;
  total: number;
  currency: "EUR" | "USD";
}

type Priced = Pick<CloudSize, "priceHourly" | "priceMonthly" | "diskGb" | "noMonthlyCap">;

/**
 * Whether a month of this size stops at its monthly price. Sizes without a
 * monthly price (some providers leave it out) are billed by the hour only.
 */
function capped(provider: ProviderId, size: Priced): boolean {
  return BILLING[provider].capAtMonthly && !size.noMonthlyCap && size.priceMonthly > 0;
}

/** What `hours` of use cost, following the provider's rules. Not rounded. */
export function exactCostOf(provider: ProviderId, size: Priced, hours: UsageHours): CostBreakdown {
  const r = BILLING[provider];
  const billed = hours.running + (r.stoppedBilled ? hours.stopped : 0);
  let compute = billed * size.priceHourly;
  if (capped(provider, size)) compute = Math.min(compute, size.priceMonthly);
  const gbHours = hours.snapshotGbHours ?? hours.hibernated * hours.snapshotGb;
  const storage =
    ((hours.running + hours.stopped) * r.diskPerGbMonth * size.diskGb +
      gbHours * r.snapshotPerGbMonth) /
    HOURS_PER_MONTH;
  let ip = (hours.running + (r.ipv4WhileStopped ? hours.stopped : 0)) * r.ipv4Hourly;
  if (r.ipv4MonthlyCap !== null) ip = Math.min(ip, r.ipv4MonthlyCap);
  return { compute, storage, ip, total: compute + storage + ip, currency: r.currency };
}

/** What `hours` of use cost, following the provider's rules, in cents. */
export function costOf(provider: ProviderId, size: Priced, hours: UsageHours): CostBreakdown {
  const c = exactCostOf(provider, size, hours);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    compute: round(c.compute),
    storage: round(c.storage),
    ip: round(c.ip),
    total: round(c.compute + c.storage + c.ip),
    currency: c.currency,
  };
}

export type IdleMode = "keep" | "stop" | "hibernate";

/**
 * A month's cost when players are on `hoursPerDay`, for the "what will this
 * cost" preview. The disk image is guessed from the disk when unknown.
 */
export function monthlyEstimate(
  provider: ProviderId,
  size: Priced,
  hoursPerDay: number,
  idle: IdleMode,
  snapshotGb = Math.max(2, Math.round(size.diskGb * 0.15)),
): CostBreakdown {
  const on = Math.min(24, Math.max(0, hoursPerDay)) * (HOURS_PER_MONTH / 24);
  const off = HOURS_PER_MONTH - on;
  return costOf(provider, size, {
    running: idle === "keep" ? HOURS_PER_MONTH : on,
    stopped: idle === "stop" ? off : 0,
    hibernated: idle === "hibernate" ? off : 0,
    snapshotGb,
  });
}

/** Power states that bill differently. */
export type BillingState = "running" | "stopped" | "hibernated" | "gone";

/**
 * What a VM costs per hour right now, with its IPv4 address and separately
 * billed disk. `billedHours` is this month's billed time so far: once a capped
 * provider reaches the monthly price, more hours are free until the month ends.
 */
export function hourlyRate(
  provider: ProviderId,
  size: Priced,
  state: BillingState,
  snapshotGb = 0,
  billedHours = 0,
): number {
  const r = BILLING[provider];
  if (state === "gone") return 0;
  if (state === "hibernated") return (snapshotGb * r.snapshotPerGbMonth) / HOURS_PER_MONTH;
  const billed = state === "running" || r.stoppedBilled;
  const full =
    capped(provider, size) &&
    billedHours * size.priceHourly >= size.priceMonthly - size.priceHourly / 2;
  const compute = billed && !full ? size.priceHourly : 0;
  const disk = (r.diskPerGbMonth * size.diskGb) / HOURS_PER_MONTH;
  const ipCapped =
    r.ipv4MonthlyCap !== null && billedHours * r.ipv4Hourly >= r.ipv4MonthlyCap - r.ipv4Hourly / 2;
  const ip = (state === "running" || r.ipv4WhileStopped) && !ipCapped ? r.ipv4Hourly : 0;
  return compute + disk + ip;
}

/** The price of a VM left running all month, IPv4 and separate disk included. */
export function alwaysOnMonthly(provider: ProviderId, size: Priced): number {
  return monthlyEstimate(provider, size, 24, "keep").total;
}
