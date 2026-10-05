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

interface VuInstance {
  id: string;
  main_ip: string;
  v6_main_ip: string;
  status: string;
  power_status: string;
  server_status: string;
}
interface VuRule {
  id: number;
  ip_type: "v4" | "v6";
  protocol: string;
  port: string;
  notes?: string;
}

/** Plan families for game servers: regular, high frequency/performance and dedicated. */
const PLAN_TYPES = new Set(["vc2", "vhf", "vhp", "voc", "vdc"]);

interface VuPlan {
  id: string;
  vcpu_count: number;
  ram: number;
  disk: number;
  monthly_cost: number;
  hourly_cost?: number;
  type: string;
  locations: string[];
  /** "hourly" plans have no monthly cap. */
  invoice_type?: "monthly" | "hourly";
  /** Locations that cost more than the plan's base price. */
  location_cost?: Record<string, { monthly_cost: number; hourly_cost: number }>;
}

/** A plan's price in a region. Monthly-invoiced plans bill hourly up to 672 hours. */
function priceIn(p: VuPlan, region: string) {
  const here = p.location_cost?.[region];
  const monthly = here?.monthly_cost ?? p.monthly_cost;
  const hourly =
    here?.hourly_cost ?? p.hourly_cost ?? Math.round((monthly / 672) * 10_000) / 10_000;
  return { priceHourly: hourly, priceMonthly: monthly, noMonthlyCap: p.invoice_type === "hourly" };
}

/** Vultr API v2 with an account API key. Prices in US dollars. */
export class VultrProvider implements CloudProvider {
  readonly id = "vultr" as const;
  readonly loginUser = "root";
  #api: RestClient;
  #ubuntuOs: number | null = null;

