import { randomBytes } from "node:crypto";
import type { HostInfo, RpcHello } from "@cubehold/agent";
import { USER_AGENT } from "@cubehold/mc";
import {
  type AddHostInput,
  type HostHardenAction,
  LOCAL_HOST_ID,
  type PendingServerInput,
  type SshLoginInput,
} from "@cubehold/shared";
import { eq } from "drizzle-orm";
import { newId } from "../auth/session.js";
import type { CloudView } from "../cloud/types.js";
import { type Db, schema } from "../db/index.js";
import { decryptJson, encryptJson, type KeyVault } from "../security/crypto.js";
import { errMessage, nowIso, ServerError, type ServerService } from "../servers/service.js";
import { agentBundle } from "./bundle.js";
import type { HostManager } from "./manager.js";
import {
  AGENT_DATA_DIR,
  AGENT_ENV_FILE,
  AGENT_HOME,
  AGENT_UNIT,
  agentPortScript,
  authorizeKeyScript,
  autoUpdatesScript,
  CANCEL_GUARD_SCRIPT,
  checkFacts,
  disablePasswordLoginScript,
  enableFirewallScript,
  envFile,
  FACTS_SCRIPT,
  type FirewallRule,
  fail2banScript,
  type HostFacts,
  type HostSecurity,
  keyComment,
  type NodeRelease,
  nodeArch,
  nodeScript,
  packagesScript,
  parseFacts,
  parseSecurity,
  parseUfwAdded,
  removeKeyScript,
  SECURITY_SCRIPT,
  startAgentScript,
  syncFirewallScript,
  UFW_TAG,
  uninstallScript,
  unitFile,
  userScript,
} from "./provision.js";
import { type HostSecret, type LinkStatus, RemoteHostLink } from "./remote-host.js";
import {
  checkPrivateKey,
  generateKeyPair,
  type RootAccess,
  type SshSession as Session,
  SshError,
  SshSession,
  type SshTarget,
} from "./ssh.js";

const { hosts: hostsTable, servers: serversTable, credentials } = schema;
type HostRow = typeof hostsTable.$inferSelect;

/** Bookkeeping kept on the host row (never secrets). */
export interface HostMeta {
  hostKey?: { type: string; fingerprint: string };
  dataDir?: string;
  agentPort?: number;
  root?: RootAccess;
  os?: string | null;
  arch?: string | null;
  memMb?: number | null;
  cpus?: number | null;
  /** The panel's key is in authorized_keys: setup can be retried without the user's login. */
  keyInstalled?: boolean;
  setupAt?: string | null;
  lastError?: string | null;
  warnings?: string[];
  options?: { firewall: boolean; fail2ban: boolean; autoUpdates: boolean; keysOnly?: boolean };
  /** A Minecraft server to create once setup has finished (New server → new cloud VM). */
  pendingServer?: PendingServerInput | null;
}

/** What the cloud service adds to hosts it created. */
export interface CloudHooks {
  /** The VM is up, so the SSH link should be too. */
  vmRunning(row: HostRow): boolean;
  view(row: HostRow): Promise<CloudView>;
}

export type JobKind = "setup" | "repair" | "update" | "remove" | "power";
export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobStep {
  id: string;
  label: string;
  state: StepState;
  detail: string | null;
}

export interface HostJobView {
  hostId: string;
  kind: JobKind;
  state: "running" | "done" | "failed";
  steps: JobStep[];
  lines: string[];
  error: string | null;
  warnings: string[];
  startedAt: string;
  finishedAt: string | null;
  /** The server this job created, if it made one. */
  serverId: string | null;
}

export class Job {
  readonly view: HostJobView;

  constructor(hostId: string, kind: JobKind, steps: Array<[string, string]>) {
    this.view = {
      hostId,
      kind,
      state: "running",
      steps: steps.map(([id, label]) => ({ id, label, state: "pending", detail: null })),
      lines: [],
      error: null,
      warnings: [],
      startedAt: nowIso(),
      finishedAt: null,
      serverId: null,
    };
  }

  #step(id: string): JobStep {
    const s = this.view.steps.find((x) => x.id === id);
    if (!s) throw new Error(`unknown step ${id}`);
    return s;
  }

  line(text: string): void {
    const clean = text.replace(/\r/g, "").trimEnd();
    if (!clean) return;
    this.view.lines.push(clean);
    if (this.view.lines.length > 400) this.view.lines.splice(0, this.view.lines.length - 400);
  }

  /** Run a step; a failure fails the job. */
  async run<T>(id: string, fn: () => Promise<T>, detail?: (r: T) => string | null): Promise<T> {
    const step = this.#step(id);
    step.state = "running";
    this.line(`== ${step.label}`);
    try {
      const r = await fn();
      step.state = "done";
      step.detail = detail ? detail(r) : null;
      return r;
    } catch (err) {
      step.state = "failed";
      step.detail = errMessage(err);
      throw err;
    }
  }

  /** Run a hardening step; a failure is a warning and the job goes on. */
  async soft(id: string, fn: () => Promise<string | null | undefined>): Promise<boolean> {
    const step = this.#step(id);
    step.state = "running";
    this.line(`== ${step.label}`);
    try {
      step.detail = (await fn()) ?? null;
      step.state = "done";
      return true;
    } catch (err) {
      step.state = "failed";
      step.detail = errMessage(err);
      this.view.warnings.push(`${step.label}: ${step.detail}`);
      this.line(`!! ${step.detail}`);
      return false;
    }
  }

  skip(id: string, detail: string | null = null): void {
    const step = this.#step(id);
    step.state = "skipped";
    step.detail = detail;
  }

  finish(error: unknown | null): void {
    this.view.state = error ? "failed" : "done";
    this.view.error = error ? errMessage(error) : null;
    this.view.finishedAt = nowIso();
    for (const s of this.view.steps) if (s.state === "pending") s.state = "skipped";
    if (error) this.line(`!! ${this.view.error}`);
  }
}

