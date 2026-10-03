import { RemoteAgent } from "@cubehold/agent";
import { LocalForward, SshError, SshSession, type SshTarget } from "./ssh.js";

/** What the panel keeps secret for one SSH host (stored encrypted). */
export interface HostSecret {
  /** The panel's own key for this host, OpenSSH format. */
  privateKey: string;
  publicKey: string;
  /** Bearer token of the agent on the host. */
  agentToken: string;
  /** Only when the login needs a password for sudo. */
  sudoPassword: string | null;
}

export type LinkState = "connecting" | "online" | "offline" | "agent-down" | "locked" | "error";

export interface LinkStatus {
  state: LinkState;
  error: string | null;
  since: string;
  lastSeenAt: string | null;
}

export interface LinkOptions {
  hostId: string;
  name: string;
  target: SshTarget;
  /** Pinned host key; a different key is refused. */
  fingerprint: string;
  agentPort: number;
  /** The decrypted secret, or null while the credential store is locked. */
  secret: () => Promise<HostSecret | null>;
  log: (msg: string) => void;
}

const AGENT_GRACE_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Keeps one SSH host connected: logs in with the panel's key, forwards a
 * local port to the agent on the host's loopback, and reconnects with
 * backoff when the link drops. Login and host-key failures stop the retries
 * (retrying a refused login would trip fail2ban) until reconnect() is called.
 */
export class RemoteHostLink {
  readonly agent: RemoteAgent;
  #forward: LocalForward;
  #session: SshSession | null = null;
  #status: LinkStatus = {
    state: "connecting",
    error: null,
    since: new Date().toISOString(),
    lastSeenAt: null,
  };
  #listeners = new Set<(status: LinkStatus) => void>();
  #retry = 0;
  #timer: NodeJS.Timeout | null = null;
  #agentTimer: NodeJS.Timeout | null = null;
  #running = false;
  #stopped = false;

  constructor(private readonly opts: LinkOptions) {
    this.#forward = new LocalForward(() => this.#session, opts.agentPort);
    this.agent = new RemoteAgent(() => `ws://127.0.0.1:${this.#forward.port}`, "", {
      unavailable: () => this.#unavailableMessage(),
    });
    this.agent.onConnect((hello) => {
      this.#clearAgentTimer();
      this.#setStatus("online", null);
      this.opts.log(`agent connected (build ${hello.build}, pid ${hello.pid})`);
    });
    this.agent.onDisconnect(() => {
      if (this.#status.state === "online") {
        this.#status.lastSeenAt = new Date().toISOString();
        if (this.#session) {
          this.#setStatus(
            "agent-down",
            "The cubehold agent stopped answering. systemd restarts it if it crashed; otherwise use Repair.",
          );
        } else this.#setStatus("offline", "Lost the connection");
      }
    });
  }

  get status(): LinkStatus {
    return { ...this.#status };
  }

  get session(): SshSession | null {
    return this.#session;
  }

  get target(): SshTarget {
    return this.opts.target;
  }

  onStatus(listener: (status: LinkStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    // One local port for the link's lifetime; it carries the agent across SSH reconnects.
    await this.#forward.listen();
    void this.#connect();
  }

  /** Try again now: after a login problem was fixed, the vault unlocked, or the user asked. */
  reconnect(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#retry = 0;
    if (this.#session && !this.#session.closed) {
      this.agent.retryNow();
      return;
    }
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#clearAgentTimer();
    this.agent.close();
    this.#forward.close();
    this.#session?.close();
    this.#session = null;
  }

  async #connect(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      const secret = await this.opts.secret();
      if (!secret) {
        this.#setStatus("locked", "Log in again to unlock the connection to this host.");
        return;
      }
      if (this.#status.state !== "offline" && this.#status.state !== "agent-down") {
        this.#setStatus("connecting", null);
      }
      const session = await SshSession.connect(
        this.opts.target,
        { privateKey: secret.privateKey },
        { expectFingerprint: this.opts.fingerprint },
      );
      if (this.#stopped) {
        session.close();
        return;
      }
      this.#session = session;
      this.#retry = 0;
      session.onClose((err) => {
        if (this.#session !== session) return;
        this.#session = null;
        this.#forward.dropAll();
        if (this.#stopped) return;
        if (this.#status.state === "online") this.#status.lastSeenAt = new Date().toISOString();
        this.#setStatus("offline", err ? err.message : "The SSH connection closed");
        this.#schedule();
      });
      this.agent.setToken(secret.agentToken);
      this.agent.retryNow();
      this.#clearAgentTimer();
      this.#agentTimer = setTimeout(() => {
        if (!this.agent.connected && this.#session === session) {
          this.#setStatus(
            "agent-down",
            "SSH works, but the cubehold agent on the host does not answer. Repair reinstalls and restarts it.",
          );
        }
      }, AGENT_GRACE_MS);
      this.#agentTimer.unref();
    } catch (err) {
      const e = err instanceof SshError ? err : new SshError("network", String(err));
      if (e.code === "auth" || e.code === "hostkey") {
        this.#setStatus("error", e.message);
        return; // needs a person; see reconnect()
      }
      this.#setStatus("offline", e.message);
      this.#schedule();
    } finally {
      this.#running = false;
    }
  }

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** this.#retry++);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
    this.#timer.unref();
  }

  #clearAgentTimer(): void {
    if (this.#agentTimer) clearTimeout(this.#agentTimer);
    this.#agentTimer = null;
  }

  #setStatus(state: LinkState, error: string | null): void {
    const changed = state !== this.#status.state || error !== this.#status.error;
    if (!changed) return;
    this.#status = {
      state,
      error,
      since: state !== this.#status.state ? new Date().toISOString() : this.#status.since,
      lastSeenAt: state === "online" ? null : this.#status.lastSeenAt,
    };
    for (const l of this.#listeners) {
      try {
        l(this.status);
      } catch (err) {
        console.error("host status listener failed", err);
      }
    }
  }

  #unavailableMessage(): string {
    const { state, error } = this.#status;
    const name = this.opts.name;
    switch (state) {
      case "locked":
        return `${name} is locked: log in again to reconnect to it.`;
      case "agent-down":
        return `The cubehold agent on ${name} is not running. Open Hosts and use Repair.`;
      case "error":
        return `Cannot connect to ${name}: ${error}`;
      case "connecting":
        return `Still connecting to ${name}; try again in a moment.`;
      default:
        return `${name} is offline${error ? ` (${error})` : ""}.`;
    }
  }
}
