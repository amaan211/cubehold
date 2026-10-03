export type ProviderId = "hetzner" | "digitalocean" | "vultr" | "linode" | "aws";

/** What a provider account needs. Token providers use `token`; AWS uses an access key pair. */
export interface ProviderCredential {
  token?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** AWS: the region used for account-wide calls. */
  region?: string;
}

export interface CloudRegion {
  id: string;
  name: string;
  /** ISO country code where known. */
  country: string | null;
  continent: "Europe" | "North America" | "South America" | "Asia" | "Oceania" | "Africa" | null;
}

export interface CloudSize {
  id: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  arch: "x64" | "arm64";
  /** Dedicated cores rather than shared ones. */
  dedicated: boolean;
  /** Burstable CPU (AWS t-family): heavy use costs extra or gets throttled. */
  burstable?: boolean;
  priceHourly: number;
  priceMonthly: number;
  currency: "EUR" | "USD";
  /** Prices are the provider's list price for this region, or an estimate. */
  priceSource: "api" | "estimate";
}

export type VmStatus =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "deleting"
  | "unknown";

export interface CloudVm {
  id: string;
  status: VmStatus;
  ipv4: string | null;
  ipv6: string | null;
}

export interface FirewallPort {
  protocol: "tcp" | "udp";
  port: number;
  note?: string;
}

export interface CreateVmRequest {
  name: string;
  region: string;
  size: string;
  arch: "x64" | "arm64";
  /** A fresh Ubuntu 24.04, or a snapshot made by snapshotVm. */
  image: { kind: "ubuntu" } | { kind: "snapshot"; id: string };
  /** From ensureSshKey. */
  sshKeyId: string;
  /** OpenSSH public key line, for providers that take keys inline. */
  publicKey: string;
  /** From createFirewall. */
  firewallId: string;
  /** Tag that ties the VM to its firewall and marks it as the panel's. */
  tag: string;
  /** Root disk for providers where it is chosen (AWS). */
  diskGb?: number;
}

export interface SnapshotState {
  status: "pending" | "ready" | "error" | "missing";
  /** What createVm takes as image id once ready. */
  imageId: string | null;
  sizeGb: number | null;
}

/**
 * One provider account. Every method maps provider errors to CloudError with
 * a message a person can act on.
 */
export interface CloudProvider {
  readonly id: ProviderId;
  /** The user the provider's Ubuntu image lets in with the SSH key. */
  readonly loginUser: string;
  /** Check the credential works; returns something to show, like the account e-mail. */
  verify(): Promise<{ account: string | null }>;
  regions(): Promise<CloudRegion[]>;
  sizes(region: string): Promise<CloudSize[]>;
  /** Register the panel's public key; returns the provider's id for it. */
  ensureSshKey(name: string, publicKey: string, region: string): Promise<string>;
  deleteSshKey(id: string): Promise<void>;
  /** A firewall allowing SSH plus `ports`, applied to VMs carrying `tag`. */
  createFirewall(name: string, region: string, tag: string, ports: FirewallPort[]): Promise<string>;
  /** Replace the firewall's game ports (SSH stays open). */
  setFirewall(id: string, ports: FirewallPort[]): Promise<void>;
  deleteFirewall(id: string): Promise<void>;
  createVm(req: CreateVmRequest): Promise<CloudVm>;
  /** Null when the VM no longer exists. */
  getVm(id: string): Promise<CloudVm | null>;
  startVm(id: string): Promise<void>;
  /** Graceful shutdown (ACPI), or a hard power-off with force; the disk is kept. */
  stopVm(id: string, opts?: { force?: boolean }): Promise<void>;
  deleteVm(id: string): Promise<void>;
  /** Start imaging a stopped VM; follow with snapshotState. */
  snapshotVm(id: string, name: string): Promise<string>;
  snapshotState(handle: string): Promise<SnapshotState>;
  deleteSnapshot(imageId: string): Promise<void>;
}

export type CloudErrorCode =
  | "auth"
  | "permission"
  | "not-found"
  | "limit"
  | "capacity"
  | "invalid"
  | "rate-limit"
  | "unavailable"
  | "unsupported";

export class CloudError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
