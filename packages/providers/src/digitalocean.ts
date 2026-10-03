import { continentOf, RestClient } from "./http.js";
import {
  CloudError,
  type CloudProvider,
  type CloudRegion,
  type CloudSize,
  type CloudVm,
  type CreateVmRequest,
  type FetchLike,
  type FirewallPort,
  type SnapshotState,
} from "./types.js";

interface DoDroplet {
  id: number;
  status: "new" | "active" | "off" | "archive";
  networks: {
    v4: Array<{ ip_address: string; type: string }>;
    v6: Array<{ ip_address: string; type: string }>;
  };
}
interface DoFirewall {
  id: string;
  name: string;
  inbound_rules: unknown[];
  outbound_rules: unknown[];
  tags: string[];
  droplet_ids: number[];
}

const ALL = { addresses: ["0.0.0.0/0", "::/0"] };
const OUTBOUND = [
  { protocol: "tcp", ports: "0", destinations: ALL },
  { protocol: "udp", ports: "0", destinations: ALL },
  { protocol: "icmp", destinations: ALL },
];

/** Region slugs by country, for grouping (the API only gives names). */
const COUNTRY: Record<string, string> = {
  nyc: "US",
  sfo: "US",
  atl: "US",
  ams: "NL",
  lon: "GB",
  fra: "DE",
  sgp: "SG",
  tor: "CA",
  blr: "IN",
  syd: "AU",
};

/** DigitalOcean API v2 with a personal access token (read and write). Prices in US dollars. */
export class DigitalOceanProvider implements CloudProvider {
  readonly id = "digitalocean" as const;
  readonly loginUser = "root";
  #api: RestClient;

