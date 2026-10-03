import { continentOf, RestClient } from "./http.js";
import type {
  CloudProvider,
  CloudRegion,
  CloudSize,
  CloudVm,
  CreateVmRequest,
  FetchLike,
  FirewallPort,
  SnapshotState,
  VmStatus,
} from "./types.js";

interface HzPrice {
  location: string;
  price_hourly: { net: string };
  price_monthly: { net: string };
}
interface HzServerType {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  cpu_type: "shared" | "dedicated";
  architecture: "x86" | "arm";
  deprecation?: unknown;
  deprecated?: boolean;
  prices: HzPrice[];
}
interface HzServer {
  id: number;
  status: string;
  public_net: { ipv4: { ip: string } | null; ipv6: { ip: string } | null };
}
interface Paginated {
  meta?: { pagination?: { next_page: number | null } };
}

const ALL = ["0.0.0.0/0", "::/0"];

/** Hetzner Cloud API v1: one project token (Read & Write). Prices are net, in euros. */
export class HetznerProvider implements CloudProvider {
  readonly id = "hetzner" as const;
  readonly loginUser = "root";
  #api: RestClient;

  constructor(token: string, opts: { fetch?: FetchLike; base?: string } = {}) {
    this.#api = new RestClient({
      base: opts.base ?? "https://api.hetzner.cloud/v1",
      token,
      provider: "Hetzner",
      fetch: opts.fetch,
    });
  }

  async verify() {
    await this.#api.get("/servers", { per_page: 1 });
    return { account: null };
  }

  async regions(): Promise<CloudRegion[]> {
    const r = await this.#api.get<{
      locations: Array<{ name: string; city: string; country: string }>;
    }>("/locations");
    return r.locations.map((l) => ({
      id: l.name,
      name: `${l.city} (${l.name})`,
      country: l.country,
      continent: continentOf(l.country),
    }));
  }

  async sizes(region: string): Promise<CloudSize[]> {
    const types = await this.#all<HzServerType>("/server_types", "server_types");
    const dcs = await this.#api.get<{
      datacenters: Array<{ location: { name: string }; server_types: { available: number[] } }>;
    }>("/datacenters");
    const available = new Set(
      dcs.datacenters
        .filter((d) => d.location.name === region)
        .flatMap((d) => d.server_types.available),
    );
    const out: CloudSize[] = [];
    for (const t of types) {
      if (t.deprecation || t.deprecated) continue;
      if (available.size > 0 && !available.has(t.id)) continue;
      const price = t.prices.find((p) => p.location === region);
      if (!price) continue;
      out.push({
        id: t.name,
        label: t.name.toUpperCase(),
        vcpus: t.cores,
        memoryMb: Math.round(t.memory * 1024),
        diskGb: t.disk,
        arch: t.architecture === "arm" ? "arm64" : "x64",
        dedicated: t.cpu_type === "dedicated",
        priceHourly: Number(price.price_hourly.net),
        priceMonthly: Number(price.price_monthly.net),
        currency: "EUR",
        priceSource: "api",
      });
    }
    return out.sort((a, b) => a.priceMonthly - b.priceMonthly);
  }

  async ensureSshKey(name: string, publicKey: string): Promise<string> {
    const existing = await this.#all<{ id: number; public_key: string }>("/ssh_keys", "ssh_keys");
    const body = publicKey.split(/\s+/).slice(0, 2).join(" ");
    const same = existing.find((k) => k.public_key.split(/\s+/).slice(0, 2).join(" ") === body);
    if (same) return String(same.id);
    const r = await this.#api.post<{ ssh_key: { id: number } }>("/ssh_keys", {
      name,
      public_key: publicKey,
      labels: { cubehold: "1" },
    });
    return String(r.ssh_key.id);
  }

  deleteSshKey(id: string): Promise<void> {
    return this.#api.del(`/ssh_keys/${id}`);
  }

  async createFirewall(
    name: string,
    _region: string,
    tag: string,
    ports: FirewallPort[],
  ): Promise<string> {
    const r = await this.#api.post<{ firewall: { id: number } }>("/firewalls", {
      name,
      labels: { cubehold: "1" },
      rules: rules(ports),
      apply_to: [{ type: "label_selector", label_selector: { selector: `cubehold-host=${tag}` } }],
    });
    return String(r.firewall.id);
  }

  async setFirewall(id: string, ports: FirewallPort[]): Promise<void> {
    await this.#api.post(`/firewalls/${id}/actions/set_rules`, { rules: rules(ports) });
  }

  async deleteFirewall(id: string): Promise<void> {
    const fw = await this.#api.find<{
      firewall: { applied_to: Array<{ type: string; label_selector?: { selector: string } }> };
    }>(`/firewalls/${id}`);
    if (!fw) return;
    const selectors = fw.firewall.applied_to.filter((a) => a.type === "label_selector");
    if (selectors.length > 0) {
      await this.#api.post(`/firewalls/${id}/actions/remove_from_resources`, {
        remove_from: selectors.map((s) => ({
          type: "label_selector",
          label_selector: s.label_selector,
        })),
      });
    }
    await this.#api.del(`/firewalls/${id}`);
  }

  async createVm(req: CreateVmRequest): Promise<CloudVm> {
    const r = await this.#api.post<{ server: HzServer }>("/servers", {
      name: req.name,
      server_type: req.size,
      location: req.region,
      image: req.image.kind === "ubuntu" ? "ubuntu-24.04" : Number(req.image.id),
      ssh_keys: [Number(req.sshKeyId)],
      labels: { "cubehold-host": req.tag, cubehold: "1" },
      start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
    });
    return vmOf(r.server);
  }

  async getVm(id: string): Promise<CloudVm | null> {
    const r = await this.#api.find<{ server: HzServer }>(`/servers/${id}`);
    return r ? vmOf(r.server) : null;
  }

  async startVm(id: string): Promise<void> {
    await this.#api.post(`/servers/${id}/actions/poweron`);
  }

  async stopVm(id: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.#api.post(`/servers/${id}/actions/${opts.force ? "poweroff" : "shutdown"}`);
  }

  deleteVm(id: string): Promise<void> {
    return this.#api.del(`/servers/${id}`);
  }

  async snapshotVm(id: string, name: string): Promise<string> {
    const r = await this.#api.post<{ image: { id: number } }>(
      `/servers/${id}/actions/create_image`,
      {
        type: "snapshot",
        description: name,
        labels: { cubehold: "1" },
      },
    );
    return String(r.image.id);
  }

  async snapshotState(handle: string): Promise<SnapshotState> {
    const r = await this.#api.find<{
      image: { id: number; status: string; image_size: number | null; disk_size: number };
    }>(`/images/${handle}`);
    if (!r) return { status: "missing", imageId: null, sizeGb: null };
    const status =
      r.image.status === "available"
        ? "ready"
        : r.image.status === "creating"
          ? "pending"
          : "error";
    return { status, imageId: String(r.image.id), sizeGb: r.image.image_size ?? null };
  }

  deleteSnapshot(imageId: string): Promise<void> {
    return this.#api.del(`/images/${imageId}`);
  }

  async #all<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await this.#api.get<Paginated & Record<string, T[]>>(path, { per_page: 50, page });
      out.push(...((r[key] as T[]) ?? []));
      if (!r.meta?.pagination?.next_page) break;
    }
    return out;
  }
}

function rules(ports: FirewallPort[]) {
  return [
    { direction: "in", protocol: "tcp", port: "22", source_ips: ALL, description: "SSH" },
    { direction: "in", protocol: "icmp", source_ips: ALL, description: "ping" },
    ...ports.map((p) => ({
      direction: "in",
      protocol: p.protocol,
      port: String(p.port),
      source_ips: ALL,
      description: (p.note ?? "Minecraft").slice(0, 255),
    })),
  ];
}

function vmOf(s: HzServer): CloudVm {
  const map: Record<string, VmStatus> = {
    initializing: "creating",
    starting: "starting",
    running: "running",
    stopping: "stopping",
    off: "stopped",
    deleting: "deleting",
  };
  const v6 = s.public_net.ipv6?.ip ?? null;
  return {
    id: String(s.id),
    status: map[s.status] ?? "unknown",
    ipv4: s.public_net.ipv4?.ip ?? null,
    // Hetzner assigns a /64; the server answers on ::1 of it.
    ipv6: v6 ? v6.replace(/\/\d+$/, "").replace(/::$/, "::1") : null,
  };
}
