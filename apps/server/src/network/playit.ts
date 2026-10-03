import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TunnelStatus } from "@cubehold/agent";
import { downloadFile } from "@cubehold/mc";
import { LOCAL_HOST_ID } from "@cubehold/shared";
import {
  agentRundata,
  claimExchange,
  claimSetup,
  claimUrl,
  createTunnel,
  describeCreateError,
  generateClaimCode,
  isInvalidSecret,
  isLoopback,
  latestPlayitRelease,
  PlayitError,
  type PlayitRunData,
  type PlayitTunnel,
  playitAssetName,
} from "@cubehold/tunnels";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.js";
import type { HostManager } from "../hosts/manager.js";
import { decryptJson, encryptJson, type KeyVault } from "../security/crypto.js";
import { errMessage, nowIso } from "../servers/service.js";

const CREDENTIAL_ID = "playit-local";
const SETTING_AGENT = "playit.agentId";
const SETTING_BINARY = "playit.binary";
const CLAIM_TIMEOUT_MS = 15 * 60_000;
const CLAIM_POLL_MS = 1_500;
const RUNDATA_TTL_MS = 10_000;
const UPDATE_CHECK_MS = 7 * 24 * 60 * 60_000;
const VERSION_TEXT = "cubehold 0.0.1";

interface StoredSecret {
  secret: string;
  agentId: string | null;
  linkedAt: string;
}

interface BinaryInfo {
  version: string;
  path: string;
  checkedAt: string;
}

export type ClaimState =
  | "waiting-visit"
  | "waiting-approval"
  | "linking"
  | "done"
  | "rejected"
  | "expired"
  | "failed";

export interface ClaimView {
  url: string;
  state: ClaimState;
  error: string | null;
  startedAt: string;
}

type ActiveClaim = ClaimView & { code: string; cancelled: boolean };

/**
 * playit.gg for this machine: link an agent to the owner's playit account
 * (same claim flow as `playit setup`), keep its secret in the encrypted
 * credential store, download the official daemon (SHA-256 checked against
 * GitHub's record), and have the local agent run it.
 *
 * The secret needs the unlocked vault, so after a reboot the tunnel comes
 * back when the owner logs in (or at boot with CUBEHOLD_MASTER_KEY). Panel
 * restarts do not matter: the agent keeps playit running.
 */
