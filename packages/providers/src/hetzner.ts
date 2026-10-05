import { continentOf, RestClient } from "./http.js";
import { alwaysOnMonthly, BILLING } from "./pricing.js";
import {
  type CloudProvider,
  type CloudRegion,
  type CloudResource,
  type CloudSize,
  type CloudVm,
  type CreateVmRequest,
  type FetchLike,
  type FirewallPort,
  type SnapshotState,
  tagIn,
  type VmStatus,
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
interface HzListedServer extends HzServer {
  name: string;
  labels?: Record<string, string>;
  server_type: Pick<HzServerType, "name" | "disk" | "prices">;
  datacenter?: { location?: { name: string } };
}
type Labels = Record<string, string> | undefined;
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

  async inventory(): Promise<CloudResource[]> {
    const [servers, images, firewalls, keys, ips, volumes] = await Promise.all([
      this.#all<HzListedServer>("/servers", "servers"),
      this.#all<{
        id: number;
        description: string;
        image_size: number | null;
        status: string;
        labels?: Record<string, string>;
      }>("/images?type=snapshot", "images"),
      this.#all<{ id: number; name: string; labels?: Record<string, string> }>(
        "/firewalls",
        "firewalls",
      ),
      this.#all<{ id: number; name: string; labels?: Record<string, string> }>(
        "/ssh_keys",
        "ssh_keys",
      ),
      this.#all<{
        id: number;
        name: string;
        type: string;
        ip: string;
        assignee_id: number | null;
        datacenter?: { location?: { name: string } };
      }>("/primary_ips", "primary_ips"),
      this.#all<{
        id: number;
        name: string;
        size: number;
        server: number | null;
        location?: { name: string };
        labels?: Record<string, string>;
      }>("/volumes", "volumes"),
    ]);
    const ours = (labels: Labels, name: string) =>
      labels?.cubehold === "1" || !!labels?.["cubehold-host"] || !!tagIn(name);
    const out: CloudResource[] = [];
    for (const v of servers) {
      if (v.status === "deleting") continue;
      const loc = v.datacenter?.location?.name ?? null;
      const price = v.server_type.prices.find((p) => p.location === loc);
      out.push({
        kind: "vm",
        id: String(v.id),
        name: v.name,
        region: loc,
        ours: ours(v.labels, v.name),
        tag: v.labels?.["cubehold-host"] ?? tagIn(v.name),
        detail: `${v.server_type.name.toUpperCase()}, ${v.status === "off" ? "off" : v.status}`,
        monthly: price
          ? alwaysOnMonthly("hetzner", {
              priceHourly: Number(price.price_hourly.net),
              priceMonthly: Number(price.price_monthly.net),
              diskGb: v.server_type.disk,
            }) - (v.public_net.ipv4 ? 0 : 0.5)
          : null,
      });
    }
    for (const i of images) {
      out.push({
        kind: "snapshot",
        id: String(i.id),
        name: i.description || `snapshot ${i.id}`,
        region: null,
        ours: ours(i.labels, i.description),
        tag: tagIn(i.description),
        detail: i.image_size != null ? `${round1(i.image_size)} GB` : i.status,
        monthly: i.image_size != null ? i.image_size * BILLING.hetzner.snapshotPerGbMonth : null,
      });
    }
    for (const f of firewalls) {
      if (!ours(f.labels, f.name)) continue;
      out.push(free("firewall", String(f.id), f.name, tagIn(f.name)));
    }
    for (const k of keys) {
      if (!ours(k.labels, k.name)) continue;
      out.push(free("ssh-key", String(k.id), k.name, tagIn(k.name)));
    }
    for (const ip of ips) {
      // Assigned addresses are part of their server's price; IPv6 is free.
      if (ip.assignee_id !== null || ip.type !== "ipv4") continue;
      out.push({
        kind: "ip",
        id: String(ip.id),
        name: ip.name || ip.ip,
        region: ip.datacenter?.location?.name ?? null,
        ours: false,
        tag: null,
        detail: `${ip.ip}, not assigned`,
        monthly: BILLING.hetzner.ipv4MonthlyCap,
      });
    }
    for (const v of volumes) {
      out.push({
        kind: "volume",
        id: String(v.id),
        name: v.name,
        region: v.location?.name ?? null,
        ours: ours(v.labels, v.name),
        tag: tagIn(v.name),
        detail: `${v.size} GB${v.server === null ? ", not attached" : ""}`,
        monthly: null,
      });
    }
    return out;
  }

  async deleteResource(r: Pick<CloudResource, "kind" | "id">): Promise<void> {
    switch (r.kind) {
      case "vm":
        return this.deleteVm(r.id);
      case "snapshot":
        return this.deleteSnapshot(r.id);
      case "firewall":
        return this.deleteFirewall(r.id);
      case "ssh-key":
        return this.deleteSshKey(r.id);
      case "ip":
        return this.#api.del(`/primary_ips/${r.id}`);
      case "volume": {
        const v = await this.#api.find<{ volume: { server: number | null } }>(`/volumes/${r.id}`);
        if (!v) return;
        if (v.volume.server !== null) await this.#api.post(`/volumes/${r.id}/actions/detach`);
        // A detach takes a moment; deleting an attached volume fails.
        for (let i = 0; ; i++) {
          try {
            return await this.#api.del(`/volumes/${r.id}`);
          } catch (err) {
            if (i >= 5) throw err;
            await new Promise((ok) => setTimeout(ok, 3_000));
          }
        }
      }
      case "tag":
        return;
    }
  }

  async #all<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    const [base, search] = path.split("?");
    const filter = Object.fromEntries(new URLSearchParams(search ?? ""));
    for (let page = 1; page < 50; page++) {
      const r = await this.#api.get<Paginated & Record<string, T[]>>(base as string, {
        ...filter,
        per_page: 50,
        page,
      });
      out.push(...((r[key] as T[]) ?? []));
      if (!r.meta?.pagination?.next_page) break;
    }
    return out;
  }
}

function free(
  kind: CloudResource["kind"],
  id: string,
  name: string,
  tag: string | null,
): CloudResource {
  return { kind, id, name, region: null, ours: true, tag, detail: null, monthly: 0 };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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