/** What pages say while a cloud VM is down: nothing on it can be read until it runs again. */
const VM_DOWN =
  "This server's cloud VM is turned off to save money. Start the server to bring it back; this works again once it runs.";

const SETUP_STEPS: Array<[string, string]> = [
  ["connect", "Connect over SSH"],
  ["check", "Check the system"],
  ["key", "Install the panel's SSH key"],
  ["packages", "Install system packages"],
  ["account", "Create the cubehold service account"],
  ["node", "Install Node.js"],
  ["agent", "Install and start the cubehold agent"],
  ["link", "Connect to the agent"],
  ["firewall", "Turn on the firewall"],
  ["fail2ban", "Block repeated failed logins (fail2ban)"],
  ["updates", "Turn on automatic security updates"],
];

const REPAIR_STEPS: Array<[string, string]> = [
  ["connect", "Connect over SSH"],
  ["node", "Install Node.js"],
  ["agent", "Install and start the cubehold agent"],
  ["link", "Connect to the agent"],
];

const INFO_TTL_MS = 5_000;
const SECURITY_TTL_MS = 60_000;

export interface CheckResult {
  hostKey: { type: string; fingerprint: string };
  facts: HostFacts;
  root: RootAccess;
  needsSudoPassword: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * SSH hosts: first-time setup of a VPS, keeping it connected, repairs and
 * agent updates, the host firewall for game ports, and removal.
 */
export class HostService {
  #jobs = new Map<string, Job>();
  #info = new Map<string, { at: number; info: HostInfo | null }>();
  #security = new Map<string, { at: number; value: HostSecurity }>();
  #hello = new Map<string, RpcHello>();
  #updatedTo = new Map<string, string>();
  #firewallTimers = new Map<string, NodeJS.Timeout>();
  #cloud: CloudHooks | null = null;

  constructor(
    private readonly db: Db,
    private readonly hosts: HostManager,
    private readonly servers: ServerService,
    private readonly vault: KeyVault,
  ) {}

