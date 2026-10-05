import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentApi, NetworkInfo } from "@cubehold/agent";
import { findJavaBinary } from "@cubehold/mc";
import { LOCAL_HOST_ID, type ServerStatus } from "@cubehold/shared";
import {
  checkFromOutside,
  evaluateInbound,
  type FirewallFix,
  type FirewallSnapshot,
  type InboundVerdict,
  type MappingRequest,
  type MappingState,
  pingJava,
  programWideRules,
} from "@cubehold/tunnels";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { type Db, schema } from "../db/index.js";
import type { HostManager } from "../hosts/manager.js";
import type { HostService } from "../hosts/service.js";
import type { RealtimeBus } from "../realtime/bus.js";
import {
  errMessage,
  nowIso,
  ServerError,
  type ServerRow,
  type ServerService,
} from "../servers/service.js";
import type { PlayitService } from "./playit.js";
import type { TailscaleService } from "./tailscale.js";
import type { TunnelService } from "./tunnels.js";

const FIREWALL_TTL_MS = 20_000;
/** An outside check older than this no longer says anything about exposure. */
const CHECK_RELEVANT_MS = 24 * 60 * 60_000;
const MAX_CHECK_WAIT_MS = 70_000;

export interface ReachabilityResult {
  via: "public" | "playit";
  address: string;
  reachable: boolean;
  checkedAt: string;
  latencyMs: number | null;
  /** What answered: the server, its sleeper, or the panel's test listener. */
  answeredBy: "server" | "sleeper" | "test" | null;
  detail: string;
  hint: string | null;
}

export interface FirewallView {
  supported: boolean;
  program: string | null;
  /** How Windows classifies the network ("Public", "Private"). */
  network: { name: string; category: string } | null;
  game: InboundVerdict | null;
  bedrock: InboundVerdict | null;
  rcon: InboundVerdict | null;
  /** Some rule opens every port to this Java (the RCON port too). */
  programWide: boolean;
  /** Block rules for this Java (the Windows prompt was cancelled once). */
  blocked: boolean;
}

/** Formats host:port the way players type it (25565 is the default and left out). */
export function joinAddress(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return port === 25565 ? h : `${h}:${port}`;
}

/**
 * How players reach each server: LAN, public IP with router port
 * forwarding (UPnP, kept by the agent), playit.gg, Tailscale. Tests
 * reachability from outside and checks Windows Firewall.
 */
