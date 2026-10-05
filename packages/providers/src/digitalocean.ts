import { continentOf, RestClient } from "./http.js";
import { alwaysOnMonthly, BILLING } from "./pricing.js";
import {
  CloudError,
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

interface DoListedDroplet extends DoDroplet {
  name: string;
  tags: string[];
  size_slug: string;
  size?: { price_monthly: number; price_hourly: number; disk: number };
  region?: { slug: string };
}

/** An unassigned reserved IPv4 address, per month. */
const RESERVED_IP_MONTHLY = 5;
/** Volumes (block storage), per GB and month. */
const VOLUME_PER_GB_MONTH = 0.1;

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

  async inventory(): Promise<CloudResource[]> {
    const [droplets, snapshots, firewalls, keys, tags, volumes, ips] = await Promise.all([
      this.#all<DoListedDroplet>("/droplets", "droplets"),
      this.#all<{ id: string | number; name: string; size_gigabytes: number; regions: string[] }>(
        "/snapshots?resource_type=droplet",
        "snapshots",
      ),
      this.#all<{ id: string; name: string }>("/firewalls", "firewalls"),
      this.#all<{ id: number; name: string }>("/account/keys", "ssh_keys"),
      this.#all<{ name: string }>("/tags", "tags"),
      this.#all<{
        id: string;
        name: string;
        size_gigabytes: number;
        droplet_ids: number[];
        region?: { slug: string };
      }>("/volumes", "volumes"),
      this.#all<{ ip: string; droplet: unknown; region?: { slug: string } }>(
        "/reserved_ips",
        "reserved_ips",
      ),
    ]);
    const out: CloudResource[] = [];
    for (const d of droplets) {
      const tag = d.tags.find((t) => tagIn(t) === t) ?? null;
      out.push({
        kind: "vm",
        id: String(d.id),
        name: d.name,
        region: d.region?.slug ?? null,
        ours: d.tags.includes("cubehold") || !!tag,
        tag,
        detail: `${d.size_slug}, ${d.status === "active" ? "running" : d.status}`,
        monthly: d.size
          ? alwaysOnMonthly("digitalocean", {
              priceHourly: d.size.price_hourly,
              priceMonthly: d.size.price_monthly,
              diskGb: d.size.disk,
            })
          : null,
      });
    }
    for (const sn of snapshots) {
      out.push({
        kind: "snapshot",
        id: String(sn.id),
        name: sn.name,
        region: sn.regions[0] ?? null,
        ours: !!tagIn(sn.name),
        tag: tagIn(sn.name),
        detail: `${sn.size_gigabytes} GB`,
        monthly: sn.size_gigabytes * BILLING.digitalocean.snapshotPerGbMonth,
      });
    }
    for (const f of firewalls) {
      if (tagIn(f.name)) out.push(free("firewall", f.id, f.name));
    }
    for (const k of keys) {
      if (tagIn(k.name)) out.push(free("ssh-key", String(k.id), k.name));
    }
    for (const t of tags) {
      if (tagIn(t.name) === t.name) out.push(free("tag", t.name, t.name));
    }
    for (const v of volumes) {
      out.push({
        kind: "volume",
        id: v.id,
        name: v.name,
        region: v.region?.slug ?? null,
        ours: !!tagIn(v.name),
        tag: tagIn(v.name),
        detail: `${v.size_gigabytes} GB${v.droplet_ids.length === 0 ? ", not attached" : ""}`,
        monthly: v.size_gigabytes * VOLUME_PER_GB_MONTH,
      });
    }
    for (const ip of ips) {
      if (ip.droplet) continue; // free while assigned
      out.push({
        kind: "ip",
        id: ip.ip,
        name: ip.ip,
        region: ip.region?.slug ?? null,
        ours: false,
        tag: null,
        detail: "Reserved IP, not assigned",
        monthly: RESERVED_IP_MONTHLY,
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
      case "tag":
        return this.#api.del(`/tags/${encodeURIComponent(r.id)}`);
      case "volume":
        return this.#api.del(`/volumes/${r.id}`);
      case "ip":
        return this.#api.del(`/reserved_ips/${r.id}`);
    }
  }

  async #all<T>(path: string, key: string): Promise<T[]> {
    const [base, search] = path.split("?");
    const filter = Object.fromEntries(new URLSearchParams(search ?? ""));
    const out: T[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await this.#api.get<
        Record<string, unknown> & { links?: { pages?: { next?: string } } }
      >(base as string, { ...filter, per_page: 200, page });
      out.push(...((r[key] as T[] | undefined) ?? []));
      if (!r.links?.pages?.next) break;
    }
    return out;
  }
}

function free(kind: CloudResource["kind"], id: string, name: string): CloudResource {
  return { kind, id, name, region: null, ours: true, tag: tagIn(name), detail: null, monthly: 0 };
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