  async init(): Promise<void> {
    this.vault.onUnlock(() => {
      for (const id of this.hosts.hostIds()) {
        const link = this.hosts.link(id);
        if (link?.status.state === "locked") link.reconnect();
      }
    });
    this.hosts.onHostStatus((hostId, status) => void this.#onStatus(hostId, status));
    this.hosts.onAgentConnect((hostId, hello) => void this.#onConnect(hostId, hello));
    const syncFor = (serverId: string) =>
      void this.servers
        .row(serverId)
        .then((r) => this.#scheduleFirewallSync(r.hostId))
        .catch(() => {});
    this.servers.events.on("changed", syncFor);
    this.servers.events.on("created", syncFor);
    this.servers.events.on("moved", (_serverId, fromHost, toHost) => {
      this.#scheduleFirewallSync(fromHost);
      this.#scheduleFirewallSync(toHost);
    });
    this.servers.events.on("removed", () => {
      for (const id of this.hosts.hostIds()) this.#scheduleFirewallSync(id);
    });

    const rows = (await this.db.select().from(hostsTable)).filter((r) => isRemote(r));
    for (const row of rows) {
      const meta = metaOf(row);
      // A cloud VM that is off or saved as a snapshot has nothing to connect to.
      if (row.kind === "cloud" && !this.#cloud?.vmRunning(row)) {
        this.hosts.setOffline(row.id, VM_DOWN);
        continue;
      }
      if (!meta.setupAt || !meta.hostKey || !meta.agentPort) {
        // Setup never finished; it shows as failed until retried or removed.
        await this.#setStatus(row.id, "error");
        continue;
      }
      await this.#attach(row).catch((err) =>
        console.warn(`[hosts] could not start the link to ${row.name}:`, errMessage(err)),
      );
    }
  }

  // --- views ---------------------------------------------------------------------------

  async list() {
    const rows = await this.db.select().from(hostsTable);
    const serverRows = await this.db
      .select({ id: serversTable.id, hostId: serversTable.hostId, status: serversTable.status })
      .from(serversTable);
    const bundle = await agentBundle().catch(() => null);
    const out = [];
    for (const row of rows.sort(
      (a, b) =>
        Number(b.id === LOCAL_HOST_ID) - Number(a.id === LOCAL_HOST_ID) ||
        a.createdAt.localeCompare(b.createdAt),
    )) {
      const meta = metaOf(row);
      const local = row.id === LOCAL_HOST_ID;
      const link = this.hosts.link(row.id);
      const status: LinkStatus | null = local ? null : (link?.status ?? null);
      const connected = this.hosts.isConnected(row.id);
      const info = connected ? await this.#hostInfo(row.id) : null;
      const hello = local ? this.hosts.local.hello : this.#hello.get(row.id);
      const onHost = serverRows.filter((s) => s.hostId === row.id);
      const job = this.#jobs.get(row.id)?.view ?? null;
      const cloud = row.kind === "cloud" && this.#cloud ? await this.#cloud.view(row) : null;
      const linkState =
        job?.state === "running" && job.kind === "setup"
          ? ("setting-up" as const)
          : cloud?.state
            ? cloud.state
            : !meta.setupAt
              ? ("setup-failed" as const)
              : (status?.state ?? "offline");
      out.push({
        id: row.id,
        name: row.name,
        kind: row.kind as "local" | "ssh" | "cloud",
        address: local ? null : row.publicIp,
        sshPort: row.sshPort,
        sshUser: row.sshUser,
        state: local ? ("online" as const) : linkState,
        error: local
          ? null
          : (cloud?.error ?? (!meta.setupAt ? (meta.lastError ?? null) : (status?.error ?? null))),
        cloud,
        since: status?.since ?? null,
        lastSeenAt: status?.lastSeenAt ?? null,
        os: info?.os ?? meta.os ?? null,
        arch: info?.arch ?? meta.arch ?? null,
        cpus: info?.cpus ?? meta.cpus ?? null,
        totalMemMb: info?.totalMemMb ?? meta.memMb ?? null,
        freeMemMb: info?.freeMemMb ?? null,
        diskTotalMb: info?.diskTotalMb ?? null,
        diskFreeMb: info?.diskFreeMb ?? null,
        loadAvg: info?.loadAvg ?? null,
        uptimeSec: info?.uptimeSec ?? null,
        dataDir: info?.dataDir ?? meta.dataDir ?? null,
        agent: hello
          ? {
              build: hello.build,
              node: hello.node ?? null,
              upToDate: local || !bundle || hello.build === bundle.build,
            }
          : null,
        hostKey: meta.hostKey?.fingerprint ?? null,
        root: meta.root ?? null,
        keyInstalled: meta.keyInstalled === true,
        servers: onHost.length,
        running: onHost.filter((s) => ["starting", "running", "stopping"].includes(s.status))
          .length,
        warnings: meta.warnings ?? [],
        job: job ? { kind: job.kind, state: job.state } : null,
        createdAt: row.createdAt,
      });
    }
    return out;
  }

  job(hostId: string): HostJobView | null {
    return this.#jobs.get(hostId)?.view ?? null;
  }

  // --- adding a host -------------------------------------------------------------------

  /** Log in once with the user's details and report what the panel would find and do. */
  async check(input: SshLoginInput): Promise<CheckResult> {
    const session = await this.#login(input, null);
    try {
      const facts = parseFacts((await session.exec(FACTS_SCRIPT, { timeoutMs: 30_000 })).stdout);
      let root: RootAccess;
      try {
        root = await session.detectRoot(input.sudoPassword);
      } catch (err) {
        root = "none";
        if (err instanceof SshError && err.code === "sudo") {
          return {
            hostKey: session.hostKey,
            facts,
            root: "sudo-password",
            needsSudoPassword: true,
            problems: [err.message],
            warnings: [],
          };
        }
        throw err;
      }
      const { problems, warnings } = checkFacts(facts);
      const needsSudoPassword = root === "sudo-password" && !input.sudoPassword;
      if (root === "none") {
        problems.push(
          `${input.username} cannot become root. Log in as root, or as a user that may use sudo.`,
        );
      } else if (needsSudoPassword) {
        problems.push(`sudo asks for ${input.username}'s password: enter it below.`);
      }
      return { hostKey: session.hostKey, facts, root, needsSudoPassword, problems, warnings };
    } finally {
      session.close();
    }
  }

  /** Create the host and start setting it up in the background. */
  async add(input: AddHostInput): Promise<{ hostId: string }> {
    if (!this.vault.isUnlocked()) {
      throw new ServerError("BAD_STATE", "Log in again to unlock the credential store first.");
    }
    const duplicate = (await this.db.select().from(hostsTable)).find(
      (h) => h.publicIp === input.address && h.sshPort === input.port,
    );
    if (duplicate) {
      throw new ServerError(
        "CONFLICT",
        `${input.address} is already added as "${duplicate.name}".`,
      );
    }
    if (input.auth.method === "key") checkKey(input.auth.privateKey, input.auth.passphrase);
    const id = newId();
    const pair = generateKeyPair(keyComment(id));
    const secret: HostSecret = {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      agentToken: randomBytes(32).toString("hex"),
      sudoPassword: input.sudoPassword || null,
    };
    await this.db.insert(hostsTable).values({
      id,
      name: input.name,
      kind: "ssh",
      publicIp: input.address,
      sshUser: input.username,
      sshPort: input.port,
      status: "provisioning",
      meta: {
        hostKey: { type: "", fingerprint: input.fingerprint },
        options: {
          firewall: input.firewall,
          fail2ban: input.fail2ban,
          autoUpdates: input.autoUpdates,
        },
      } satisfies HostMeta,
    });
    await this.#storeSecret(id, input.name, secret);
    void this.#setup(id, input).catch(() => {});
    return { hostId: id };
  }

  /** Run setup again, with the user's login when given (after a failure or a reinstall). */
  async retry(hostId: string, login?: SshLoginInput & { fingerprint: string }): Promise<void> {
    const row = await this.#row(hostId);
    if (this.#jobs.get(hostId)?.view.state === "running") {
      throw new ServerError("BAD_STATE", "Setup is already running for this host.");
    }
    const meta = metaOf(row);
    if (!login && !meta.keyInstalled) {
      throw new ServerError(
        "VALIDATION",
        "The panel's key is not on this host yet: enter the login details again.",
      );
    }
    if (login) {
      await this.#patch(hostId, {
        publicIp: login.address,
        sshUser: login.username,
        sshPort: login.port,
        meta: { ...meta, hostKey: { type: "", fingerprint: login.fingerprint } },
      });
      if (login.sudoPassword) {
        const secret = await this.#secret(hostId);
        if (secret)
          await this.#storeSecret(hostId, row.name, {
            ...secret,
            sudoPassword: login.sudoPassword,
          });
      }
    }
    this.hosts.detach(hostId);
    const opts = meta.options ?? { firewall: true, fail2ban: true, autoUpdates: true };
    void this.#setup(hostId, login ? { ...login, name: row.name, ...opts } : null).catch(() => {});
  }

  async #setup(
    hostId: string,
    input: AddHostInput | null,
    cloud?: { steps: Array<[string, string]>; prepare: (job: Job) => Promise<void> },
  ): Promise<void> {
    const first = metaOf(await this.#row(hostId));
    const keysOnly = first.options?.keysOnly === true;
    const extra: Array<[string, string]> = keysOnly
      ? [["keys", "Allow SSH logins with keys only"]]
      : [];
    if (first.pendingServer) extra.push(["server", "Create the Minecraft server"]);
    const job = new Job(hostId, "setup", [...(cloud?.steps ?? []), ...SETUP_STEPS, ...extra]);
    this.#jobs.set(hostId, job);
    await this.#setStatus(hostId, "provisioning");
    let session: Session | null = null;
    try {
      // Cloud hosts: create the VM and learn its address first.
      if (cloud) await cloud.prepare(job);
      const row = await this.#row(hostId);
      const meta = metaOf(row);
      const secret = await this.#requireSecret(hostId);
      const options = meta.options ?? { firewall: true, fail2ban: true, autoUpdates: true };

      session = await job.run(
        "connect",
        async () => {
          const s = input
            ? await this.#login(input, input.fingerprint)
            : await SshSession.connect(
                targetOf(row),
                { privateKey: secret.privateKey },
                { expectFingerprint: meta.hostKey?.fingerprint ?? null },
              );
          job.line(`Connected to ${s.target.host}:${s.target.port} as ${s.target.username}`);
          job.line(`Host key ${s.hostKey.type} ${s.hostKey.fingerprint}`);
          return s;
        },
        (s) => `${s.target.username}@${s.target.host}`,
      );
      const s = session;
      await this.#patchMeta(hostId, { hostKey: s.hostKey });

      const facts = await job.run(
        "check",
        async () => {
          const f = parseFacts((await s.exec(FACTS_SCRIPT, { timeoutMs: 30_000 })).stdout);
          const { problems, warnings } = checkFacts(f);
          job.view.warnings.push(...warnings);
          if (problems.length > 0) throw new Error(problems.join(" "));
          const root = await s.detectRoot(secret.sudoPassword);
          if (root === "none") {
            throw new Error(`${s.target.username} cannot become root (no sudo rights).`);
          }
          if (root === "sudo-password" && !secret.sudoPassword) {
            throw new Error(`sudo needs ${s.target.username}'s password; enter it and try again.`);
          }
          await this.#patchMeta(hostId, {
            root,
            os: f.os,
            arch: f.arch,
            memMb: f.memMb,
            cpus: f.cpus,
          });
          return f;
        },
        (f) => `${f.os ?? "Linux"}, ${f.arch}, ${f.memMb} MB, ${f.cpus} CPU`,
      );

      await job.run("key", async () => {
        const r = await s.exec(authorizeKeyScript(secret.publicKey));
        if (r.code !== 0) throw new Error(r.stderr.trim() || "could not write authorized_keys");
        // Prove the key works before relying on it.
        const check = await SshSession.connect(
          s.target,
          { privateKey: secret.privateKey },
          { expectFingerprint: s.hostKey.fingerprint },
        );
        check.close();
        await this.#patchMeta(hostId, { keyInstalled: true });
        return null;
      });

      await job.run("packages", async () => {
        await this.#root(s, packagesScript(options), job, 20 * 60_000);
        return null;
      });
      await job.run("account", async () => {
        await this.#root(s, userScript(), job);
        return null;
      });
      await this.#installAgent(hostId, s, facts.arch, secret, job);

      if (options.firewall) {
        await job.soft("firewall", () => this.#enableFirewall(hostId, s, facts, job));
      } else job.skip("firewall", "Turned off in setup");
      if (options.fail2ban) {
        await job.soft("fail2ban", async () => {
          await this.#root(s, fail2banScript(), job);
          return "Active";
        });
      } else job.skip("fail2ban", "Turned off in setup");
      if (options.autoUpdates) {
        await job.soft("updates", async () => {
          await this.#root(s, autoUpdatesScript(), job);
          return "Security updates install daily";
        });
      } else job.skip("updates", "Turned off in setup");
      if (keysOnly) {
        await job.soft("keys", async () => {
          await this.#root(s, disablePasswordLoginScript(), job);
          return "Password logins are off";
        });
      }

      await this.#patchMeta(hostId, {
        setupAt: nowIso(),
        lastError: null,
        warnings: job.view.warnings,
      });
      this.#security.delete(hostId);
      const pending = metaOf(await this.#row(hostId)).pendingServer;
      if (pending) {
        // Asked for once: a failure here leaves a working host to create the server on by hand.
        await this.#patchMeta(hostId, { pendingServer: null });
        const server = await job.run(
          "server",
          async () => {
            try {
              return await this.servers.create({ ...pending, hostId });
            } catch (err) {
              throw new Error(
                `The VM is ready, but the server could not be created: ${errMessage(err)} Create it from New server.`,
              );
            }
          },
          (sv) => `${sv.name} is installing`,
        );
        job.view.serverId = server.id;
      }
      job.finish(null);
    } catch (err) {
      job.finish(err);
      await this.#patchMeta(hostId, { lastError: errMessage(err) });
      const meta = metaOf(await this.#row(hostId).catch(() => null));
      if (!meta.setupAt) await this.#setStatus(hostId, "error");
      throw err;
    } finally {
      session?.close();
    }
  }

  /** Node.js, the agent bundle, its settings and service; then connect to it. */
  async #installAgent(
    hostId: string,
    s: Session,
    arch: string | null,
    secret: HostSecret,
    job: Job,
  ): Promise<void> {
    const release = await job.run(
      "node",
      async () => {
        const na = nodeArch(arch);
        if (!na) throw new Error(`Unsupported processor type ${arch}`);
        const r = await nodeRelease(na);
        await this.#root(s, nodeScript(r), job, 15 * 60_000);
        return r;
      },
      (r) => r.version,
    );
    const bundle = await agentBundle();
    const port = await job.run(
      "agent",
      async () => {
        const out = await this.#root(s, agentPortScript(), job);
        const p = Number(/port=(\d+)/.exec(out)?.[1]);
        if (!p) throw new Error("Could not pick a port for the agent");
        await s.writeFileAsRoot(`${AGENT_HOME}/agent/agent.mjs`, bundle.code, { mode: "644" });
        await s.writeFileAsRoot(
          AGENT_ENV_FILE,
          envFile({ token: secret.agentToken, port: p, build: bundle.build }),
          { mode: "600" },
        );
        await s.writeFileAsRoot(`/etc/systemd/system/${AGENT_UNIT}.service`, unitFile());
        await this.#root(s, startAgentScript(p), job);
        return p;
      },
      (p) => `Listening on 127.0.0.1:${p} (build ${bundle.build}, Node ${release.version})`,
    );
    await this.#patchMeta(hostId, { agentPort: port, dataDir: AGENT_DATA_DIR });

    await job.run("link", async () => {
      const row = await this.#row(hostId);
      const existing = this.hosts.link(hostId);
      if (existing && metaOf(row).agentPort === port) existing.reconnect();
      else await this.#attach(row);
      const link = this.hosts.link(hostId);
      if (!link) throw new Error("no link");
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !link.agent.connected) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!link.agent.connected) {
        throw new Error(link.status.error ?? "The agent did not answer through the SSH tunnel");
      }
      return null;
    });
  }

  async #enableFirewall(hostId: string, s: Session, facts: HostFacts, job: Job): Promise<string> {
    const sshPorts = [...new Set([...facts.sshPorts, s.target.port])];
    const out = await this.#root(
      s,
      enableFirewallScript(sshPorts, await this.#wantedRules(hostId)),
      job,
    );
    if (!out.includes("guard=1")) return `Already on; allowed SSH on ${sshPorts.join(", ")}`;
    // A new login must work with the firewall on, or the guard turns it off again.
    const secret = await this.#requireSecret(hostId);
    try {
      const probe = await SshSession.connect(
        s.target,
        { privateKey: secret.privateKey },
        { expectFingerprint: s.hostKey.fingerprint, readyTimeoutMs: 15_000 },
      );
      probe.close();
    } catch (err) {
      throw new Error(
        `A new SSH login failed with the firewall on (${errMessage(err)}); it turns itself off again within 3 minutes.`,
      );
    }
    await this.#root(s, CANCEL_GUARD_SCRIPT, job);
    this.#security.delete(hostId);
    return `On; SSH allowed on port ${sshPorts.join(", ")}`;
  }

  // --- keeping hosts up to date -----------------------------------------------------------

  async reconnect(hostId: string): Promise<void> {
    const row = await this.#row(hostId);
    const link = this.hosts.link(hostId);
    if (link) link.reconnect();
    else if (metaOf(row).setupAt) await this.#attach(row);
  }

  /** Reinstall Node.js and the agent and restart it. Refuses while servers run unless forced. */
  async repair(hostId: string, kind: "repair" | "update" = "repair", force = false): Promise<void> {
    const row = await this.#row(hostId);
    if (!isRemote(row)) throw new ServerError("BAD_STATE", "Only remote hosts can be repaired");
    if (this.#jobs.get(hostId)?.view.state === "running") {
      throw new ServerError("BAD_STATE", "Another job is running for this host.");
    }
    if (!force && this.hosts.isConnected(hostId)) {
      const running = await this.hosts
        .agentFor(hostId)
        .running()
        .catch(() => []);
      if (running.length > 0) {
        throw new ServerError(
          "BAD_STATE",
          `${running.length} server(s) are running on ${row.name}. Restarting the agent stops them; stop them first.`,
        );
      }
    }
    const job = new Job(hostId, kind, REPAIR_STEPS);
    this.#jobs.set(hostId, job);
    void (async () => {
      let s: Session | null = null;
      try {
        const meta = metaOf(row);
        const secret = await this.#requireSecret(hostId);
        s = await job.run("connect", async () => {
          const session = await SshSession.connect(
            targetOf(row),
            { privateKey: secret.privateKey },
            { expectFingerprint: meta.hostKey?.fingerprint ?? null },
          );
          session.useRoot(meta.root ?? "none", secret.sudoPassword);
          return session;
        });
        await this.#installAgent(hostId, s, meta.arch ?? null, secret, job);
        job.finish(null);
      } catch (err) {
        job.finish(err);
      } finally {
        s?.close();
      }
    })();
  }

  async rename(hostId: string, name: string): Promise<void> {
    await this.#row(hostId);
    await this.#patch(hostId, { name });
  }

  async remove(hostId: string, opts: { uninstall: boolean; deleteData: boolean }) {
    if (hostId === LOCAL_HOST_ID)
      throw new ServerError("BAD_STATE", "This computer cannot be removed");
    const row = await this.#row(hostId);
    if (row.kind === "cloud") {
      throw new ServerError("BAD_STATE", "Cloud hosts are deleted through their cloud account.");
    }
    const onHost = await this.db
      .select({ name: serversTable.name })
      .from(serversTable)
      .where(eq(serversTable.hostId, hostId));
    if (onHost.length > 0) {
      throw new ServerError(
        "BAD_STATE",
        `Move or delete the servers on ${row.name} first: ${onHost.map((s) => s.name).join(", ")}.`,
      );
    }
    if (this.#jobs.get(hostId)?.view.state === "running") {
      throw new ServerError("BAD_STATE", "Wait for the running job on this host to finish.");
    }
    let uninstalled = false;
    let uninstallError: string | null = null;
    const meta = metaOf(row);
    if (opts.uninstall && meta.keyInstalled) {
      let s: Session | null = null;
      try {
        const secret = await this.#requireSecret(hostId);
        s = await SshSession.connect(
          targetOf(row),
          { privateKey: secret.privateKey },
          { expectFingerprint: meta.hostKey?.fingerprint ?? null, readyTimeoutMs: 15_000 },
        );
        s.useRoot(meta.root ?? "none", secret.sudoPassword);
        if (meta.root && meta.root !== "none") {
          const r = await s.runAsRoot(uninstallScript({ deleteData: opts.deleteData }), {
            timeoutMs: 5 * 60_000,
          });
          if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        }
        await s.exec(removeKeyScript(hostId));
        uninstalled = true;
      } catch (err) {
        uninstallError = errMessage(err);
      } finally {
        s?.close();
      }
    }
    this.hosts.detach(hostId);
    await this.db.delete(credentials).where(eq(credentials.id, credentialId(hostId)));
    await this.db.delete(hostsTable).where(eq(hostsTable.id, hostId));
    this.#jobs.delete(hostId);
    this.#info.delete(hostId);
    this.#security.delete(hostId);
    return { uninstalled, uninstallError };
  }

  // --- for the cloud service -------------------------------------------------------------

  setCloud(hooks: CloudHooks): void {
    this.#cloud = hooks;
  }

  /** Make the panel's key pair and agent token for a new host; returns the public key. */
  async createSecret(hostId: string, label: string): Promise<string> {
    const pair = generateKeyPair(keyComment(hostId));
    await this.#storeSecret(hostId, label, {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      agentToken: randomBytes(32).toString("hex"),
      sudoPassword: null,
    });
    return pair.publicKey;
  }

  /** The panel's own key for a host, for logging in to a VM it just created. */
  async privateKey(hostId: string): Promise<string> {
    return (await this.#requireSecret(hostId)).privateKey;
  }

  async publicKey(hostId: string): Promise<string> {
    return (await this.#requireSecret(hostId)).publicKey;
  }

  /** Run setup after `prepare` has created the VM (cloud hosts). */
  startCloudSetup(
    hostId: string,
    steps: Array<[string, string]>,
    prepare: (job: Job) => Promise<void>,
  ): Promise<void> {
    this.hosts.detach(hostId);
    return this.#setup(hostId, null, { steps, prepare });
  }

  /** Connect again from scratch, e.g. after the VM came back with a new address. */
  async relink(hostId: string): Promise<void> {
    this.hosts.detach(hostId);
    this.#info.delete(hostId);
    const row = await this.#row(hostId);
    if (metaOf(row).setupAt) await this.#attach(row);
  }

  /** Stop connecting (the VM is being turned off). */
  pause(hostId: string): void {
    this.hosts.detach(hostId);
    this.hosts.setOffline(hostId, VM_DOWN);
    this.#info.delete(hostId);
  }

  /** Drop a host without touching the machine (its VM is gone). */
  async forget(hostId: string): Promise<void> {
    this.hosts.detach(hostId);
    await this.db.delete(credentials).where(eq(credentials.id, credentialId(hostId)));
    await this.db.delete(hostsTable).where(eq(hostsTable.id, hostId));
    this.#jobs.delete(hostId);
    this.#info.delete(hostId);
    this.#security.delete(hostId);
    this.#hello.delete(hostId);
  }

  /** Run a root script on a connected host (e.g. shut the system down cleanly). */
  async runAsRoot(hostId: string, script: string, timeoutMs = 60_000) {
    const s = await this.#adminSession(hostId);
    return s.runAsRoot(script, { timeoutMs });
  }

  /** The job shown on the host card; the cloud service reports power changes here. */
  track(hostId: string, kind: JobKind, steps: Array<[string, string]>): Job {
    const job = new Job(hostId, kind, steps);
    this.#jobs.set(hostId, job);
    return job;
  }

  busy(hostId: string): boolean {
    return this.#jobs.get(hostId)?.view.state === "running";
  }

  async patchMeta(hostId: string, meta: Partial<HostMeta>): Promise<void> {
    await this.#patchMeta(hostId, meta);
  }

  // --- security --------------------------------------------------------------------------

  async security(hostId: string, refresh = false): Promise<HostSecurity | null> {
    const hit = this.#security.get(hostId);
    if (hit && !refresh && Date.now() - hit.at < SECURITY_TTL_MS) return hit.value;
    const s = await this.#adminSession(hostId);
    const r = await s.runAsRoot(SECURITY_SCRIPT, { timeoutMs: 30_000 });
    const value = parseSecurity(r.stdout);
    this.#security.set(hostId, { at: Date.now(), value });
    return value;
  }

  /** Cached security state, without connecting; for views that must stay fast. */
  cachedSecurity(hostId: string): HostSecurity | null {
    return this.#security.get(hostId)?.value ?? null;
  }

  async harden(hostId: string, action: HostHardenAction): Promise<HostSecurity | null> {
    const row = await this.#row(hostId);
    const s = await this.#adminSession(hostId);
    const job = new Job(hostId, "repair", [[action, action]]);
    const script: Record<Exclude<HostHardenAction, "firewall">, () => string> = {
      fail2ban: fail2banScript,
      "auto-updates": autoUpdatesScript,
      "password-login-off": disablePasswordLoginScript,
    };
    if (action === "firewall") {
      const facts = parseFacts((await s.exec(FACTS_SCRIPT, { timeoutMs: 30_000 })).stdout);
      const install = await s.runAsRoot(
        "command -v ufw >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -q ufw",
        { timeoutMs: 10 * 60_000 },
      );
      if (install.code !== 0)
        throw new ServerError("BAD_STATE", `Could not install ufw: ${install.stderr.trim()}`);
      await this.#enableFirewall(hostId, s, facts, job).catch((err) => {
        throw new ServerError("BAD_STATE", errMessage(err));
      });
    } else {
      const r = await s.runAsRoot(script[action](), { timeoutMs: 10 * 60_000 });
      if (r.code !== 0) {
        throw new ServerError(
          "BAD_STATE",
          `${row.name}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`}`,
        );
      }
    }
    return this.security(hostId, true);
  }

  // --- game ports in the host firewall ------------------------------------------------------

  #scheduleFirewallSync(hostId: string): void {
    if (hostId === LOCAL_HOST_ID || !this.hosts.link(hostId)) return;
    const t = this.#firewallTimers.get(hostId);
    if (t) clearTimeout(t);
    this.#firewallTimers.set(
      hostId,
      setTimeout(() => {
        this.#firewallTimers.delete(hostId);
        void this.syncFirewall(hostId).catch((err) =>
          console.warn(`[hosts] firewall sync on ${hostId} failed:`, errMessage(err)),
        );
      }, 1_500),
    );
  }

  /** Open each server's game ports on the host (ufw), and close ports no server uses. */
  async syncFirewall(hostId: string): Promise<void> {
    const s = await this.#adminSession(hostId);
    const added = await s.runAsRoot("command -v ufw >/dev/null 2>&1 && ufw show added || true", {
      timeoutMs: 30_000,
    });
    if (!added.stdout.includes("ufw")) return; // ufw not installed: nothing to keep in sync
    const script = syncFirewallScript(parseUfwAdded(added.stdout), await this.#wantedRules(hostId));
    if (!script) return;
    const r = await s.runAsRoot(script, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    this.#security.delete(hostId);
  }

  async #wantedRules(hostId: string): Promise<FirewallRule[]> {
    const rows = await this.db.select().from(serversTable).where(eq(serversTable.hostId, hostId));
    const rules: FirewallRule[] = [];
    for (const r of rows) {
      if (r.meta?.deletingSince) continue;
      rules.push({ port: r.port, protocol: "tcp", comment: `${UFW_TAG} ${r.name}` });
      if (r.settings?.bedrockPort) {
        rules.push({
          port: r.settings.bedrockPort,
          protocol: "udp",
          comment: `${UFW_TAG} ${r.name} Bedrock`,
        });
      }
    }
    return rules;
  }

  // --- internals ------------------------------------------------------------------------

  async #attach(row: HostRow): Promise<void> {
    const meta = metaOf(row);
    if (!meta.hostKey || !meta.agentPort) throw new Error("setup is not finished");
    const link = new RemoteHostLink({
      hostId: row.id,
      name: row.name,
      target: targetOf(row),
      fingerprint: meta.hostKey.fingerprint,
      agentPort: meta.agentPort,
      secret: () => this.#secret(row.id),
      log: (m) => console.log(`[host ${row.name}] ${m}`),
    });
    await this.hosts.attach(row.id, link, meta.dataDir ?? AGENT_DATA_DIR);
  }

  async #onStatus(hostId: string, status: LinkStatus): Promise<void> {
    this.#info.delete(hostId);
    const map: Record<LinkStatus["state"], string> = {
      online: "online",
      connecting: "unknown",
      offline: "offline",
      "agent-down": "error",
      locked: "unknown",
      error: "error",
    };
    const row = await this.db.select().from(hostsTable).where(eq(hostsTable.id, hostId)).get();
    if (row && metaOf(row).setupAt) await this.#setStatus(hostId, map[status.state]);
    if (status.state === "online") {
      const link = this.hosts.link(hostId);
      link?.session?.useRoot(
        metaOf(row).root ?? "none",
        (await this.#secret(hostId))?.sudoPassword ?? null,
      );
      this.#scheduleFirewallSync(hostId);
    }
  }

  /** Keep remote agents on the panel's version: update idle ones right away. */
  async #onConnect(hostId: string, hello: RpcHello): Promise<void> {
    if (hostId === LOCAL_HOST_ID) return;
    this.#hello.set(hostId, hello);
    const bundle = await agentBundle().catch(() => null);
    if (!bundle) return;
    if (hello.build === bundle.build) {
      this.#updatedTo.delete(hostId);
      return;
    }
    // An update that did not take would otherwise repeat on every reconnect.
    if (this.#updatedTo.get(hostId) === bundle.build) return;
    if (this.#jobs.get(hostId)?.view.state === "running") return;
    if (hello.running.length > 0 || (hello.sleeping?.length ?? 0) > 0) return;
    this.#updatedTo.set(hostId, bundle.build);
    console.log(`[hosts] updating the agent on ${hostId} (${hello.build} -> ${bundle.build})`);
    await this.repair(hostId, "update").catch((err) =>
      console.warn(`[hosts] agent update on ${hostId} failed:`, errMessage(err)),
    );
  }

  async #hostInfo(hostId: string): Promise<HostInfo | null> {
    const hit = this.#info.get(hostId);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
    const info = await this.hosts
      .agentFor(hostId)
      .hostInfo()
      .catch(() => null);
    this.#info.set(hostId, { at: Date.now(), info });
    return info;
  }

  /** The live SSH session of a connected host, able to run root commands. */
  async #adminSession(hostId: string): Promise<Session> {
    const row = await this.#row(hostId);
    if (!isRemote(row)) throw new ServerError("BAD_STATE", "Not a remote host");
    const session = this.hosts.link(hostId)?.session;
    if (!session || session.closed) {
      throw new ServerError("BAD_STATE", `${row.name} is not connected.`);
    }
    const secret = await this.#requireSecret(hostId);
    session.useRoot(metaOf(row).root ?? "none", secret.sudoPassword);
    return session;
  }

  async #root(s: Session, script: string, job: Job, timeoutMs = 5 * 60_000): Promise<string> {
    const r = await s.runAsRoot(script, { timeoutMs, onLine: (l) => job.line(l) });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ");
      throw new Error(tail || `The command failed (exit ${r.code})`);
    }
    return r.stdout;
  }

  async #login(input: SshLoginInput, fingerprint: string | null): Promise<Session> {
    const auth =
      input.auth.method === "key"
        ? { privateKey: input.auth.privateKey, passphrase: input.auth.passphrase }
        : { password: input.auth.password };
    if (input.auth.method === "key") checkKey(input.auth.privateKey, input.auth.passphrase);
    try {
      return await SshSession.connect(
        { host: input.address, port: input.port, username: input.username },
        auth,
        { expectFingerprint: fingerprint },
      );
    } catch (err) {
      throw new ServerError("BAD_STATE", errMessage(err));
    }
  }

  async #row(hostId: string): Promise<HostRow> {
    const row = await this.db.select().from(hostsTable).where(eq(hostsTable.id, hostId)).get();
    if (!row) throw new ServerError("NOT_FOUND", "Host not found");
    return row;
  }

  async #patch(hostId: string, values: Partial<HostRow>): Promise<void> {
    await this.db
      .update(hostsTable)
      .set({ ...values, updatedAt: nowIso() })
      .where(eq(hostsTable.id, hostId));
  }

  async #patchMeta(hostId: string, meta: Partial<HostMeta>): Promise<void> {
    const row = await this.#row(hostId);
    await this.#patch(hostId, { meta: { ...metaOf(row), ...meta } });
  }

  async #setStatus(hostId: string, status: string): Promise<void> {
    await this.#patch(hostId, { status });
  }

  async #secret(hostId: string): Promise<HostSecret | null> {
    if (!this.vault.isUnlocked()) return null;
    const cred = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, credentialId(hostId)))
      .get();
    if (!cred) return null;
    return decryptJson<HostSecret>(this.vault.key(), cred.encrypted, `credential:${cred.id}`);
  }

  async #requireSecret(hostId: string): Promise<HostSecret> {
    if (!this.vault.isUnlocked()) {
      throw new ServerError("BAD_STATE", "Log in again to unlock the credential store.");
    }
    const secret = await this.#secret(hostId);
    if (!secret)
      throw new ServerError("BAD_STATE", "This host's keys are missing; remove and add it again.");
    return secret;
  }

  async #storeSecret(hostId: string, label: string, secret: HostSecret): Promise<void> {
    const id = credentialId(hostId);
    const encrypted = encryptJson(this.vault.key(), secret, `credential:${id}`);
    await this.db
      .insert(credentials)
      .values({ id, provider: "ssh-host", label, encrypted })
      .onConflictDoUpdate({ target: credentials.id, set: { encrypted, updatedAt: nowIso() } });
    await this.#patch(hostId, { credentialId: id });
  }
}

function isRemote(row: HostRow): boolean {
  return row.kind === "ssh" || row.kind === "cloud";
}

function credentialId(hostId: string): string {
  return `host-${hostId}`;
}

function metaOf(row: HostRow | null | undefined): HostMeta {
  return (row?.meta ?? {}) as HostMeta;
}

function targetOf(row: HostRow): SshTarget {
  return { host: row.publicIp ?? "", port: row.sshPort ?? 22, username: row.sshUser ?? "root" };
}

function checkKey(privateKey: string, passphrase?: string): void {
  try {
    checkPrivateKey(privateKey, passphrase);
  } catch (err) {
    throw new ServerError("VALIDATION", errMessage(err), { privateKey: errMessage(err) });
  }
}

/** The Node.js build matching the panel's own version, with its published SHA-256. */
async function nodeRelease(arch: "x64" | "arm64"): Promise<NodeRelease> {
  const version = `v${process.versions.node}`;
  const dir = `node-${version}-linux-${arch}`;
  const base = `https://nodejs.org/dist/${version}`;
  const res = await fetch(`${base}/SHASUMS256.txt`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`nodejs.org answered ${res.status} for ${version}`);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.trim().endsWith(`  ${dir}.tar.xz`));
  const sha256 = line?.trim().split(/\s+/)[0];
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`No checksum for ${dir}.tar.xz on nodejs.org`);
  }
  return { version, arch, url: `${base}/${dir}.tar.xz`, sha256, dir };
}
