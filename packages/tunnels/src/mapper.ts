import {
  addPortMapping,
  deletePortMapping,
  discoverGateway,
  externalIp,
  type Gateway,
  getPortMapping,
  type PortMapping,
  type PortProtocol,
  UpnpError,
} from "./upnp.js";

export interface MappingRequest {
  /** Caller's id for this forward, e.g. "<serverId>:java". */
  key: string;
  protocol: PortProtocol;
  /** Same port outside and inside. */
  port: number;
  description: string;
}

export interface MappingState extends MappingRequest {
  status: "active" | "pending" | "failed";
  error: string | null;
  /** 0 = permanent (router refused timed leases). */
  leaseSeconds: number | null;
  externalIp: string | null;
  /** This machine's address the router forwards to. */
  internalClient: string | null;
  updatedAt: string | null;
}

/** The UPnP calls the mapper makes; tests swap in a fake router. */
export interface MapperDeps {
  discover(): Promise<Gateway | null>;
  add(
    gw: Gateway,
    m: Omit<PortMapping, "enabled" | "internalClient">,
  ): Promise<{ leaseSeconds: number }>;
  remove(gw: Gateway, protocol: PortProtocol, port: number): Promise<void>;
  get(gw: Gateway, protocol: PortProtocol, port: number): Promise<PortMapping | null>;
  externalIp(gw: Gateway): Promise<string>;
}

const realDeps: MapperDeps = {
  discover: () => discoverGateway(),
  add: addPortMapping,
  remove: deletePortMapping,
  get: getPortMapping,
  externalIp,
};

const GATEWAY_TTL_MS = 10 * 60_000;

/**
 * Keeps a set of port forwards on the router. Forwards use a lease (one
 * hour by default) renewed well before it runs out, so they lapse on their
 * own when this machine goes away instead of staying open forever.
 * Operations run one at a time; routers do not like concurrent SOAP calls.
 */
export class PortMapper {
  #wanted = new Map<string, MappingRequest>();
  #states = new Map<string, MappingState>();
  #gw: { value: Gateway | null; at: number } | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout;
  readonly #deps: MapperDeps;
  readonly #lease: number;

  constructor(
    opts: {
      leaseSeconds?: number;
      renewMs?: number;
      deps?: Partial<MapperDeps>;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.#deps = { ...realDeps, ...opts.deps };
    this.#lease = opts.leaseSeconds ?? 3600;
    this.#log = opts.log ?? (() => {});
    this.#timer = setInterval(() => void this.renew(), opts.renewMs ?? 20 * 60_000);
    this.#timer.unref();
  }

  readonly #log: (msg: string) => void;

  states(): MappingState[] {
    return [...this.#states.values()].map((s) => ({ ...s }));
  }

  /** Whether any forward is wanted (keeps its owner from idling out). */
  get active(): boolean {
    return this.#wanted.size > 0;
  }

  /** The router, cached for ten minutes; `refresh` searches again. */
  gateway(refresh = false): Promise<Gateway | null> {
    return this.#serial(() => this.#gateway(refresh));
  }

  /** Replace the wanted set: add new forwards, drop ones no longer listed. */
  set(requests: MappingRequest[]): Promise<MappingState[]> {
    return this.#serial(async () => {
      const next = new Map(
        requests.map((r) => [r.key, { ...r, description: clean(r.description) }]),
      );
      for (const [key, old] of this.#wanted) {
        const now = next.get(key);
        if (!now || now.port !== old.port || now.protocol !== old.protocol) {
          await this.#remove(old);
          this.#states.delete(key);
        }
      }
      this.#wanted = next;
      for (const r of next.values()) await this.#apply(r);
      return this.states();
    });
  }

  /** Re-add every forward: renews leases and repairs forwards a router reboot lost. */
  renew(): Promise<MappingState[]> {
    return this.#serial(async () => {
      for (const r of this.#wanted.values()) await this.#apply(r);
      return this.states();
    });
  }

  /** Remove every forward this mapper made (agent shutdown). */
  clear(): Promise<void> {
    return this.#serial(async () => {
      for (const r of this.#wanted.values()) await this.#remove(r);
      this.#wanted.clear();
      this.#states.clear();
    });
  }

  dispose(): void {
    clearInterval(this.#timer);
  }

  // --- internals ------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #gateway(refresh: boolean): Promise<Gateway | null> {
    if (!refresh && this.#gw && Date.now() - this.#gw.at < GATEWAY_TTL_MS) return this.#gw.value;
    const value = await this.#deps.discover().catch(() => null);
    this.#gw = { value, at: Date.now() };
    return value;
  }

  async #apply(r: MappingRequest, retried = false): Promise<void> {
    const prev = this.#states.get(r.key);
    const state: MappingState = {
      ...r,
      status: prev?.status === "active" ? "active" : "pending",
      error: null,
      leaseSeconds: prev?.leaseSeconds ?? null,
      externalIp: prev?.externalIp ?? null,
      internalClient: prev?.internalClient ?? null,
      updatedAt: prev?.updatedAt ?? null,
    };
    this.#states.set(r.key, state);
    const gw = await this.#gateway(retried);
    if (!gw) {
      Object.assign(state, {
        status: "failed",
        error: "No UPnP router found on this network. It may have UPnP turned off.",
      });
      return;
    }
    const mapping = {
      protocol: r.protocol,
      externalPort: r.port,
      internalPort: r.port,
      description: r.description,
      leaseSeconds: this.#lease,
    };
    try {
      let lease: { leaseSeconds: number };
      try {
        lease = await this.#deps.add(gw, mapping);
      } catch (err) {
        if (!(err instanceof UpnpError) || err.code !== 718) throw err;
        // Taken: fine if it already points here (an older lease of ours), else a real conflict.
        const existing = await this.#deps.get(gw, r.protocol, r.port);
        if (existing && existing.internalClient !== gw.localAddress) {
          throw new Error(
            `The router already forwards ${r.protocol} ${r.port} to ${existing.internalClient || "another device"}${existing.description ? ` ("${existing.description}")` : ""}.`,
          );
        }
        await this.#deps.remove(gw, r.protocol, r.port).catch(() => {});
        lease = await this.#deps.add(gw, mapping);
      }
      Object.assign(state, {
        status: "active",
        error: null,
        leaseSeconds: lease.leaseSeconds,
        externalIp: (await this.#deps.externalIp(gw).catch(() => "")) || null,
        internalClient: gw.localAddress,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      // The router may have changed address or rebooted: look for it again, once.
      if (!retried && !(err instanceof UpnpError)) return this.#apply(r, true);
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`port forward ${r.protocol} ${r.port} failed: ${message}`);
      Object.assign(state, { status: "failed", error: message });
    }
  }

  async #remove(r: MappingRequest): Promise<void> {
    const state = this.#states.get(r.key);
    if (state?.status !== "active") return;
    const gw = await this.#gateway(false);
    if (!gw) return;
    await this.#deps.remove(gw, r.protocol, r.port).catch((err) => {
      this.#log(
        `removing forward ${r.protocol} ${r.port} failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }
}

/** Router firmware often mangles non-ASCII descriptions; keep them short and plain. */
function clean(description: string): string {
  const ascii = description.replace(/[^\x20-\x7e]/g, "").trim();
  return (ascii || "cubehold").slice(0, 60);
}