  constructor(token: string, opts: { fetch?: FetchLike; base?: string } = {}) {
    this.#api = new RestClient({
      base: opts.base ?? "https://api.vultr.com/v2",
      token,
      provider: "Vultr",
      fetch: opts.fetch,
    });
  }

  async verify() {
    const r = await this.#api.get<{ account: { email: string; name: string } }>("/account");
    return { account: r.account.email || r.account.name || null };
  }

  async regions(): Promise<CloudRegion[]> {
    const r = await this.#api.get<{
      regions: Array<{ id: string; city: string; country: string; continent: string }>;
    }>("/regions", { per_page: 500 });
    return r.regions.map((x) => ({
      id: x.id,
      name: `${x.city} (${x.id})`,
      country: x.country,
      continent: continentOf(x.country),
    }));
  }

  async sizes(region: string): Promise<CloudSize[]> {
    const r = await this.#api.get<{ plans: VuPlan[] }>("/plans", { type: "all", per_page: 500 });
    return r.plans
      .filter((p) => PLAN_TYPES.has(p.type) && p.locations.includes(region))
      .map((p) => ({
        id: p.id,
        label: p.id,
        vcpus: p.vcpu_count,
        memoryMb: p.ram,
        diskGb: p.disk,
        arch: "x64" as const,
        dedicated: p.type === "voc" || p.type === "vdc",
        ...priceIn(p, region),
        currency: "USD" as const,
        priceSource: "api" as const,
      }))
      .sort((a, b) => a.priceMonthly - b.priceMonthly);
  }

  async ensureSshKey(name: string, publicKey: string): Promise<string> {
    const body = publicKey.split(/\s+/).slice(0, 2).join(" ");
    const list = await this.#api.get<{ ssh_keys: Array<{ id: string; ssh_key: string }> }>(
      "/ssh-keys",
      { per_page: 500 },
    );
    const same = list.ssh_keys.find((k) => k.ssh_key.split(/\s+/).slice(0, 2).join(" ") === body);
    if (same) return same.id;
    const r = await this.#api.post<{ ssh_key: { id: string } }>("/ssh-keys", {
      name,
      ssh_key: publicKey,
    });
    return r.ssh_key.id;
  }

  deleteSshKey(id: string): Promise<void> {
    return this.#api.del(`/ssh-keys/${id}`);
  }

  async createFirewall(
    name: string,
    _region: string,
    _tag: string,
    ports: FirewallPort[],
  ): Promise<string> {
    const r = await this.#api.post<{ firewall_group: { id: string } }>("/firewalls", {
      description: name.slice(0, 255),
    });
    const id = r.firewall_group.id;
    for (const rule of wantedRules(ports)) await this.#addRule(id, rule);
    return id;
  }

  async setFirewall(id: string, ports: FirewallPort[]): Promise<void> {
    const r = await this.#api.get<{ firewall_rules: VuRule[] }>(`/firewalls/${id}/rules`, {
      per_page: 500,
    });
    const want = wantedRules(ports);
    const key = (x: { ip_type: string; protocol: string; port: string }) =>
      `${x.ip_type}/${x.protocol}/${x.port}`;
    const wantKeys = new Set(want.map(key));
    const haveKeys = new Set(r.firewall_rules.map(key));
    for (const rule of r.firewall_rules) {
      if (!wantKeys.has(key(rule))) await this.#api.del(`/firewalls/${id}/rules/${rule.id}`);
    }
    for (const rule of want) if (!haveKeys.has(key(rule))) await this.#addRule(id, rule);
  }

  deleteFirewall(id: string): Promise<void> {
    return this.#api.del(`/firewalls/${id}`);
  }

  async createVm(req: CreateVmRequest): Promise<CloudVm> {
    const image =
      req.image.kind === "ubuntu" ? { os_id: await this.#ubuntu() } : { snapshot_id: req.image.id };
    const r = await this.#api.post<{ instance: VuInstance }>("/instances", {
      region: req.region,
      plan: req.size,
      ...image,
      label: req.name,
      hostname: req.name,
      sshkey_id: [req.sshKeyId],
      enable_ipv6: true,
      backups: "disabled",
      firewall_group_id: req.firewallId,
      tags: [req.tag, "cubehold"],
    });
    return vmOf(r.instance);
  }

  async getVm(id: string): Promise<CloudVm | null> {
    const r = await this.#api.find<{ instance: VuInstance }>(`/instances/${id}`);
    return r ? vmOf(r.instance) : null;
  }

  async startVm(id: string): Promise<void> {
    await this.#api.post(`/instances/${id}/start`);
  }

  /** Vultr only has a hard power-off; the panel shuts the system down over SSH first. */
  async stopVm(id: string): Promise<void> {
    await this.#api.post(`/instances/${id}/halt`);
  }

  deleteVm(id: string): Promise<void> {
    return this.#api.del(`/instances/${id}`);
  }

  async snapshotVm(id: string, name: string): Promise<string> {
    const r = await this.#api.post<{ snapshot: { id: string } }>("/snapshots", {
      instance_id: id,
      description: name,
    });
    return r.snapshot.id;
  }

  async snapshotState(handle: string): Promise<SnapshotState> {
    const r = await this.#api.find<{
      snapshot: { id: string; status: string; size: number; compressed_size?: number };
    }>(`/snapshots/${handle}`);
    if (!r) return { status: "missing", imageId: null, sizeGb: null };
    const s = r.snapshot;
    const bytes = s.compressed_size || s.size;
    return {
      status: s.status === "complete" ? "ready" : s.status === "pending" ? "pending" : "error",
      imageId: s.id,
      sizeGb: bytes ? Math.round((bytes / 1e9) * 10) / 10 : null,
    };
  }

  deleteSnapshot(imageId: string): Promise<void> {
    return this.#api.del(`/snapshots/${imageId}`);
  }

  async inventory(): Promise<CloudResource[]> {
    const [instances, plans, snapshots, firewalls, keys, blocks, ips] = await Promise.all([
      this.#all<VuInstance & { label: string; region: string; plan: string; tags?: string[] }>(
        "/instances",
        "instances",
      ),
      this.#all<VuPlan>("/plans?type=all", "plans"),
      this.#all<{
        id: string;
        description: string;
        size: number;
        compressed_size?: number;
        status: string;
      }>("/snapshots", "snapshots"),
      this.#all<{ id: string; description: string }>("/firewalls", "firewall_groups"),
      this.#all<{ id: string; name: string }>("/ssh-keys", "ssh_keys"),
      this.#all<{
        id: string;
        label: string;
        size_gb: number;
        cost?: number;
        attached_to_instance: string;
        region: string;
      }>("/blocks", "blocks"),
      this.#all<{
        id: string;
        subnet: string;
        instance_id: string;
        region: string;
        label?: string;
      }>("/reserved-ips", "reserved_ips"),
    ]);
    const planOf = new Map(plans.map((x) => [x.id, x]));
    const out: CloudResource[] = [];
    for (const i of instances) {
      const tags = i.tags ?? [];
      const tag = tags.find((t) => tagIn(t) === t) ?? null;
      const plan = planOf.get(i.plan);
      out.push({
        kind: "vm",
        id: i.id,
        name: i.label || i.id,
        region: i.region,
        ours: tags.includes("cubehold") || !!tag,
        tag,
        detail: `${i.plan}, ${i.power_status === "stopped" ? "off" : i.status}`,
        monthly: plan
          ? alwaysOnMonthly("vultr", { ...priceIn(plan, i.region), diskGb: plan.disk })
          : null,
      });
    }
    for (const sn of snapshots) {
      const gb = (sn.compressed_size || sn.size) / 1e9;
      out.push({
        kind: "snapshot",
        id: sn.id,
        name: sn.description || `snapshot ${sn.id}`,
        region: null,
        ours: !!tagIn(sn.description),
        tag: tagIn(sn.description),
        detail: `${Math.round(gb * 10) / 10} GB`,
        monthly: gb * BILLING.vultr.snapshotPerGbMonth,
      });
    }
    for (const f of firewalls) {
      if (tagIn(f.description)) out.push(free("firewall", f.id, f.description));
    }
    for (const k of keys) {
      if (tagIn(k.name)) out.push(free("ssh-key", k.id, k.name));
    }
    for (const b of blocks) {
      out.push({
        kind: "volume",
        id: b.id,
        name: b.label || b.id,
        region: b.region,
        ours: !!tagIn(b.label),
        tag: tagIn(b.label),
        detail: `${b.size_gb} GB${b.attached_to_instance ? "" : ", not attached"}`,
        monthly: b.cost ?? null,
      });
    }
    for (const ip of ips) {
      if (ip.instance_id) continue;
      out.push({
        kind: "ip",
        id: ip.id,
        name: ip.label || ip.subnet,
        region: ip.region,
        ours: false,
        tag: null,
        detail: `${ip.subnet}, not attached`,
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
      case "volume":
        return this.#api.del(`/blocks/${r.id}`);
      case "ip":
        return this.#api.del(`/reserved-ips/${r.id}`);
      case "tag":
        return;
    }
  }

  async #all<T>(path: string, key: string): Promise<T[]> {
    const [base, search] = path.split("?");
    const filter = Object.fromEntries(new URLSearchParams(search ?? ""));
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.#api.get<
        Record<string, unknown> & { meta?: { links?: { next?: string } } }
      >(base as string, { ...filter, per_page: 500, cursor });
      out.push(...((r[key] as T[] | undefined) ?? []));
      cursor = r.meta?.links?.next || undefined;
      if (!cursor) break;
    }
    return out;
  }

  async #ubuntu(): Promise<number> {
    if (this.#ubuntuOs !== null) return this.#ubuntuOs;
    const r = await this.#api.get<{ os: Array<{ id: number; name: string; arch: string }> }>(
      "/os",
      {
        per_page: 500,
      },
    );
    const os = r.os.find((o) => /^Ubuntu 24\.04/.test(o.name) && o.arch === "x64");
    if (!os) throw new CloudError("unavailable", "Vultr does not offer Ubuntu 24.04 right now.");
    this.#ubuntuOs = os.id;
    return os.id;
  }

  async #addRule(
    id: string,
    rule: { ip_type: string; protocol: string; port: string; notes: string },
  ) {
    await this.#api.post(`/firewalls/${id}/rules`, {
      ...rule,
      subnet: rule.ip_type === "v4" ? "0.0.0.0" : "::",
      subnet_size: 0,
      ...(rule.protocol === "icmp" ? { port: undefined } : {}),
    });
  }
}

function free(kind: CloudResource["kind"], id: string, name: string): CloudResource {
  return { kind, id, name, region: null, ours: true, tag: tagIn(name), detail: null, monthly: 0 };
}

function wantedRules(ports: FirewallPort[]) {
  const base = [
    { protocol: "tcp", port: "22", notes: "SSH" },
    { protocol: "icmp", port: "", notes: "ping" },
    ...ports.map((p) => ({
      protocol: p.protocol,
      port: String(p.port),
      notes: (p.note ?? "Minecraft").slice(0, 255),
    })),
  ];
  return base.flatMap((r) => [
    { ip_type: "v4", ...r },
    { ip_type: "v6", ...r },
  ]);
}

function vmOf(i: VuInstance): CloudVm {
  const ip = (s: string | undefined) => (s && s !== "0.0.0.0" && s !== "::" ? s : null);
  const status =
    i.status === "pending"
      ? "creating"
      : i.power_status === "stopped"
        ? "stopped"
        : i.power_status === "running" && i.server_status === "ok"
          ? "running"
          : i.power_status === "running"
            ? "starting"
            : "unknown";
  return { id: i.id, status, ipv4: ip(i.main_ip), ipv6: ip(i.v6_main_ip) };
}
