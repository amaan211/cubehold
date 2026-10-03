import type { TailscaleStatus } from "@cubehold/agent";
import { errMessage, ServerError, type ServerRow, type ServerService } from "../servers/service.js";

const FUNNEL_PORTS = [10000, 8443, 443];

/**
 * Tailscale for a server: friends in your tailnet (or with the machine
 * shared to them) join at its Tailscale name; Funnel can also share it
 * publicly on port 443, 8443 or 10000, so players need nothing installed.
 */
export class TailscaleService {
  #cache = new Map<string, { at: number; status: TailscaleStatus }>();

  constructor(private readonly servers: ServerService) {}

  async status(row: ServerRow, fresh = false): Promise<TailscaleStatus> {
    const hit = this.#cache.get(row.hostId);
    if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.status;
    const status = await this.servers
      .agentOf(row)
      .tailscaleStatus()
      .catch(
        (err): TailscaleStatus => ({
          installed: false,
          state: null,
          authUrl: null,
          ips: [],
          dnsName: null,
          tailnet: null,
          funnel: [],
          error: errMessage(err),
        }),
      );
    this.#cache.set(row.hostId, { at: Date.now(), status });
    return status;
  }

  /** What this server looks like through Tailscale. */
  async forServer(serverId: string) {
    const row = await this.servers.row(serverId);
    const s = await this.status(row);
    const funnel = s.funnel.find((f) => targetPort(f.target) === row.port) ?? null;
    const ip = s.ips.find((a) => a.includes(".")) ?? null;
    const join = (host: string, port: number) => (port === 25565 ? host : `${host}:${port}`);
    return {
      ...s,
      address:
        s.state === "Running"
          ? s.dnsName
            ? join(s.dnsName, row.port)
            : ip
              ? join(ip, row.port)
              : null
          : null,
      ipAddress: s.state === "Running" && ip ? join(ip, row.port) : null,
      funnelPort: funnel?.port ?? null,
      funnelAddress: funnel && s.dnsName ? `${s.dnsName}:${funnel.port}` : null,
      /** Funnel ports another server (or program) already uses. */
      funnelTaken: s.funnel.filter((f) => targetPort(f.target) !== row.port).map((f) => f.port),
      funnelPorts: FUNNEL_PORTS,
    };
  }

  async login(serverId: string) {
    const row = await this.servers.row(serverId);
    this.#cache.delete(row.hostId);
    return this.servers.agentOf(row).tailscaleLogin();
  }

  async install(serverId: string) {
    const row = await this.servers.row(serverId);
    this.#cache.delete(row.hostId);
    return this.servers.agentOf(row).tailscaleInstall();
  }

  /** Share this server publicly through Funnel on `publicPort`, or stop (null). */
  async setFunnel(serverId: string, publicPort: number | null) {
    const row = await this.servers.row(serverId);
    const agent = this.servers.agentOf(row);
    const s = await this.status(row, true);
    if (s.state !== "Running") throw new ServerError("BAD_STATE", "Sign in to Tailscale first");
    if (publicPort !== null && !FUNNEL_PORTS.includes(publicPort)) {
      throw new ServerError("VALIDATION", "Funnel only allows ports 443, 8443 and 10000");
    }
    const mine = s.funnel.filter((f) => targetPort(f.target) === row.port);
    const clash = s.funnel.find((f) => f.port === publicPort && targetPort(f.target) !== row.port);
    if (clash) {
      throw new ServerError(
        "CONFLICT",
        `Funnel port ${publicPort} already leads to ${clash.target}`,
      );
    }
    for (const f of mine) if (f.port !== publicPort) await agent.tailscaleFunnel(f.port, null);
    let result: { ok: boolean; enableUrl: string | null; output: string } = {
      ok: true,
      enableUrl: null,
      output: "",
    };
    if (publicPort !== null && !mine.some((f) => f.port === publicPort)) {
      result = await agent.tailscaleFunnel(publicPort, row.port);
    }
    this.#cache.delete(row.hostId);
    return { ...result, view: await this.forServer(serverId) };
  }
}

/** "localhost:25565" or "tcp://localhost:25565" -> 25565. */
function targetPort(target: string): number | null {
  const m = /:(\d+)\/?$/.exec(target);
  return m ? Number(m[1]) : null;
}