export class PlayitService {
  #claim: ActiveClaim | null = null;
  #rundata: { at: number; data: PlayitRunData | null; error: string | null } | null = null;
  #startError: string | null = null;
  #binaryJob: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly hosts: HostManager,
    private readonly vault: KeyVault,
    private readonly dataDir: string,
  ) {}

  get supported(): boolean {
    return playitAssetName(process.platform, process.arch) !== null;
  }

  async init(): Promise<void> {
    this.hosts.onAgentConnect((hostId) => {
      if (hostId === LOCAL_HOST_ID) void this.reconcile();
    });
    this.vault.onUnlock(() => void this.reconcile());
    await this.reconcile();
  }

  /** Make the agent run playit when linked; stop it when not. */
  async reconcile(): Promise<void> {
    const agent = this.hosts.agentFor(LOCAL_HOST_ID);
    const cred = await this.#credential();
    if (!cred) {
      await agent.setTunnel("playit", null).catch(() => {});
      return;
    }
    // Locked: leave whatever the agent runs alone; this runs again after login.
    if (!this.vault.isUnlocked()) return;
    try {
      const { secret } = this.#decrypt(cred.encrypted);
      const binary = await this.#ensureBinary();
      const status = await agent.setTunnel("playit", {
        binary,
        args: ["--secret", secret, "--socket-path", this.#socketPath()],
        pidFile: path.join(this.dataDir, "playit", "playitd.pid"),
        redact: [secret],
      });
      this.#startError = status.state === "error" ? status.error : null;
    } catch (err) {
      this.#startError = errMessage(err);
      console.warn(`[playit] could not start the tunnel: ${this.#startError}`);
    }
  }

  async status() {
    const cred = await this.#credential();
    const tunnel: TunnelStatus | null = await this.hosts
      .agentFor(LOCAL_HOST_ID)
      .tunnelStatus("playit")
      .catch(() => null);
    const locked = !!cred && !this.vault.isUnlocked();
    const run = cred && !locked ? await this.#rundataCached() : null;
    const claim = this.#claim
      ? {
          url: this.#claim.url,
          state: this.#claim.state,
          error: this.#claim.error,
          startedAt: this.#claim.startedAt,
        }
      : null;
    return {
      supported: this.supported,
      linked: !!cred,
      locked,
      agentId: run?.data?.agentId ?? (await this.#setting(SETTING_AGENT)),
      claim,
      tunnel,
      tunnels: run?.data?.tunnels ?? [],
      pending: run?.data?.pending ?? [],
      notices: run?.data?.notices ?? [],
      accountStatus: run?.data?.accountStatus ?? null,
      /** playit.gg refused to create tunnels for this agent; only the website works. */
      createRefused: this.#createRefused,
      error: run?.error ?? this.#startError,
    };
  }

  #createRefused = false;

  /**
   * Try to create the tunnel through playit.gg's API for this agent. playit
   * may only allow that on its website; then this says so and the Network
   * tab keeps showing the steps.
   */
  async createTunnel(t: {
    name: string;
    type: "minecraft-java" | "minecraft-bedrock";
    localPort: number;
  }): Promise<{ created: boolean; message: string }> {
    const cred = await this.#credential();
    if (!cred) throw new Error("Link playit.gg first");
    if (!this.vault.isUnlocked()) throw new Error("Log in again to unlock the credential store");
    const { secret } = this.#decrypt(cred.encrypted);
    const run = await this.#rundataCached();
    const agentId = run.data?.agentId ?? (await this.#setting(SETTING_AGENT));
    if (!agentId) throw new Error(run.error ?? "playit.gg did not say which agent this is yet");
    try {
      await createTunnel(secret, { agentId, localIp: "127.0.0.1", ...t });
      this.#rundata = null;
      return { created: true, message: "Tunnel created. Its address appears in a few seconds." };
    } catch (err) {
      const why = describeCreateError(err);
      if (why.websiteOnly) this.#createRefused = true;
      return { created: false, message: why.message };
    }
  }

  /** Tunnels of this agent that lead to a local port. */
  async tunnelsFor(
    port: number,
    bedrockPort: number | null,
    localAddresses: string[],
  ): Promise<{ java: PlayitTunnel[]; bedrock: PlayitTunnel[] }> {
    if (!(await this.#credential()) || !this.vault.isUnlocked()) return { java: [], bedrock: [] };
    const { data } = await this.#rundataCached();
    const local = (ip: string) => isLoopback(ip) || ip === "0.0.0.0" || localAddresses.includes(ip);
    const tunnels = (data?.tunnels ?? []).filter((t) => local(t.localIp));
    return {
      java: tunnels.filter((t) => t.localPort === port && t.portType !== "udp"),
      bedrock: bedrockPort
        ? tunnels.filter((t) => t.localPort === bedrockPort && t.portType !== "tcp")
        : [],
    };
  }

  /** Begin linking: returns the playit.gg page the owner opens to approve this agent. */
  async startClaim(): Promise<ClaimView> {
    if (!this.supported) {
      throw new Error(`playit.gg has no agent for ${process.platform}/${process.arch}`);
    }
    if (!this.vault.isUnlocked()) throw new Error("Log in again to unlock the credential store");
    if (
      this.#claim &&
      ["waiting-visit", "waiting-approval", "linking"].includes(this.#claim.state)
    ) {
      this.#claim.cancelled = true;
    }
    const code = generateClaimCode();
    const claim: ActiveClaim = {
      code,
      url: claimUrl(code),
      state: "waiting-visit",
      error: null,
      startedAt: nowIso(),
      cancelled: false,
    };
    this.#claim = claim;
    // Fetch the daemon while the owner is on playit.gg, so linking finishes at once.
    void this.#ensureBinary().catch(() => {});
    void this.#pollClaim(claim);
    return { url: claim.url, state: claim.state, error: null, startedAt: claim.startedAt };
  }

  cancelClaim(): void {
    if (this.#claim) this.#claim.cancelled = true;
    this.#claim = null;
  }

  /**
   * Forget the agent and stop playit here. The agent stays listed on the
   * playit.gg account until the owner deletes it there.
   */
  async unlink(): Promise<void> {
    this.cancelClaim();
    await this.hosts
      .agentFor(LOCAL_HOST_ID)
      .setTunnel("playit", null)
      .catch(() => {});
    await this.db.delete(schema.credentials).where(eq(schema.credentials.id, CREDENTIAL_ID));
    await this.db.delete(schema.settings).where(eq(schema.settings.key, SETTING_AGENT));
    this.#rundata = null;
    this.#startError = null;
  }

  // --- internals ------------------------------------------------------------------------

  async #pollClaim(claim: ActiveClaim): Promise<void> {
    const deadline = Date.now() + CLAIM_TIMEOUT_MS;
    while (!claim.cancelled && Date.now() < deadline) {
      try {
        const state = await claimSetup(claim.code, VERSION_TEXT);
        if (claim.cancelled) return;
        if (state === "WaitingForUserVisit") claim.state = "waiting-visit";
        else if (state === "WaitingForUser") claim.state = "waiting-approval";
        else if (state === "UserRejected") {
          claim.state = "rejected";
          return;
        } else {
          claim.state = "linking";
          const secret = await this.#exchange(claim);
          if (!secret) return;
          const data = await agentRundata(secret).catch(() => null);
          await this.#store({ secret, agentId: data?.agentId ?? null, linkedAt: nowIso() });
          this.#rundata = data ? { at: Date.now(), data, error: null } : null;
          await this.reconcile();
          claim.state = "done";
          return;
        }
        claim.error = null;
      } catch (err) {
        if (err instanceof PlayitError && err.kind === "fail") {
          claim.state = err.detail === "CodeExpired" ? "expired" : "failed";
          claim.error = err.message;
          return;
        }
        // Network trouble: keep trying until the deadline, but show it.
        claim.error = errMessage(err);
      }
      await sleep(CLAIM_POLL_MS);
    }
    if (!claim.cancelled && claim.state !== "done") claim.state = "expired";
  }

  async #exchange(claim: ActiveClaim): Promise<string | null> {
    for (let i = 0; i < 20 && !claim.cancelled; i++) {
      try {
        return await claimExchange(claim.code);
      } catch (err) {
        if (err instanceof PlayitError && err.detail === "NotAccepted") {
          await sleep(1_000);
          continue;
        }
        claim.state = "failed";
        claim.error = errMessage(err);
        return null;
      }
    }
    return null;
  }

  async #rundataCached(): Promise<{ data: PlayitRunData | null; error: string | null }> {
    if (this.#rundata && Date.now() - this.#rundata.at < RUNDATA_TTL_MS) return this.#rundata;
    const cred = await this.#credential();
    if (!cred) return { data: null, error: null };
    try {
      const { secret } = this.#decrypt(cred.encrypted);
      const data = await agentRundata(secret);
      this.#rundata = { at: Date.now(), data, error: null };
      if (data.agentId !== (await this.#setting(SETTING_AGENT))) {
        await this.#saveSetting(SETTING_AGENT, data.agentId);
      }
    } catch (err) {
      const error = isInvalidSecret(err)
        ? "playit.gg no longer accepts this agent (deleted on playit.gg?). Unlink and link again."
        : `Could not reach playit.gg: ${errMessage(err)}`;
      this.#rundata = { at: Date.now(), data: this.#rundata?.data ?? null, error };
    }
    return this.#rundata;
  }

  async #credential() {
    return this.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.id, CREDENTIAL_ID))
      .get();
  }

  #decrypt(encrypted: string): StoredSecret {
    return decryptJson<StoredSecret>(this.vault.key(), encrypted, `credential:${CREDENTIAL_ID}`);
  }

  async #store(value: StoredSecret): Promise<void> {
    const encrypted = encryptJson(this.vault.key(), value, `credential:${CREDENTIAL_ID}`);
    await this.db
      .insert(schema.credentials)
      .values({ id: CREDENTIAL_ID, provider: "playit", label: "playit.gg agent", encrypted })
      .onConflictDoUpdate({
        target: schema.credentials.id,
        set: { encrypted, updatedAt: nowIso() },
      });
    if (value.agentId) await this.#saveSetting(SETTING_AGENT, value.agentId);
  }

  async #setting(key: string): Promise<string | null> {
    const row = await this.db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get();
    return row?.value ?? null;
  }

  async #saveSetting(key: string, value: string): Promise<void> {
    await this.db
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: nowIso() } });
  }

  /** The daemon on disk: downloaded once, checked for a newer release weekly. */
  #ensureBinary(): Promise<string> {
    if (!this.#binaryJob) {
      this.#binaryJob = this.#installBinary().finally(() => {
        this.#binaryJob = null;
      });
    }
    return this.#binaryJob;
  }

  async #installBinary(): Promise<string> {
    const raw = await this.#setting(SETTING_BINARY);
    const current = raw ? (JSON.parse(raw) as BinaryInfo) : null;
    const fresh = current && Date.now() - Date.parse(current.checkedAt) < UPDATE_CHECK_MS;
    if (current && fs.existsSync(current.path) && fresh) return current.path;

    let release: Awaited<ReturnType<typeof latestPlayitRelease>>;
    try {
      release = await latestPlayitRelease();
    } catch (err) {
      // Offline: keep using what we have.
      if (current && fs.existsSync(current.path)) return current.path;
      throw new Error(`Could not download playit: ${errMessage(err)}`);
    }
    const dir = path.join(this.dataDir, "playit", release.version);
    const file = path.join(dir, release.asset.name);
    if (!fs.existsSync(file)) {
      if (!release.asset.sha256) throw new Error("GitHub gave no checksum for the playit download");
      await downloadFile(release.asset.url, file, { sha256: release.asset.sha256 });
      if (process.platform !== "win32") await fs.promises.chmod(file, 0o755);
      console.log(`[playit] downloaded playit ${release.version} (${release.asset.name})`);
    }
    await this.#saveSetting(
      SETTING_BINARY,
      JSON.stringify({ version: release.version, path: file, checkedAt: nowIso() }),
    );
    // Older versions are no longer needed once the new one is in place.
    for (const e of await fs.promises
      .readdir(path.join(this.dataDir, "playit"), { withFileTypes: true })
      .catch(() => [])) {
      if (e.isDirectory() && e.name !== release.version) {
        await fs.promises
          .rm(path.join(this.dataDir, "playit", e.name), { recursive: true, force: true })
          .catch(() => {});
      }
    }
    return file;
  }

  /** Our own IPC endpoint, so an installed playit service is never disturbed. */
  #socketPath(): string {
    const id = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 12);
    return process.platform === "win32"
      ? `\\\\.\\pipe\\cubehold-playitd-${id}`
      : path.join(this.dataDir, "playit", "playitd.sock");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
