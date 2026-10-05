import { randomBytes } from "node:crypto";
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

interface LiInstance {
  id: number;
  status: string;
  ipv4: string[];
  ipv6: string | null;
}

interface LiType {
  id: string;
  label: string;
  memory: number;
  vcpus: number;
  disk: number;
  class: string;
  /** monthly is null for plans billed by the hour only (G8 Dedicated, GPUs). */
  price: { hourly: number; monthly: number | null };
  region_prices?: Array<{ id: string; hourly: number; monthly: number | null }>;
}

/** A type's price in a region; hourly-only plans get 730 hours as their month and no cap. */
function priceIn(t: LiType, region: string) {
  const p = t.region_prices?.find((x) => x.id === region) ?? t.price;
  const hourly = p.hourly ?? 0;
  return p.monthly
    ? { priceHourly: hourly, priceMonthly: p.monthly, noMonthlyCap: false }
    : {
        priceHourly: hourly,
        priceMonthly: Math.round(hourly * 730 * 100) / 100,
        noMonthlyCap: true,
      };
}

const CLASSES = new Set(["standard", "dedicated", "highmem", "premium"]);
/** Block storage volumes, per GB and month. */
const VOLUME_PER_GB_MONTH = 0.1;
const ALL = { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] };

/** Linode (Akamai) API v4 with a personal access token. Prices in US dollars. */
export class LinodeProvider implements CloudProvider {
  readonly id = "linode" as const;
  readonly loginUser = "root";
  #api: RestClient;

  constructor(token: string, opts: { fetch?: FetchLike; base?: string } = {}) {
    this.#api = new RestClient({
      base: opts.base ?? "https://api.linode.com/v4",
      token,
      provider: "Linode",
      fetch: opts.fetch,
    });
  }

  async verify() {
    const r = await this.#api.get<{ username: string; email: string }>("/profile");
    return { account: r.email || r.username || null };
  }

  async regions(): Promise<CloudRegion[]> {
    const r = await this.#api.get<{
      data: Array<{
        id: string;
        label: string;
        country: string;
        status: string;
        capabilities: string[];
      }>;
    }>("/regions", { page_size: 500 });
    return r.data
      .filter((x) => x.status === "ok" && x.capabilities.includes("Linodes"))
      .map((x) => {
        const country = x.country.toUpperCase();
        return { id: x.id, name: `${x.label} (${x.id})`, country, continent: continentOf(country) };
      });
  }

  async sizes(region: string): Promise<CloudSize[]> {
    const r = await this.#api.get<{ data: LiType[] }>("/linode/types", { page_size: 500 });
    return r.data
      .filter((t) => CLASSES.has(t.class))
      .map((t) => {
        const p = priceIn(t, region);
        return {
          id: t.id,
          label: t.label,
          vcpus: t.vcpus,
          memoryMb: t.memory,
          diskGb: Math.round(t.disk / 1024),
          arch: "x64" as const,
          dedicated: t.class === "dedicated" || t.class === "premium",
          ...p,
          currency: "USD" as const,
          priceSource: "api" as const,
        };
      })
      .sort((a, b) => a.priceMonthly - b.priceMonthly);
  }

  /** Linode takes the key inline at creation; there is nothing to register. */
  async ensureSshKey(): Promise<string> {
    return "inline";
  }

  async deleteSshKey(): Promise<void> {}

  async createFirewall(
    _name: string,
    _region: string,
    tag: string,
    ports: FirewallPort[],
  ): Promise<string> {
    const r = await this.#api.post<{ id: number }>("/networking/firewalls", {
      label: tag.slice(0, 32),
      rules: rules(ports),
      tags: ["cubehold"],
    });
    return String(r.id);
  }

  async setFirewall(id: string, ports: FirewallPort[]): Promise<void> {
    await this.#api.put(`/networking/firewalls/${id}/rules`, rules(ports));
  }

  deleteFirewall(id: string): Promise<void> {
    return this.#api.del(`/networking/firewalls/${id}`);
  }

  async createVm(req: CreateVmRequest): Promise<CloudVm> {
    const r = await this.#api.post<LiInstance>("/linode/instances", {
      region: req.region,
      type: req.size,
      image: req.image.kind === "ubuntu" ? "linode/ubuntu24.04" : req.image.id,
      label: linodeLabel(req.name),
      // Required by Linode; never used or kept: the panel logs in with its key, and
      // setup turns password logins off.
      root_pass: `${randomBytes(24).toString("base64url")}aA1!`,
      authorized_keys: [req.publicKey],
      booted: true,
      firewall_id: Number(req.firewallId),
      tags: ["cubehold", req.tag],
    });
    return vmOf(r);
  }

  async getVm(id: string): Promise<CloudVm | null> {
    const r = await this.#api.find<LiInstance>(`/linode/instances/${id}`);
    return r ? vmOf(r) : null;
  }

  async startVm(id: string): Promise<void> {
    await this.#api.post(`/linode/instances/${id}/boot`);
  }

  async stopVm(id: string): Promise<void> {
    await this.#api.post(`/linode/instances/${id}/shutdown`);
  }

  deleteVm(id: string): Promise<void> {
    return this.#api.del(`/linode/instances/${id}`);
  }

  /** Linode images a disk, not a machine: take the main (non-swap) disk. */
  async snapshotVm(id: string, name: string): Promise<string> {
    const disks = await this.#api.get<{
      data: Array<{ id: number; filesystem: string; size: number }>;
    }>(`/linode/instances/${id}/disks`);
    const disk = disks.data
      .filter((d) => d.filesystem !== "swap")
      .sort((a, b) => b.size - a.size)[0];
    if (!disk) throw new Error("This Linode has no disk to save");
    const r = await this.#api.post<{ id: string }>("/images", {
      disk_id: disk.id,
      label: name.slice(0, 50),
      description: "Saved by cubehold while the server sleeps",
    });
    return r.id;
  }

  async snapshotState(handle: string): Promise<SnapshotState> {
    const r = await this.#api.find<{ id: string; status: string; size: number }>(
      `/images/${handle}`,
    );
    if (!r) return { status: "missing", imageId: null, sizeGb: null };
    return {
      status: r.status === "available" ? "ready" : r.status === "creating" ? "pending" : "error",
      imageId: r.id,
      sizeGb: r.size ? Math.round((r.size / 1024) * 10) / 10 : null,
    };
  }

  deleteSnapshot(imageId: string): Promise<void> {
    return this.#api.del(`/images/${imageId}`);
  }

  async inventory(): Promise<CloudResource[]> {
    const [instances, types, images, firewalls, volumes] = await Promise.all([
      this.#all<LiInstance & { label: string; region: string; type: string; tags: string[] }>(
        "/linode/instances",
      ),
      this.#all<LiType>("/linode/types"),
      this.#all<{ id: string; label: string; size: number; is_public: boolean }>("/images"),
      this.#all<{ id: number; label: string; tags?: string[] }>("/networking/firewalls"),
      this.#all<{
        id: number;
        label: string;
        size: number;
        linode_id: number | null;
        region: string;
        tags?: string[];
      }>("/volumes"),
    ]);
    const typeOf = new Map(types.map((t) => [t.id, t]));
    const out: CloudResource[] = [];
    for (const i of instances) {
      if (i.status === "deleting") continue;
      const tag = i.tags.find((t) => tagIn(t) === t) ?? null;
      const t = typeOf.get(i.type);
      out.push({
        kind: "vm",
        id: String(i.id),
        name: i.label,
        region: i.region,
        ours: i.tags.includes("cubehold") || !!tag,
        tag,
        detail: `${i.type}, ${i.status === "offline" ? "off" : i.status}`,
        monthly: t
          ? alwaysOnMonthly("linode", {
              ...priceIn(t, i.region),
              diskGb: Math.round(t.disk / 1024),
            })
          : null,
      });
    }
    for (const im of images) {
      if (im.is_public) continue;
      const gb = im.size / 1024;
      out.push({
        kind: "snapshot",
        id: im.id,
        name: im.label,
        region: null,
        ours: !!tagIn(im.label),
        tag: tagIn(im.label),
        detail: `${Math.round(gb * 10) / 10} GB`,
        monthly: gb * BILLING.linode.snapshotPerGbMonth,
      });
    }
    for (const f of firewalls) {
      if (!tagIn(f.label) && !f.tags?.includes("cubehold")) continue;
      out.push({
        kind: "firewall",
        id: String(f.id),
        name: f.label,
        region: null,
        ours: true,
        tag: tagIn(f.label),
        detail: null,
        monthly: 0,
      });
    }
    for (const v of volumes) {
      out.push({
        kind: "volume",
        id: String(v.id),
        name: v.label,
        region: v.region,
        ours: !!tagIn(v.label) || !!v.tags?.includes("cubehold"),
        tag: tagIn(v.label),
        detail: `${v.size} GB${v.linode_id === null ? ", not attached" : ""}`,
        monthly: v.size * VOLUME_PER_GB_MONTH,
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
      case "volume": {
        const v = await this.#api.find<{ linode_id: number | null }>(`/volumes/${r.id}`);
        if (!v) return;
        if (v.linode_id !== null) {
          await this.#api.post(`/volumes/${r.id}/detach`);
          await new Promise((ok) => setTimeout(ok, 5_000));
        }
        return this.#api.del(`/volumes/${r.id}`);
      }
      case "ssh-key":
      case "ip":
      case "tag":
        return;
    }
  }

  async #all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await this.#api.get<{ data: T[]; pages?: number }>(path, {
        page_size: 500,
        page,
      });
      out.push(...r.data);
      if (!r.pages || page >= r.pages) break;
    }
    return out;
  }
}