export class NetworkService {
  #results = new Map<string, ReachabilityResult>();
  #firewall = new Map<string, { at: number; snap: FirewallSnapshot | null }>();

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly hosts: HostManager,
    private readonly hostAdmin: HostService,
    private readonly playit: PlayitService,
    private readonly tunnels: TunnelService,
    private readonly tailscale: TailscaleService,
    private readonly bus: RealtimeBus,
    private readonly config: Config,
  ) {}

  async init(): Promise<void> {
    // Router port forwarding (UPnP) is for the machine at home; a VPS has its own address.
    const sync = () => {
      this.syncMappings(LOCAL_HOST_ID).catch((err) =>
        console.warn("port forward sync failed", err),
      );
    };
    this.servers.events.on("changed", () => sync());
    this.servers.events.on("removed", () => sync());
    this.servers.events.on("moved", () => sync());
    this.hosts.onAgentConnect((hostId) => {
      if (hostId === LOCAL_HOST_ID) sync();
    });
    await this.syncMappings(LOCAL_HOST_ID).catch((err) =>
      console.warn("port forward sync failed", err),
    );
  }

  // --- host ---------------------------------------------------------------------------

  async host(hostId: string, refresh = false) {
    const agent = this.hosts.agentFor(hostId);
    const local = hostId === LOCAL_HOST_ID;
    const [info, mappings] = await Promise.all([
      agent.networkInfo(refresh).catch(() => null),
      local ? agent.portMappings().catch(() => [] as MappingState[]) : [],
    ]);
    const rows = await this.db
      .select({ id: schema.servers.id, name: schema.servers.name })
      .from(schema.servers)
      .where(eq(schema.servers.hostId, hostId));
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return {
      info,
      mappings: mappings.map((m) => ({
        ...m,
        server: names.get(m.key.split(":")[0] ?? "") ?? null,
      })),
      playit: hostId === LOCAL_HOST_ID ? await this.playit.status() : null,
    };
  }

  /** Tell the host's agent which router forwards to keep. */
  async syncMappings(hostId: string): Promise<MappingState[]> {
    const rows = await this.db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.hostId, hostId));
    const wanted: MappingRequest[] = [];
    for (const r of rows) {
      if (!r.settings?.upnp || r.meta?.deletingSince) continue;
      wanted.push({
        key: `${r.id}:java`,
        protocol: "TCP",
        port: r.port,
        description: `cubehold ${r.name}`,
      });
      if (r.settings.bedrockPort) {
        wanted.push({
          key: `${r.id}:bedrock`,
          protocol: "UDP",
          port: r.settings.bedrockPort,
          description: `cubehold ${r.name} Bedrock`,
        });
      }
    }
    return this.hosts.agentFor(hostId).setPortMappings(wanted);
  }

  // --- one server -----------------------------------------------------------------------

  async server(serverId: string) {
    const row = await this.servers.row(serverId);
    // A cloud VM that is down has no agent to ask; what the panel knows still shows.
    let agent: ReturnType<ServerService["agentOf"]> | null = null;
    try {
      agent = this.servers.agentOf(row);
    } catch {
      agent = null;
    }
    const local = row.hostId === LOCAL_HOST_ID;
    const [info, mappings, bedrockPort, host] = await Promise.all([
      agent ? agent.networkInfo(false).catch(() => null) : null,
      local && agent ? agent.portMappings().catch(() => [] as MappingState[]) : [],
      this.servers.bedrockPort(row, false).catch(() => row.settings?.bedrockPort ?? null),
      this.db.select().from(schema.hosts).where(eq(schema.hosts.id, row.hostId)).get(),
    ]);
    const vps = local ? null : await this.#vps(row, host?.publicIp ?? null, bedrockPort, info);
    const playit = local ? await this.playit.status() : null;
    const tunnels = local
      ? await this.playit.tunnelsFor(
          row.port,
          bedrockPort,
          (info?.lan ?? []).map((a) => a.address),
        )
      : { java: [], bedrock: [] };
    const firewall = await this.firewall(row).catch(() => null);
    const [ngrok, cloudflare, tailscale] = local
      ? await Promise.all([
          this.tunnels.ngrokStatus().catch(() => null),
          this.tunnels.cloudflaredStatus().catch(() => null),
          this.tailscale.forServer(serverId).catch(() => null),
        ])
      : [null, null, null];
    return {
      serverId,
      name: row.name,
      port: row.port,
      bedrockPort,
      rconPort: row.settings?.rcon?.port ?? null,
      status: this.bus.snapshot(serverId).status,
      host: {
        id: row.hostId,
        name: host?.name ?? row.hostId,
        kind: (host?.kind ?? "local") as "local" | "ssh" | "cloud",
        /** A cloud VM that is stopped or deleted (snapshot kept): its old address may not come back. */
        vmDown: host?.kind === "cloud" && host.cloud?.power !== "running",
      },
      vps,
      addresses: {
        lan: local && info?.primary ? joinAddress(info.primary, row.port) : null,
        publicIpv4: vps?.ip
          ? joinAddress(vps.ip, row.port)
          : info?.publicIpv4
            ? joinAddress(info.publicIpv4, row.port)
            : null,
        publicIpv6: info?.publicIpv6 ? joinAddress(info.publicIpv6, row.port) : null,
        tailscale: info?.tailscale ? joinAddress(info.tailscale, row.port) : null,
        bedrockLan: local && info?.primary && bedrockPort ? `${info.primary}:${bedrockPort}` : null,
        bedrockPublic:
          (vps?.ip ?? info?.publicIpv4) && bedrockPort
            ? `${vps?.ip ?? info?.publicIpv4}:${bedrockPort}`
            : null,
      },
      network:
        info && local
          ? {
              wan: info.wan,
              vpn: info.vpn,
              router: info.router,
              lanIp: info.primary,
              checkedAt: info.checkedAt,
            }
          : null,
      upnp: {
        enabled: row.settings?.upnp === true,
        mappings: mappings.filter((m) => m.key.startsWith(`${serverId}:`)),
      },
      playit: playit
        ? {
            supported: playit.supported,
            linked: playit.linked,
            locked: playit.locked,
            state: playit.tunnel?.state ?? "stopped",
            error: playit.error ?? playit.tunnel?.error ?? null,
            agentId: playit.agentId,
            accountStatus: playit.accountStatus,
            notices: playit.notices,
            pending: playit.pending,
            claim: playit.claim,
            createRefused: playit.createRefused,
            java: tunnels.java,
            bedrock: tunnels.bedrock,
            /** Other tunnels of this agent, e.g. pointing at a port no server uses. */
            others: playit.tunnels.filter(
              (t) => !tunnels.java.includes(t) && !tunnels.bedrock.includes(t),
            ),
          }
        : null,
      ngrok: ngrok
        ? {
            supported: ngrok.supported,
            configured: ngrok.configured,
            locked: ngrok.locked,
            state: ngrok.tunnel?.state ?? "stopped",
            error: ngrok.error,
            shared: row.settings?.ngrok === true,
            address: ngrok.shared.find((s) => s.serverId === serverId)?.address ?? null,
            lines: ngrok.tunnel?.lines.slice(-30) ?? [],
          }
        : null,
      cloudflare: cloudflare
        ? {
            supported: cloudflare.supported,
            configured: cloudflare.configured,
            locked: cloudflare.locked,
            state: cloudflare.tunnel?.state ?? "stopped",
            error: cloudflare.error,
            tunnelId: cloudflare.tunnelId,
            routes: cloudflare.routes,
            mine: cloudflare.routes.filter((r) => r.port === row.port),
            lines: cloudflare.tunnel?.lines.slice(-30) ?? [],
          }
        : null,
      tailscale,
      firewall,
      checks: {
        public: this.#results.get(`${serverId}:public`) ?? null,
        playit: this.#results.get(`${serverId}:playit`) ?? null,
      },
    };
  }

  /**
   * A server on a VPS: the address players use and whether the host
   * firewall (ufw) lets the game ports in. The provider may have its own
   * firewall in front, which the panel cannot see; the reachability test can.
   */
  async #vps(
    row: ServerRow,
    address: string | null,
    bedrockPort: number | null,
    info: NetworkInfo | null,
  ) {
    const security =
      this.hostAdmin.cachedSecurity(row.hostId) ??
      (await this.hostAdmin.security(row.hostId).catch(() => null));
    const open = (port: number, protocol: "tcp" | "udp") =>
      !security
        ? null
        : security.firewall !== "active" ||
          security.openPorts.some((r) => r.port === port && r.protocol === protocol);
    return {
      ip: address ?? info?.publicIpv4 ?? null,
      firewall: security?.firewall ?? null,
      gameOpen: open(row.port, "tcp"),
      bedrockOpen: bedrockPort ? open(bedrockPort, "udp") : null,
      checkedAt: security?.checkedAt ?? null,
    };
  }

  /** Host security of a VPS for the security report; null for this computer. */
  async hostSecurity(row: ServerRow) {
    if (row.hostId === LOCAL_HOST_ID) return null;
    const security = await this.hostAdmin.security(row.hostId).catch(() => null);
    if (!security) return null;
    const bedrockPort = row.settings?.bedrockPort ?? null;
    return {
      security,
      gameOpen:
        security.firewall !== "active" ||
        security.openPorts.some((r) => r.port === row.port && r.protocol === "tcp"),
      bedrockOpen: bedrockPort
        ? security.firewall !== "active" ||
          security.openPorts.some((r) => r.port === bedrockPort && r.protocol === "udp")
        : null,
    };
  }

  async setUpnp(serverId: string, enabled: boolean) {
    const row = await this.servers.row(serverId);
    await this.servers.updateSettings(serverId, { upnp: enabled });
    await this.syncMappings(row.hostId);
    this.#results.delete(`${serverId}:public`);
    return this.server(serverId);
  }

  /** How the internet can reach this server, for the security report. */
  async exposure(serverId: string): Promise<{
    internet: boolean;
    via: Array<"upnp" | "playit" | "ngrok" | "cloudflare" | "funnel" | "tested" | "vps">;
  }> {
    const view = await this.server(serverId);
    const via: Array<"upnp" | "playit" | "ngrok" | "cloudflare" | "funnel" | "tested" | "vps"> = [];
    // A VPS has a public address: the game port is on the internet unless its firewall says no.
    if (view.vps && view.vps.gameOpen !== false) via.push("vps");
    if (view.upnp.mappings.some((m) => m.status === "active")) via.push("upnp");
    if ((view.playit?.java.length ?? 0) > 0 || (view.playit?.bedrock.length ?? 0) > 0)
      via.push("playit");
    if (view.ngrok?.address) via.push("ngrok");
    if ((view.cloudflare?.mine.length ?? 0) > 0) via.push("cloudflare");
    if (view.tailscale?.funnelAddress) via.push("funnel");
    const tested = Object.values(view.checks).some(
      (c) => c?.reachable && Date.now() - Date.parse(c.checkedAt) < CHECK_RELEVANT_MS,
    );
    if (tested) via.push("tested");
    return { internet: via.length > 0, via };
  }

  // --- reachability ------------------------------------------------------------------------

  /**
   * Check that players can connect. A stopped server gets a temporary
   * listener on its port that answers with a one-off code, so the test
   * proves the path to this machine even without the server running.
   */
  async test(serverId: string, via: "public" | "playit"): Promise<ReachabilityResult> {
    const row = await this.servers.row(serverId);
    const agent = this.servers.agentOf(row);
    const status = this.bus.snapshot(serverId).status as ServerStatus;
    if (status === "starting" || status === "stopping" || status === "installing") {
      throw new ServerError("BAD_STATE", `Wait until the server has finished ${status}.`);
    }
    const token = `cubehold connection test ${randomBytes(4).toString("hex")}`;
    const probe = await agent.probe({ port: row.port, text: token, ttlMs: 100_000 });
    const answeredBy = probe.listening ? "test" : status === "sleeping" ? "sleeper" : "server";
    if (!probe.listening && probe.reason === "busy") {
      throw new ServerError(
        "BAD_STATE",
        `Another program is using port ${row.port} on ${row.hostId === LOCAL_HOST_ID ? "this computer" : "the host"}; stop it or change the server's port.`,
      );
    }
    const started = Date.now();
    let result: ReachabilityResult;
    try {
      result =
        via === "playit"
          ? await this.#testPlayit(row, token, probe.listening, answeredBy)
          : await this.#testPublic(row, agent, token, probe.listening, answeredBy, started);
    } finally {
      // Free the port right away so a start is not blocked by the test.
      if (probe.listening)
        await agent.probe({ port: row.port, text: token, ttlMs: 0 }).catch(() => {});
    }
    this.#results.set(`${serverId}:${via}`, result);
    return result;
  }

  async #testPlayit(
    row: ServerRow,
    token: string,
    probing: boolean,
    answeredBy: ReachabilityResult["answeredBy"],
  ): Promise<ReachabilityResult> {
    const info = await this.servers
      .agentOf(row)
      .networkInfo(false)
      .catch(() => null);
    const { java } = await this.playit.tunnelsFor(
      row.port,
      null,
      (info?.lan ?? []).map((a) => a.address),
    );
    const tunnel = java.find((t) => !t.disabledReason) ?? java[0];
    if (!tunnel) {
      throw new ServerError("BAD_STATE", "No playit.gg tunnel leads to this server yet.");
    }
    const base = { via: "playit" as const, address: tunnel.address, checkedAt: nowIso() };
    try {
      const s = await pingJava(tunnel.address, { timeoutMs: 10_000 });
      const ours = !probing || s.motd.includes(token);
      return {
        ...base,
        reachable: ours,
        latencyMs: s.latencyMs || null,
        answeredBy: ours ? answeredBy : null,
        detail: ours
          ? `Answered through playit.gg in ${s.latencyMs} ms.`
          : "Something answered at that address, but not this server.",
        hint: ours ? null : "Check that the tunnel's local port is this server's port.",
      };
    } catch (err) {
      const tunnelState = (await this.playit.status()).tunnel?.state;
      return {
        ...base,
        reachable: false,
        latencyMs: null,
        answeredBy: null,
        detail: `No answer through playit.gg: ${errMessage(err)}`,
        hint: tunnel.disabledReason
          ? `playit.gg disabled this tunnel: ${tunnel.disabledReason}`
          : tunnelState !== "connected"
            ? "The playit agent on this computer is not connected yet."
            : "The tunnel may still be starting on playit.gg's side; try again in a minute.",
      };
    }
  }

  async #testPublic(
    row: ServerRow,
    agent: AgentApi,
    token: string,
    probing: boolean,
    answeredBy: ReachabilityResult["answeredBy"],
    started: number,
  ): Promise<ReachabilityResult> {
    const info = await agent.networkInfo(true).catch(() => null);
    // A VPS is reached at the address it was added with (an IP or a host name).
    const host =
      row.hostId === LOCAL_HOST_ID
        ? null
        : await this.db.select().from(schema.hosts).where(eq(schema.hosts.id, row.hostId)).get();
    const ip = host?.publicIp ?? info?.publicIpv4;
    if (!ip) throw new ServerError("BAD_STATE", "Could not find this network's public address.");
    const address = joinAddress(ip, row.port);
    // mcstatus.io caches each address for a minute: wait out an answer from before this test.
    let check = await checkFromOutside(ip, row.port);
    while (check.retrievedAt < started - 2_000 && Date.now() - started < MAX_CHECK_WAIT_MS) {
      await new Promise((r) =>
        setTimeout(r, Math.max(1_000, check.expiresAt - Date.now() + 1_000)),
      );
      check = await checkFromOutside(ip, row.port);
    }
    const ours = check.online && (!probing || (check.motd ?? "").includes(token));
    const base = { via: "public" as const, address, checkedAt: nowIso(), latencyMs: null };
    if (ours) {
      return {
        ...base,
        reachable: true,
        answeredBy,
        detail: "mcstatus.io reached this server from the internet.",
        hint: null,
      };
    }
    return {
      ...base,
      reachable: false,
      answeredBy: null,
      detail: check.online
        ? "Something else answered at your public address."
        : "mcstatus.io could not connect from the internet.",
      hint: await this.#publicHint(row, info),
    };
  }

  /** The most likely reason the public address does not work, in order of likelihood. */
  async #publicHint(row: ServerRow, info: NetworkInfo | null): Promise<string> {
    if (row.hostId !== LOCAL_HOST_ID) {
      const hs = await this.hostSecurity(row).catch(() => null);
      if (hs && !hs.gameOpen) {
        return `The host's firewall (ufw) does not allow TCP ${row.port}. The panel opens game ports by itself; use Repair on the Hosts page if it could not.`;
      }
      return `Open TCP ${row.port} in your provider's firewall (called a security group, cloud firewall or security list, depending on the provider). The host itself allows it.`;
    }
    if (info?.vpn) {
      return "Internet traffic goes through a VPN, so your public address is the VPN's. Port forwarding needs the VPN off; playit.gg works either way.";
    }
    if (info?.wan === "cgnat") {
      return "Your internet provider shares one public address between customers (CGNAT), so port forwarding cannot work. Use playit.gg instead.";
    }
    if (info?.wan === "double-nat") {
      return "There are two routers between this computer and the internet. Forward the port on both, or use playit.gg.";
    }
    const fw = await this.firewall(row).catch(() => null);
    if (fw?.game && !fw.game.allowed) {
      return "Windows Firewall blocks Java. Use Fix below, or allow Java in Windows Security.";
    }
    const mapping = (
      await this.servers
        .agentOf(row)
        .portMappings()
        .catch(() => [])
    ).find((m) => m.key === `${row.id}:java`);
    if (!mapping) {
      return `The router does not forward port ${row.port} to this computer. Turn on automatic port forwarding, or forward TCP ${row.port} to ${info?.primary ?? "this computer"} in the router's settings.`;
    }
    if (mapping.status !== "active") return `Automatic port forwarding failed: ${mapping.error}`;
    return "The router forwards the port, but connections still do not arrive. Some providers block incoming connections; playit.gg avoids that.";
  }

  // --- Windows Firewall ------------------------------------------------------------------------

  async firewall(row: ServerRow): Promise<FirewallView | null> {
    // Windows Firewall of this computer; VPS hosts use ufw (see hostSecurity).
    if (row.hostId !== LOCAL_HOST_ID) return null;
    const java = await findJavaBinary(path.join(this.config.javaDir, String(row.javaVersion)));
    if (!java) return null;
    const snap = await this.#snapshot(this.servers.agentOf(row), java);
    if (!snap) {
      return {
        supported: false,
        program: java,
        network: null,
        game: null,
        bedrock: null,
        rcon: null,
        programWide: false,
        blocked: false,
      };
    }
    const bedrockPort = row.settings?.bedrockPort ?? null;
    const rconPort = row.settings?.rcon?.port ?? null;
    const same = (p: string | null) => !!p && p.toLowerCase() === java.toLowerCase();
    return {
      supported: true,
      program: java,
      network: snap.networks[0]
        ? { name: snap.networks[0].name, category: snap.networks[0].category }
        : null,
      game: evaluateInbound(snap, { program: java, protocol: "TCP", port: row.port }),
      bedrock: bedrockPort
        ? evaluateInbound(snap, { program: java, protocol: "UDP", port: bedrockPort })
        : null,
      rcon: rconPort
        ? evaluateInbound(snap, { program: java, protocol: "TCP", port: rconPort })
        : null,
      programWide: programWideRules(snap, java).length > 0,
      blocked: snap.rules.some((r) => r.action === "block" && same(r.program)),
    };
  }

  /**
   * Allow Java on the game ports only: remove this Java's block rules and
   * its every-port rules, then allow each server using it on its own ports.
   * Java runtimes are shared, so every server on the same Java gets rules.
   */
  async fixFirewall(serverId: string) {
    const row = await this.servers.row(serverId);
    const java = await findJavaBinary(path.join(this.config.javaDir, String(row.javaVersion)));
    if (!java)
      throw new ServerError(
        "BAD_STATE",
        "Java for this server is not installed yet; start it once first.",
      );
    const siblings = (
      await this.db.select().from(schema.servers).where(eq(schema.servers.hostId, row.hostId))
    ).filter((s) => s.javaVersion === row.javaVersion);
    const fixes: FirewallFix[] = [
      { kind: "remove-program-rules", program: java, which: "block" },
      { kind: "remove-program-rules", program: java, which: "all-ports" },
    ];
    for (const s of siblings) {
      fixes.push({
        kind: "allow-port",
        name: `cubehold ${s.name} (TCP ${s.port})`,
        program: java,
        protocol: "TCP",
        port: s.port,
      });
      if (s.settings?.bedrockPort) {
        fixes.push({
          kind: "allow-port",
          name: `cubehold ${s.name} Bedrock (UDP ${s.settings.bedrockPort})`,
          program: java,
          protocol: "UDP",
          port: s.settings.bedrockPort,
        });
      }
    }
    try {
      await this.servers.agentOf(row).fixFirewall(fixes);
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
    this.#firewall.clear();
    return this.firewall(row);
  }

  async #snapshot(agent: AgentApi, program: string): Promise<FirewallSnapshot | null> {
    const hit = this.#firewall.get(program);
    if (hit && Date.now() - hit.at < FIREWALL_TTL_MS) return hit.snap;
    const snap = await agent.firewall([program]);
    this.#firewall.set(program, { at: Date.now(), snap });
    return snap;
  }
}