  constructor(token: string, opts: { fetch?: FetchLike; base?: string } = {}) {
    this.#api = new RestClient({
      base: opts.base ?? "https://api.digitalocean.com/v2",
      token,
      provider: "DigitalOcean",
      fetch: opts.fetch,
    });
  }

  async verify() {
    const r = await this.#api.get<{ account: { email: string; status: string } }>("/account");
    if (r.account.status !== "active") {
      throw new CloudError("permission", `The DigitalOcean account is ${r.account.status}.`);
    }
    return { account: r.account.email };
  }

  async regions(): Promise<CloudRegion[]> {
    const r = await this.#api.get<{
      regions: Array<{ slug: string; name: string; available: boolean }>;
    }>("/regions", { per_page: 200 });
    return r.regions
      .filter((x) => x.available)
      .map((x) => {
        const country = COUNTRY[x.slug.replace(/\d+$/, "")] ?? null;
        return { id: x.slug, name: x.name, country, continent: continentOf(country) };
      });
  }

  async sizes(region: string): Promise<CloudSize[]> {
    const r = await this.#api.get<{
      sizes: Array<{
        slug: string;
        memory: number;
        vcpus: number;
        disk: number;
        price_monthly: number;
        price_hourly: number;
        regions: string[];
        available: boolean;
        description: string;
      }>;
    }>("/sizes", { per_page: 200 });
    return r.sizes
      .filter((s) => s.available && s.regions.includes(region))
      .map((s) => ({
        id: s.slug,
        label: `${s.description || "Droplet"} ${s.slug}`,
        vcpus: s.vcpus,
        memoryMb: s.memory,
        diskGb: s.disk,
        arch: "x64" as const,
        dedicated: !s.slug.startsWith("s-"),
        priceHourly: s.price_hourly,
        priceMonthly: s.price_monthly,
        currency: "USD" as const,
        priceSource: "api" as const,
      }))
      .sort((a, b) => a.priceMonthly - b.priceMonthly);
  }

  async ensureSshKey(name: string, publicKey: string): Promise<string> {
    const body = publicKey.split(/\s+/).slice(0, 2).join(" ");
    const list = await this.#api.get<{ ssh_keys: Array<{ id: number; public_key: string }> }>(
      "/account/keys",
      { per_page: 200 },
    );
    const same = list.ssh_keys.find(
      (k) => k.public_key.split(/\s+/).slice(0, 2).join(" ") === body,
    );
    if (same) return String(same.id);
    const r = await this.#api.post<{ ssh_key: { id: number } }>("/account/keys", {
      name,
      public_key: publicKey,
    });
    return String(r.ssh_key.id);
  }

  deleteSshKey(id: string): Promise<void> {
    return this.#api.del(`/account/keys/${id}`);
  }

  async createFirewall(
    name: string,
    _region: string,
    tag: string,
    ports: FirewallPort[],
  ): Promise<string> {
    // Firewalls follow a tag, so a VM restored from a snapshot is covered too.
    await this.#api.post("/tags", { name: tag }).catch((err) => {
      if (!(err instanceof CloudError && err.code === "invalid")) throw err; // already exists
    });
    const r = await this.#api.post<{ firewall: { id: string } }>("/firewalls", {
      name: name.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 255),
      inbound_rules: inbound(ports),
      outbound_rules: OUTBOUND,
      tags: [tag],
    });
    return r.firewall.id;
  }

  async setFirewall(id: string, ports: FirewallPort[]): Promise<void> {
    const r = await this.#api.get<{ firewall: DoFirewall }>(`/firewalls/${id}`);
    const fw = r.firewall;
    await this.#api.put(`/firewalls/${id}`, {
      name: fw.name,
      inbound_rules: inbound(ports),
      outbound_rules: fw.outbound_rules.length > 0 ? fw.outbound_rules : OUTBOUND,
      tags: fw.tags,
      droplet_ids: fw.droplet_ids,
    });
  }

  deleteFirewall(id: string): Promise<void> {
    return this.#api.del(`/firewalls/${id}`);
  }

  async createVm(req: CreateVmRequest): Promise<CloudVm> {
    const r = await this.#api.post<{ droplet: DoDroplet }>("/droplets", {
      name: req.name,
      region: req.region,
      size: req.size,
      image: req.image.kind === "ubuntu" ? "ubuntu-24-04-x64" : Number(req.image.id),
      ssh_keys: [Number(req.sshKeyId)],
      ipv6: true,
      monitoring: false,
      tags: [req.tag, "cubehold"],
    });
    return vmOf(r.droplet);
  }

  async getVm(id: string): Promise<CloudVm | null> {
    const r = await this.#api.find<{ droplet: DoDroplet }>(`/droplets/${id}`);
    return r ? vmOf(r.droplet) : null;
  }

  async startVm(id: string): Promise<void> {
    await this.#api.post(`/droplets/${id}/actions`, { type: "power_on" });
  }

  async stopVm(id: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.#api.post(`/droplets/${id}/actions`, {
      type: opts.force ? "power_off" : "shutdown",
    });
  }

  deleteVm(id: string): Promise<void> {
    return this.#api.del(`/droplets/${id}`);
  }

  async snapshotVm(id: string, name: string): Promise<string> {
    const r = await this.#api.post<{ action: { id: number } }>(`/droplets/${id}/actions`, {
      type: "snapshot",
      name,
    });
    return `${r.action.id}:${name}`;
  }

  async snapshotState(handle: string): Promise<SnapshotState> {
    const i = handle.indexOf(":");
    const actionId = handle.slice(0, i);
    const name = handle.slice(i + 1);
    const a = await this.#api.find<{ action: { status: string } }>(`/actions/${actionId}`);
    if (a?.action.status === "errored") return { status: "error", imageId: null, sizeGb: null };
    if (a && a.action.status !== "completed")
      return { status: "pending", imageId: null, sizeGb: null };
    const list = await this.#api.get<{
      snapshots: Array<{ id: string; name: string; size_gigabytes: number }>;
    }>("/snapshots", { resource_type: "droplet", per_page: 200 });
    const snap = list.snapshots.find((s) => s.name === name);
    if (!snap) return { status: a ? "pending" : "missing", imageId: null, sizeGb: null };
    return { status: "ready", imageId: String(snap.id), sizeGb: snap.size_gigabytes };
  }

  deleteSnapshot(imageId: string): Promise<void> {
    return this.#api.del(`/snapshots/${imageId}`);
  }
}

function inbound(ports: FirewallPort[]) {
  return [
    { protocol: "tcp", ports: "22", sources: ALL },
    { protocol: "icmp", sources: ALL },
    ...ports.map((p) => ({ protocol: p.protocol, ports: String(p.port), sources: ALL })),
  ];
}

function vmOf(d: DoDroplet): CloudVm {
  return {
    id: String(d.id),
    status:
      d.status === "new"
        ? "creating"
        : d.status === "active"
          ? "running"
          : d.status === "off" || d.status === "archive"
            ? "stopped"
            : "unknown",
    ipv4: d.networks.v4.find((n) => n.type === "public")?.ip_address ?? null,
    ipv6: d.networks.v6.find((n) => n.type === "public")?.ip_address ?? null,
  };
}