function rules(ports: FirewallPort[]) {
  return {
    inbound_policy: "DROP",
    outbound_policy: "ACCEPT",
    inbound: [
      { action: "ACCEPT", protocol: "TCP", ports: "22", addresses: ALL, label: "ssh" },
      { action: "ACCEPT", protocol: "ICMP", addresses: ALL, label: "ping" },
      ...ports.map((p) => ({
        action: "ACCEPT",
        protocol: p.protocol.toUpperCase(),
        ports: String(p.port),
        addresses: ALL,
        label: `mc-${p.protocol}-${p.port}`,
      })),
    ],
    outbound: [],
  };
}

/** Letters, digits, dashes, underscores and dots; no doubles; alphanumeric at both ends. */
export function linodeLabel(name: string): string {
  const s = name
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/([_.-])[_.-]+/g, "$1")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
    .slice(0, 64);
  return s.length >= 3 ? s : `cubehold-${s || "server"}`;
}

function vmOf(i: LiInstance): CloudVm {
  const map: Record<string, VmStatus> = {
    provisioning: "creating",
    booting: "starting",
    rebooting: "starting",
    running: "running",
    shutting_down: "stopping",
    offline: "stopped",
    deleting: "deleting",
  };
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return {
    id: String(i.id),
    status: map[i.status] ?? "unknown",
    ipv4: i.ipv4.find((ip) => !isPrivate(ip)) ?? null,
    ipv6: i.ipv6 ? i.ipv6.replace(/\/\d+$/, "") : null,
  };
}
