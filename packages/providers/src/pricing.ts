import type { CloudSize, ProviderId } from "./types.js";

/**
 * How a provider bills a VM beyond its list price. Rates checked in
 * September 2026; the panel labels every figure as an estimate.
 */
export interface BillingRules {
  currency: "EUR" | "USD";
  /** A powered-off VM keeps costing the full price (only deleting it stops the bill). */
  stoppedBilled: boolean;
  /** A month never costs more than the monthly price. */
  capAtMonthly: boolean;
  /** Snapshot or image storage. */
  snapshotPerGbMonth: number;
  /** Disk storage billed while the VM is stopped (AWS EBS). */
  stoppedDiskPerGbMonth: number;
  /** Public IPv4 per hour, charged on top of the size's price. */
  ipv4Hourly: number;
  /** IPv4 is charged while the VM is stopped too (it is kept); otherwise only while running. */
  ipv4WhileStopped: boolean;
}

const HOURS_PER_MONTH = 730;

export const BILLING: Record<ProviderId, BillingRules> = {
  hetzner: {
    currency: "EUR",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.0143,
    stoppedDiskPerGbMonth: 0,
    ipv4Hourly: 0.5 / HOURS_PER_MONTH,
    ipv4WhileStopped: true,
  },
  digitalocean: {
    currency: "USD",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.06,
    stoppedDiskPerGbMonth: 0,
    ipv4Hourly: 0,
    ipv4WhileStopped: false,
  },
  vultr: {
    currency: "USD",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.05,
    stoppedDiskPerGbMonth: 0,
    ipv4Hourly: 0,
    ipv4WhileStopped: false,
  },
  linode: {
    currency: "USD",
    stoppedBilled: true,
    capAtMonthly: true,
    snapshotPerGbMonth: 0.1,
    stoppedDiskPerGbMonth: 0,
    ipv4Hourly: 0,
    ipv4WhileStopped: false,
  },
  aws: {
    currency: "USD",
    stoppedBilled: false,
    capAtMonthly: false,
    snapshotPerGbMonth: 0.05,
    stoppedDiskPerGbMonth: 0.08,
    ipv4Hourly: 0.005,
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
}

export interface CostBreakdown {
  compute: number;
  storage: number;
  ip: number;
  total: number;
  currency: "EUR" | "USD";
}

/** What `hours` of use cost, following the provider's rules. */
export function costOf(
  provider: ProviderId,
  size: Pick<CloudSize, "priceHourly" | "priceMonthly" | "diskGb">,
  hours: UsageHours,
): CostBreakdown {
  const r = BILLING[provider];
  const billed = hours.running + (r.stoppedBilled ? hours.stopped : 0);
  let compute = billed * size.priceHourly;
  if (r.capAtMonthly)
    compute = Math.min(compute, size.priceMonthly * Math.max(1, billed / HOURS_PER_MONTH));
  const storage =
    (hours.stopped * r.stoppedDiskPerGbMonth * size.diskGb +
      hours.hibernated * r.snapshotPerGbMonth * hours.snapshotGb) /
    HOURS_PER_MONTH;
  const ip = (hours.running + (r.ipv4WhileStopped ? hours.stopped : 0)) * r.ipv4Hourly;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    compute: round(compute),
    storage: round(storage),
    ip: round(ip),
    total: round(compute + storage + ip),
    currency: r.currency,
  };
}

export type IdleMode = "keep" | "stop" | "hibernate";

/**
 * A month's cost when players are on `hoursPerDay`, for the "what will this
 * cost" preview. The disk image is guessed from the disk when unknown.
 */
export function monthlyEstimate(
  provider: ProviderId,
  size: Pick<CloudSize, "priceHourly" | "priceMonthly" | "diskGb">,
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
