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
    const r = await this.#api.get<{
      plans: Array<{
        id: string;
        vcpu_count: number;
        ram: number;
        disk: number;
        monthly_cost: number;
        hourly_cost?: number;
        type: string;
        locations: string[];
      }>;
    }>("/plans", { type: "all", per_page: 500 });
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
        // Vultr bills hourly up to 672 hours a month.
        priceHourly: p.hourly_cost ?? Math.round((p.monthly_cost / 672) * 10_000) / 10_000,
        priceMonthly: p.monthly_cost,
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
