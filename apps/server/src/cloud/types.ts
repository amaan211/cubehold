import type { CloudSize, CostBreakdown, IdleMode, ProviderId } from "@cubehold/providers";

/**
 * Where a cloud VM is. "running" means the VM is up (the SSH link decides
 * whether the agent answers); the rest are the provider side.
 */
export type PowerState =
  | "creating"
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "hibernating"
  | "hibernated"
  | "restoring"
  | "missing";

/** Hours in each billing state this calendar month (UTC). */
export interface UsageMonth {
  month: string;
  running: number;
  stopped: number;
  hibernated: number;
  lastAt: string;
}

/** The provider side of a cloud host, kept in the host row's meta. */
export interface CloudMeta {
  accountId: string;
  provider: ProviderId;
  region: string;
  size: CloudSize;
  /** Label/tag tying the VM to its firewall. */
  tag: string;
  sshKeyId: string | null;
  firewallId: string | null;
  vmId: string | null;
  power: PowerState;
  powerSince: string;
  /** The saved disk while hibernated. */
  snapshot: { handle: string; imageId: string | null; sizeGb: number | null; at: string } | null;
  usage: UsageMonth;
  /** Last month's total, for the host card. */
  lastMonth: { month: string; total: number } | null;
  lastError: string | null;
}

/** Host states the cloud side decides; null leaves it to the SSH link. */
export type CloudHostState =
  | "creating"
  | "vm-starting"
  | "vm-stopping"
  | "vm-stopped"
  | "hibernating"
  | "hibernated"
  | "restoring"
  | "vm-missing";

export interface CloudView {
  state: CloudHostState | null;
  error: string | null;
  provider: ProviderId;
  providerLabel: string;
  accountLabel: string | null;
  region: string;
  size: Pick<
    CloudSize,
    "id" | "label" | "vcpus" | "memoryMb" | "diskGb" | "arch" | "burstable" | "noMonthlyCap"
  >;
  price: { hourly: number; monthly: number; currency: "EUR" | "USD"; estimate: boolean };
  power: PowerState;
  powerSince: string;
  month: CostBreakdown & {
    month: string;
    hours: { running: number; stopped: number; hibernated: number };
  };
  lastMonth: { month: string; total: number } | null;
  stopSavesMoney: boolean;
  snapshots: boolean;
  snapshotGb: number | null;
  /** Snapshot storage price per GB and month. */
  snapshotPerGbMonth: number;
  /** What servers on this host may choose for "when idle". */
  idleModes: IdleMode[];
}
