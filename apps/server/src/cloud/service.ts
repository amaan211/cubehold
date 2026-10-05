import { EventEmitter } from "node:events";
import {
  BILLING,
  CloudError,
  type CloudProvider,
  type CloudRegion,
  type CloudResource,
  type CloudSize,
  type CloudVm,
  costOf,
  createProvider,
  hostTag,
  hourlyRate,
  type IdleMode,
  monthlyEstimate,
  PROVIDERS,
  type ProviderCredential,
  type ProviderDeps,
  type ProviderId,
  type ResourceKind,
  type VmStatus,
} from "@cubehold/providers";
import {
  type AddCloudAccountInput,
  CLOUD_IDLE_STOP_MINUTES,
  type CloudCleanupInput,
  type CreateCloudHostInput,
  heapLimits,
  type ServerAutomation,
  type ServerStatus,
} from "@cubehold/shared";
import { and, eq, like, sql } from "drizzle-orm";
import { newId } from "../auth/session.js";
import { type Db, schema } from "../db/index.js";
import type { CloudUsageSize } from "../db/schema.js";
import type { HostManager } from "../hosts/manager.js";
import { type HostMeta, type HostService, Job } from "../hosts/service.js";
import { SshError, SshSession } from "../hosts/ssh.js";
import type { RealtimeBus } from "../realtime/bus.js";
import { decryptJson, encryptJson, type KeyVault } from "../security/crypto.js";
import {
  ACTIVE,
  errMessage,
  nowIso,
  ServerError,
  type ServerRow,
  type ServerService,
} from "../servers/service.js";
import {
  bucketOf,
  type CostSummary,
  type LiveHost,
  previousMonth,
  splitByDay,
  summarizeCosts,
  type UsageRow,
} from "./costs.js";
import type { CloudHostState, CloudMeta, CloudView, PowerState, UsageMonth } from "./types.js";

const { hosts: hostsTable, servers: serversTable, credentials, cloudUsage } = schema;
type HostRow = typeof hostsTable.$inferSelect;

/** Something found in a cloud account, and which host in the panel it belongs to. */
export interface ScanItem extends CloudResource {
  hostId: string | null;
  hostName: string | null;
  /** Part of a host the panel still runs (its VM, firewall, key or current snapshot). */
  inUse: boolean;
}

export interface AccountScan {
  accountId: string;
  label: string;
  provider: ProviderId;
  providerLabel: string;
  currency: "EUR" | "USD";
  /** The account could not be read (token revoked, provider down…). */
  error: string | null;
  items: ScanItem[];
}

/** Cloud resources are deleted in this order: VMs hold firewalls and keys in use. */
const DELETE_ORDER: ResourceKind[] = [
  "vm",
  "volume",
  "snapshot",
  "ip",
  "firewall",
  "ssh-key",
  "tag",
];

interface StoredAccount {
  cred: ProviderCredential;
  account: string | null;
}

const CLOUD_STEPS: Array<[string, string]> = [
  ["cloud-key", "Register the panel's SSH key with the provider"],
  ["cloud-firewall", "Create the provider firewall"],
  ["cloud-create", "Create the VM"],
  ["cloud-boot", "Wait for the VM to boot"],
  ["cloud-ssh", "Wait for SSH"],
];

const CATALOG_TTL_MS = 60 * 60_000;
const MONITOR_MS = 60_000;
/** After the last server idles out, wait this long before powering the VM down. */
const IDLE_GRACE_MS = 2 * 60_000;
/** Keeps cloud-init from making new SSH host keys when a snapshot boots as a new VM. */
const KEEP_HOST_KEYS =
  "mkdir -p /etc/cloud/cloud.cfg.d && printf 'ssh_deletekeys: false\\n' > /etc/cloud/cloud.cfg.d/99-cubehold-keep-host-keys.cfg";

/**
 * Cloud accounts and the VMs made with them: creating a VM and handing it to
 * the SSH setup, starting, stopping, saving to a snapshot while nobody plays,
 * the provider firewall, and what it all costs.
 */
export class CloudService {
  /** A VM's power state changed (started, stopped, saved as a snapshot, missing). */
  readonly events = new EventEmitter<{ power: [hostId: string, power: PowerState] }>();
  #catalog = new Map<string, { at: number; data: unknown }>();
  #idle = new Map<string, NodeJS.Timeout>();
  #firewall = new Map<string, NodeJS.Timeout>();
  /** Servers to start once their host's VM is up. */
  #pendingStart = new Map<string, Set<string>>();
  #timer: NodeJS.Timeout | null = null;
  /** Pending cloud-state writes per host, chained so none is lost. */
  #writes = new Map<string, Promise<void>>();
  /** The last clean-up, for its progress view. */
  #cleanup: Job | null = null;
  /** Hosts a clean-up is deleting: nothing may start or reconnect them. */
  #deleting = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly hosts: HostManager,
    private readonly hostAdmin: HostService,
    private readonly servers: ServerService,
    private readonly vault: KeyVault,
    private readonly bus: RealtimeBus,
    private readonly deps: ProviderDeps = {},
  ) {}

  /** Wire into hosts and servers. Runs before HostService.init so off VMs are not dialled. */
  install(): void {
    this.hostAdmin.setCloud({
      vmRunning: (row) => cloudOf(row)?.power === "running",
      view: (row) => this.#view(row),
    });
    this.servers.setCloudHooks({
      gate: (row) => this.#gate(row),
      powersDown: async (row) => (await this.#hostRow(row.hostId))?.kind === "cloud",
      defaults: async (hostId) => {
        const host = await this.#hostRow(hostId);
        const c = host && cloudOf(host);
        return c ? savingAutomation(c.provider) : null;
      },
    });
  }

  init(): void {
    this.servers.events.on("idleStopped", (id) => void this.#onIdle(id));
    const sync = (serverId: string) =>
      void this.servers
        .row(serverId)
        .then((r) => this.#scheduleFirewall(r.hostId))
        .catch(() => {});
    this.servers.events.on("created", sync);
    this.servers.events.on("changed", sync);
    this.servers.events.on("moved", (_id, from, to) => {
      this.#scheduleFirewall(from);
      this.#scheduleFirewall(to);
    });
    this.servers.events.on("removed", () => {
      void this.#cloudRows().then((rows) => {
        for (const r of rows) this.#scheduleFirewall(r.id);
      });
    });
    this.#timer = setInterval(() => void this.#monitor(), MONITOR_MS);
    this.#timer.unref();
    void this.#seedLog()
      .catch((err) => console.warn("[cloud] could not start the usage log:", errMessage(err)))
      .finally(() => void this.#monitor());
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  // --- accounts ------------------------------------------------------------------------------

  providers() {
    return Object.values(PROVIDERS);
  }

  async accounts() {
    const rows = await this.db.select().from(credentials).where(like(credentials.id, "cloud-%"));
    const hosts = await this.#cloudRows();
    return rows.map((r) => {
      let account: string | null = null;
      if (this.vault.isUnlocked()) {
        try {
          account = decryptJson<StoredAccount>(
            this.vault.key(),
            r.encrypted,
            `credential:${r.id}`,
          ).account;
        } catch {
          account = null;
        }
      }
      return {
        id: r.id,
        provider: r.provider as ProviderId,
        providerLabel: PROVIDERS[r.provider as ProviderId]?.label ?? r.provider,
        label: r.label,
        account,
        hosts: hosts.filter((h) => cloudOf(h)?.accountId === r.id).length,
        createdAt: r.createdAt,
      };
    });
  }

  async addAccount(input: AddCloudAccountInput) {
    this.#requireVault();
    const cred: ProviderCredential =
      input.provider === "aws"
        ? {
            accessKeyId: input.accessKeyId,
            secretAccessKey: input.secretAccessKey,
            region: input.region || "us-east-1",
          }
        : { token: input.token?.replace(/^Bearer\s+/i, "").trim() };
    if (input.provider === "aws" && (!cred.accessKeyId || !cred.secretAccessKey)) {
      throw new ServerError("VALIDATION", "Enter the access key ID and the secret access key.");
    }
    if (input.provider !== "aws" && !cred.token) {
      throw new ServerError("VALIDATION", "Paste the API token.");
    }
    const provider = createProvider(input.provider, cred, this.deps);
    let account: string | null;
    try {
      account = (await provider.verify()).account;
    } catch (err) {
      throw new ServerError("VALIDATION", errMessage(err), { token: errMessage(err) });
    }
    const id = `cloud-${newId()}`;
    const stored: StoredAccount = { cred, account };
    await this.db.insert(credentials).values({
      id,
      provider: input.provider,
      label: input.label,
      encrypted: encryptJson(this.vault.key(), stored, `credential:${id}`),
    });
    return { id, account };
  }

  async removeAccount(accountId: string) {
    const used = (await this.#cloudRows()).filter((h) => cloudOf(h)?.accountId === accountId);
    if (used.length > 0) {
      throw new ServerError(
        "BAD_STATE",
        `Delete the hosts made with this account first: ${used.map((h) => h.name).join(", ")}.`,
      );
    }
    await this.db.delete(credentials).where(eq(credentials.id, accountId));
    return { ok: true };
  }

  // --- catalog ------------------------------------------------------------------------------

  async regions(accountId: string): Promise<CloudRegion[]> {
    return this.#cached(`${accountId}:regions`, async () =>
      (await this.#provider(accountId)).regions(),
    );
  }

  /** Sizes that can run Minecraft (2 GB and up), with what a month would cost. */
  async sizes(accountId: string, region: string) {
    const { provider: id } = await this.#accountRow(accountId);
    const sizes = await this.#cached<CloudSize[]>(`${accountId}:sizes:${region}`, async () =>
      (await (await this.#provider(accountId)).sizes(region)).filter(
        (s) => s.memoryMb >= 1900 && s.vcpus >= 1,
      ),
    );
    const idle: IdleMode = PROVIDERS[id].stopSavesMoney ? "stop" : "hibernate";
    return sizes.map((s) => ({
      ...s,
      estimate: {
        alwaysOn: monthlyEstimate(id, s, 24, "keep").total,
        /** Three hours of play a day, with the VM off (or saved) the rest of the time. */
        threeHoursADay: monthlyEstimate(id, s, 3, idle).total,
        idleMode: idle,
        /** Per hour while running, with the IPv4 address and a separately billed disk. */
        hourly: hourlyRate(id, s, "running"),
      },
    }));
  }

  // --- creating a host ------------------------------------------------------------------------

  async createHost(input: CreateCloudHostInput): Promise<{ hostId: string }> {
    this.#requireVault();
    const acct = await this.#accountRow(input.accountId);
    const provider = await this.#provider(input.accountId);
    const size = (await this.sizes(input.accountId, input.region)).find((s) => s.id === input.size);
    if (!size)
      throw new ServerError("VALIDATION", `${input.size} is not available in ${input.region}`);
    const { estimate: _e, ...plainSize } = size;
    if (input.server && input.server.memoryMb > heapLimits(size.memoryMb).maxMemMb) {
      throw new ServerError(
        "VALIDATION",
        `${size.label} has ${Math.round(size.memoryMb / 1024)} GB of memory, too little for a ${Math.round(input.server.memoryMb / 1024)} GB server. Pick a bigger size or less memory.`,
      );
    }
    const id = newId();
    const now = nowIso();
    const cloud: CloudMeta = {
      accountId: input.accountId,
      provider: acct.provider,
      region: input.region,
      size: plainSize,
      tag: hostTag(id),
      sshKeyId: null,
      firewallId: null,
      vmId: null,
      power: "creating",
      powerSince: now,
      snapshot: null,
      usage: freshUsage(now),
      lastMonth: null,
      lastError: null,
    };
    await this.db.insert(hostsTable).values({
      id,
      name: input.name,
      kind: "cloud",
      provider: acct.provider,
      providerRef: null,
      publicIp: null,
      sshUser: provider.loginUser,
      sshPort: 22,
      status: "provisioning",
      meta: {
        keyInstalled: true,
        options: {
          firewall: input.firewall,
          fail2ban: input.fail2ban,
          autoUpdates: input.autoUpdates,
          keysOnly: true,
        },
        pendingServer: input.server ?? null,
      } satisfies HostMeta,
      cloud,
    });
    const publicKey = await this.hostAdmin.createSecret(id, input.name);
    void this.hostAdmin
      .startCloudSetup(id, CLOUD_STEPS, (job) => this.#provision(id, job, provider, publicKey))
      .catch(async (err) => {
        const row = await this.#hostRow(id);
        const c = row && cloudOf(row);
        if (c && c.power === "creating")
          await this.#setCloud(id, {
            power: c.vmId ? "running" : "missing",
            lastError: errMessage(err),
          });
      });
    return { hostId: id };
  }

  async #provision(hostId: string, job: Job, p: CloudProvider, publicKey: string): Promise<void> {
    const row = await this.#requireRow(hostId);
    const c = cloudOf(row) as CloudMeta;
    const sshKeyId = await job.run(
      "cloud-key",
      () => p.ensureSshKey(c.tag, publicKey, c.region),
      (k) => (k === "inline" ? "Passed with the VM" : null),
    );
    await this.#setCloud(hostId, { sshKeyId });
    const firewallId = await job.run("cloud-firewall", async () => {
      const ports = await this.#ports(hostId);
      return c.firewallId ?? (await p.createFirewall(c.tag, c.region, c.tag, ports));
    });
    await this.#setCloud(hostId, { firewallId });
    const vm = await job.run(
      "cloud-create",
      () =>
        p.createVm({
          name: vmName(row.name, c.tag),
          region: c.region,
          size: c.size.id,
          arch: c.size.arch,
          image: { kind: "ubuntu" },
          sshKeyId,
          publicKey,
          firewallId,
          tag: c.tag,
        }),
      (v) => `${PROVIDERS[c.provider].label} VM ${v.id}`,
    );
    await this.#setCloud(hostId, { vmId: vm.id });
    await this.#patchRow(hostId, { providerRef: vm.id });
    const up = await job.run(
      "cloud-boot",
      () => this.#waitVm(p, vm.id, "running", 10 * 60_000),
      (v) => `${v.ipv4} (${c.region})`,
    );
    await this.#patchRow(hostId, { publicIp: up.ipv4 });
    await this.#setPower(hostId, "running");
    await job.run(
      "cloud-ssh",
      () => this.#waitSsh(hostId, up.ipv4 ?? "", p.loginUser, null, job),
      (fp) => fp,
    );
  }

  // --- power ------------------------------------------------------------------------------------

  async power(hostId: string, action: "start" | "stop" | "hibernate"): Promise<{ started: true }> {
    this.#requireVault();
    const row = await this.#requireRow(hostId);
    const c = cloudOf(row);
    if (!c) throw new ServerError("BAD_STATE", "Not a cloud host");
    if (this.hostAdmin.busy(hostId)) {
      throw new ServerError("BAD_STATE", "Wait for the current job on this host to finish.");
    }
    if (action === "start") {
      if (c.power === "running") throw new ServerError("BAD_STATE", "The VM is already running.");
      if (c.power !== "stopped" && c.power !== "hibernated") {
        throw new ServerError("BAD_STATE", `The VM is ${c.power}; it cannot be started now.`);
      }
      void this.#bringUp(hostId).catch(() => {});
    } else {
      if (c.power !== "running") throw new ServerError("BAD_STATE", "The VM is not running.");
      if (action === "hibernate" && !PROVIDERS[c.provider].snapshots) {
        throw new ServerError(
          "BAD_STATE",
          `${PROVIDERS[c.provider].label} VMs are stopped, not saved as snapshots.`,
        );
      }
      void this.#bringDown(hostId, action, null).catch(() => {});
    }
    return { started: true };
  }

  /** Start a stopped VM or restore a saved one, then start any server that asked for it. */
  async #bringUp(hostId: string): Promise<void> {
    const row = await this.#requireRow(hostId);
    const c = cloudOf(row) as CloudMeta;
    const restoring = c.power === "hibernated";
    const job = this.hostAdmin.track(
      hostId,
      "power",
      restoring
        ? [
            ["restore", "Create the VM from its snapshot"],
            ["boot", "Wait for the VM to boot"],
            ["ssh", "Wait for SSH"],
            ["agent", "Connect to the agent"],
            ["cleanup", "Delete the snapshot"],
          ]
        : [
            ["boot", "Start the VM"],
            ["ssh", "Wait for SSH"],
            ["agent", "Connect to the agent"],
          ],
    );
    const p = await this.#provider(c.accountId);
    try {
      let vmId = c.vmId;
      if (restoring) {
        const snap = c.snapshot;
        if (!snap?.imageId) throw new Error("The snapshot of this VM is missing");
        await this.#setPower(hostId, "restoring");
        const publicKey = await this.hostAdmin.publicKey(hostId);
        const vm = await job.run("restore", () =>
          p.createVm({
            name: vmName(row.name, c.tag),
            region: c.region,
            size: c.size.id,
            arch: c.size.arch,
            image: { kind: "snapshot", id: snap.imageId as string },
            sshKeyId: c.sshKeyId ?? "inline",
            publicKey,
            firewallId: c.firewallId ?? "",
            tag: c.tag,
          }),
        );
        vmId = vm.id;
        await this.#setCloud(hostId, { vmId });
        await this.#patchRow(hostId, { providerRef: vmId });
      } else {
        await this.#setPower(hostId, "starting");
        await job.run("boot", async () => {
          await p.startVm(vmId as string);
          return null;
        });
      }
      const up = await (restoring
        ? job.run("boot", () => this.#waitVm(p, vmId as string, "running", 10 * 60_000))
        : this.#waitVm(p, vmId as string, "running", 10 * 60_000));
      await this.#patchRow(hostId, { publicIp: up.ipv4 });
      await this.#setPower(hostId, "running");
      const fresh = await this.#requireRow(hostId);
      await job.run("ssh", () =>
        this.#waitSsh(
          hostId,
          up.ipv4 ?? "",
          fresh.sshUser ?? "root",
          metaOf(fresh).hostKey?.fingerprint ?? null,
          job,
        ),
      );
      await job.run("agent", async () => {
        await this.hostAdmin.relink(hostId);
        const deadline = Date.now() + 90_000;
        while (!this.hosts.isConnected(hostId) && Date.now() < deadline) await sleep(1_000);
        if (!this.hosts.isConnected(hostId))
          throw new Error("The agent did not answer after the VM started");
        return null;
      });
      if (restoring && c.snapshot) {
        await job.soft("cleanup", async () => {
          await p.deleteSnapshot(c.snapshot?.imageId ?? c.snapshot?.handle ?? "");
          await this.#setCloud(hostId, { snapshot: null });
          return "The snapshot is no longer billed";
        });
      }
      job.finish(null);
      await this.#setCloud(hostId, { lastError: null });
      for (const serverId of this.#pendingStart.get(hostId) ?? []) {
        void this.servers
          .start(serverId)
          .catch((err) =>
            this.bus.system(serverId, `Could not start after the VM came up: ${errMessage(err)}`),
          );
      }
    } catch (err) {
      job.finish(err);
      await this.#setCloud(hostId, { lastError: errMessage(err) });
      await this.#refreshPower(hostId).catch(() => {});
      for (const serverId of this.#pendingStart.get(hostId) ?? []) {
        this.bus.system(serverId, `The VM did not start: ${errMessage(err)}`);
      }
      throw err;
    } finally {
      this.#pendingStart.delete(hostId);
    }
  }

  /** Stop the servers, shut the system down, then stop the VM or save and delete it. */
  async #bringDown(hostId: string, mode: "stop" | "hibernate", why: string | null): Promise<void> {
    const row = await this.#requireRow(hostId);
    const c = cloudOf(row) as CloudMeta;
    const steps: Array<[string, string]> = [
      ["servers", "Stop the Minecraft servers"],
      ["shutdown", "Shut the VM down"],
    ];
    if (mode === "hibernate") {
      steps.push(["snapshot", "Save the disk as a snapshot"], ["delete", "Delete the VM"]);
    }
    const job = this.hostAdmin.track(hostId, "power", steps);
    if (why) job.line(why);
    const p = await this.#provider(c.accountId);
    const vmId = c.vmId as string;
    try {
      await job.run("servers", async () => {
        const rows = await this.db
          .select()
          .from(serversTable)
          .where(eq(serversTable.hostId, hostId));
        for (const s of rows) {
          if (
            ACTIVE.includes(s.status as ServerStatus) ||
            s.status === "sleeping" ||
            s.status === "crashed"
          ) {
            await this.servers.stop(s.id).catch(() => {});
          }
        }
        return rows.length ? `${rows.length} server(s) stopped` : null;
      });
      await this.#setPower(hostId, mode === "hibernate" ? "hibernating" : "stopping");
      await job.run("shutdown", async () => {
        // Keep SSH host keys when a snapshot boots as a new VM, then shut down cleanly.
        await this.hostAdmin
          .runAsRoot(hostId, `${KEEP_HOST_KEYS}; systemctl --no-block poweroff`, 20_000)
          .catch(() => {});
        this.hostAdmin.pause(hostId);
        try {
          await this.#waitVm(p, vmId, "stopped", 3 * 60_000);
        } catch {
          await p.stopVm(vmId);
          try {
            await this.#waitVm(p, vmId, "stopped", 3 * 60_000);
          } catch {
            await p.stopVm(vmId, { force: true });
            await this.#waitVm(p, vmId, "stopped", 3 * 60_000);
          }
        }
        return null;
      });
      if (mode === "stop") {
        await this.#setPower(hostId, "stopped");
        job.finish(null);
        return;
      }
      const name = `${c.tag}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
      const snap = await job.run(
        "snapshot",
        async () => {
          const handle = await p.snapshotVm(vmId, name);
          const deadline = Date.now() + 90 * 60_000;
          for (;;) {
            const st = await p.snapshotState(handle);
            if (st.status === "ready" && st.imageId) return { handle, ...st };
            if (st.status === "error")
              throw new Error("The provider could not create the snapshot");
            if (Date.now() > deadline)
              throw new Error("The snapshot is taking too long; the VM was left stopped");
            await sleep(10_000);
          }
        },
        (s) => (s.sizeGb ? `${s.sizeGb} GB` : null),
      );
      const previous = c.snapshot;
      await this.#setCloud(hostId, {
        snapshot: { handle: snap.handle, imageId: snap.imageId, sizeGb: snap.sizeGb, at: nowIso() },
      });
      // Only with the snapshot safely stored does the VM go.
      await job.run("delete", async () => {
        await p.deleteVm(vmId);
        await this.#waitGone(p, vmId, 5 * 60_000);
        return null;
      });
      await this.#setCloud(hostId, { vmId: null });
      await this.#setPower(hostId, "hibernated");
      if (previous?.imageId && previous.imageId !== snap.imageId) {
        await p.deleteSnapshot(previous.imageId).catch(() => {});
      }
      job.finish(null);
    } catch (err) {
      job.finish(err);
      await this.#setCloud(hostId, { lastError: errMessage(err) });
      await this.#refreshPower(hostId).catch(() => {});
      throw err;
    }
  }

  // --- idle servers and starting servers on an off VM ---------------------------------------------

  async #onIdle(serverId: string): Promise<void> {
    const server = await this.servers.row(serverId).catch(() => null);
    if (!server) return;
    const host = await this.#hostRow(server.hostId);
    const c = host && cloudOf(host);
    if (!host || !c || c.power !== "running" || this.#deleting.has(host.id)) return;
    // The server's own status is saved just after this event; the full check runs when the timer fires.
    const mode = server.settings?.automation?.vmIdle ?? "keep";
    if (mode === "keep") return;
    const t = this.#idle.get(host.id);
    if (t) clearTimeout(t);
    this.bus.system(
      serverId,
      mode === "hibernate"
        ? "Nobody is playing: the VM will be saved as a snapshot and deleted in 2 minutes, unless a server starts."
        : "Nobody is playing: the VM will be stopped in 2 minutes, unless a server starts.",
    );
    this.#idle.set(
      host.id,
      setTimeout(() => {
        this.#idle.delete(host.id);
        void (async () => {
          const again = await this.#hostRow(host.id);
          if (!again || cloudOf(again)?.power !== "running" || this.hostAdmin.busy(host.id)) return;
          const m = await this.#idleMode(again);
          if (!m) return;
          await this.#bringDown(
            host.id,
            m,
            "Nobody played on any server here, so the VM is going down to save money.",
          );
        })().catch((err) =>
          console.warn(`[cloud] idle power-down of ${host.id} failed:`, errMessage(err)),
        );
      }, IDLE_GRACE_MS),
    );
  }

  /** "stop"/"hibernate" when every server here is stopped and wants the VM down; null otherwise. */
  async #idleMode(host: HostRow): Promise<"stop" | "hibernate" | null> {
    const c = cloudOf(host);
    if (!c) return null;
    const rows = await this.db.select().from(serversTable).where(eq(serversTable.hostId, host.id));
    if (rows.length === 0) return null;
    if (rows.some((r) => r.status !== "stopped" && r.status !== "crashed")) return null;
    const modes = rows.map((r) => r.settings?.automation?.vmIdle ?? "keep");
    if (modes.includes("keep")) return null;
    const info = PROVIDERS[c.provider];
    if (modes.includes("stop") || !info.snapshots) return "stop";
    return "hibernate";
  }

  /** ServerService.start asks first: false means the VM is being started and the server follows. */
  async #gate(row: ServerRow): Promise<boolean> {
    const host = await this.#hostRow(row.hostId);
    const c = host && cloudOf(host);
    if (!host || !c) return true;
    if (this.#deleting.has(host.id)) {
      throw new ServerError("BAD_STATE", "This server's VM is being deleted.");
    }
    const pending = this.#idle.get(host.id);
    if (pending) {
      clearTimeout(pending);
      this.#idle.delete(host.id);
    }
    if (c.power === "running") return true;
    if (c.power === "stopping" || c.power === "hibernating") {
      throw new ServerError(
        "BAD_STATE",
        "The VM is being turned off; start the server once that has finished.",
      );
    }
    const waiting = this.#pendingStart.get(host.id) ?? new Set<string>();
    waiting.add(row.id);
    this.#pendingStart.set(host.id, waiting);
    if (c.power === "stopped" || c.power === "hibernated") {
      this.bus.system(
        row.id,
        c.power === "hibernated"
          ? "The VM was deleted and kept as a snapshot; making a new VM from it first (usually 2 to 5 minutes)."
          : "Starting the VM first (usually under a minute).",
      );
      void this.#bringUp(host.id).catch(() => {});
    } else {
      this.bus.system(row.id, "The VM is starting; the server starts right after.");
    }
    return false;
  }

  // --- deleting --------------------------------------------------------------------------------

  async removeHost(hostId: string) {
    this.#requireVault();
    const row = await this.#requireRow(hostId);
    const c = cloudOf(row);
    if (!c) throw new ServerError("BAD_STATE", "Not a cloud host");
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
    if (this.hostAdmin.busy(hostId))
      throw new ServerError("BAD_STATE", "Wait for the running job to finish.");
    const p = await this.#provider(c.accountId);
    this.hostAdmin.pause(hostId);
    const problems: string[] = [];
    if (c.vmId) {
      await p.deleteVm(c.vmId).catch((err) => problems.push(`VM: ${errMessage(err)}`));
      await this.#waitGone(p, c.vmId, 5 * 60_000).catch(() => {});
    }
    if (c.firewallId) {
      // AWS keeps a security group busy until the instance is fully gone.
      for (let i = 0; i < 6; i++) {
        try {
          await p.deleteFirewall(c.firewallId);
          break;
        } catch (err) {
          if (i === 5) problems.push(`firewall: ${errMessage(err)}`);
          await sleep(10_000);
        }
      }
    }
    if (c.sshKeyId && c.sshKeyId !== "inline") {
      await p.deleteSshKey(c.sshKeyId).catch((err) => problems.push(`SSH key: ${errMessage(err)}`));
    }
    if (c.snapshot?.imageId) {
      await p
        .deleteSnapshot(c.snapshot.imageId)
        .catch((err) => problems.push(`snapshot: ${errMessage(err)}`));
    }
    await this.hostAdmin.forget(hostId);
    return { deleted: true, problems };
  }

  // --- firewall -----------------------------------------------------------------------------------

  #scheduleFirewall(hostId: string): void {
    const t = this.#firewall.get(hostId);
    if (t) clearTimeout(t);
    this.#firewall.set(
      hostId,
      setTimeout(() => {
        this.#firewall.delete(hostId);
        void this.syncFirewall(hostId).catch((err) =>
          console.warn(`[cloud] provider firewall sync on ${hostId} failed:`, errMessage(err)),
        );
      }, 1_500),
    );
  }

  /** Open each server's game ports in the provider firewall and close the rest. */
  async syncFirewall(hostId: string): Promise<void> {
    const row = await this.#hostRow(hostId);
    const c = row && cloudOf(row);
    if (!c?.firewallId || !this.vault.isUnlocked()) return;
    const p = await this.#provider(c.accountId);
    await p.setFirewall(c.firewallId, await this.#ports(hostId));
  }

  async #ports(hostId: string) {
    const rows = await this.db.select().from(serversTable).where(eq(serversTable.hostId, hostId));
    return rows.flatMap((r) => [
      { protocol: "tcp" as const, port: r.port, note: `Minecraft ${r.name}` },
      ...(r.settings?.bedrockPort
        ? [{ protocol: "udp" as const, port: r.settings.bedrockPort, note: `Bedrock ${r.name}` }]
        : []),
    ]);
  }

  // --- keeping state honest --------------------------------------------------------------------------

  async #monitor(): Promise<void> {
    for (const row of await this.#cloudRows()) {
      await this.#tick(row.id).catch(() => {});
      if (this.hostAdmin.busy(row.id) || this.#deleting.has(row.id)) continue;
      const c = cloudOf(row);
      if (!c || !this.vault.isUnlocked()) continue;
      // A running VM whose link was never (re)made, e.g. SSH was slow after a restore.
      if (c.power === "running" && metaOf(row).setupAt && !this.hosts.link(row.id)) {
        await this.hostAdmin.relink(row.id).catch(() => {});
      }
      // Also states a job left behind when the panel restarted in the middle of it.
      const needsLook =
        (c.power === "running" && !this.hosts.isConnected(row.id)) ||
        [
          "stopped",
          "starting",
          "stopping",
          "hibernating",
          "restoring",
          "creating",
          "missing",
        ].includes(c.power);
      if (needsLook) await this.#refreshPower(row.id).catch(() => {});
    }
  }

  /** Ask the provider what the VM is doing (someone may have used its console). */
  async #refreshPower(hostId: string): Promise<void> {
    const row = await this.#requireRow(hostId);
    const c = cloudOf(row);
    if (!c) return;
    if (!c.vmId) {
      if (c.power !== "hibernated")
        await this.#setPower(hostId, c.snapshot ? "hibernated" : "missing");
      return;
    }
    const p = await this.#provider(c.accountId);
    const vm = await p.getVm(c.vmId);
    if (!vm) {
      // Keep the id: if this was a glitch the VM is found again on the next look,
      // and Delete still cleans up everything else.
      if (c.power !== "missing") {
        await this.#setCloud(hostId, {
          power: "missing",
          powerSince: nowIso(),
          lastError:
            "The provider says this VM does not exist (deleted in its console?). Delete the host here to clean up the rest.",
        });
        this.hostAdmin.pause(hostId);
      }
      return;
    }
    if (c.power === "missing") {
      await this.#setCloud(hostId, { lastError: null });
      await this.#setPower(hostId, vm.status === "running" ? "running" : "stopped");
      if (vm.status === "running") await this.hostAdmin.relink(hostId);
      return;
    }
    if (vm.status === "stopped" && c.power !== "stopped") {
      await this.#setPower(hostId, "stopped");
      this.hostAdmin.pause(hostId);
    } else if (vm.status === "running" && c.power !== "running") {
      // Keep the last known address if the provider has not assigned one yet.
      if (vm.ipv4) await this.#patchRow(hostId, { publicIp: vm.ipv4 });
      await this.#setPower(hostId, "running");
      await this.hostAdmin.relink(hostId);
    } else if (vm.status === "running" && vm.ipv4 && vm.ipv4 !== row.publicIp) {
      await this.#patchRow(hostId, { publicIp: vm.ipv4 });
      await this.hostAdmin.relink(hostId);
    }
  }

  /** Add the time since the last tick to this month's usage and to the usage log. */
  async #tick(hostId: string): Promise<void> {
    await this.#setCloud(hostId, {});
  }

  /** Add [lastAt, now) in the VM's current power state to the usage log, split by day. */
  async #log(row: HostRow, c: CloudMeta, now: Date): Promise<void> {
    const bucket = bucketOf(c.power);
    const from = new Date(c.usage.lastAt);
    if (!bucket || !(now.getTime() > from.getTime())) return;
    const size = usageSize(c);
    for (const { day, hours } of splitByDay(from, now)) {
      const add = { running: 0, stopped: 0, hibernated: 0, snapshotGbHours: 0 };
      add[bucket] = hours;
      if (bucket === "hibernated") add.snapshotGbHours = hours * (c.snapshot?.sizeGb ?? 0);
      await this.db
        .insert(cloudUsage)
        .values({
          hostId: row.id,
          day,
          hostName: row.name,
          accountId: c.accountId,
          provider: c.provider,
          region: c.region,
          size,
          ...add,
        })
        .onConflictDoUpdate({
          target: [cloudUsage.hostId, cloudUsage.day],
          set: {
            hostName: row.name,
            region: c.region,
            size,
            running: sql`${cloudUsage.running} + ${add.running}`,
            stopped: sql`${cloudUsage.stopped} + ${add.stopped}`,
            hibernated: sql`${cloudUsage.hibernated} + ${add.hibernated}`,
            snapshotGbHours: sql`${cloudUsage.snapshotGbHours} + ${add.snapshotGbHours}`,
            updatedAt: nowIso(),
          },
        });
    }
  }

  /** Hosts from before the usage log: start it with this month's hours so far. */
  async #seedLog(): Promise<void> {
    const month = nowIso().slice(0, 7);
    for (const row of await this.#cloudRows()) {
      const c = cloudOf(row);
      if (!c || c.usage.month !== month) continue;
      const u = c.usage;
      if (u.running + u.stopped + u.hibernated <= 0) continue;
      const logged = await this.db
        .select({ day: cloudUsage.day })
        .from(cloudUsage)
        .where(and(eq(cloudUsage.hostId, row.id), like(cloudUsage.day, `${month}-%`)))
        .get();
      if (logged) continue;
      await this.db.insert(cloudUsage).values({
        hostId: row.id,
        day: u.lastAt.slice(0, 10),
        hostName: row.name,
        accountId: c.accountId,
        provider: c.provider,
        region: c.region,
        size: usageSize(c),
        running: u.running,
        stopped: u.stopped,
        hibernated: u.hibernated,
        snapshotGbHours: u.hibernated * (c.snapshot?.sizeGb ?? 0),
      });
    }
  }

  // --- costs -------------------------------------------------------------------------------------

  /** What the cloud cost in a month (this one by default), day by day and VM by VM. */
  async costs(month = nowIso().slice(0, 7)): Promise<CostSummary> {
    const now = new Date();
    const prev = previousMonth(month);
    const [rows, prevRows, monthRows, hostRows, serverRows, accountRows] = await Promise.all([
      this.db
        .select()
        .from(cloudUsage)
        .where(like(cloudUsage.day, `${month}-%`)),
      this.db
        .select()
        .from(cloudUsage)
        .where(like(cloudUsage.day, `${prev}-%`)),
      this.db
        .selectDistinct({ month: sql<string>`substr(${cloudUsage.day}, 1, 7)` })
        .from(cloudUsage),
      this.#cloudRows(),
      this.db
        .select({ id: serversTable.id, name: serversTable.name, hostId: serversTable.hostId })
        .from(serversTable),
      this.db
        .select({ id: credentials.id, label: credentials.label })
        .from(credentials)
        .where(like(credentials.id, "cloud-%")),
    ]);
    const usage: UsageRow[] = rows.map((r) => ({ ...r }));
    const live: LiveHost[] = [];
    for (const row of hostRows) {
      const c = cloudOf(row);
      if (!c) continue;
      // The time since the last tick is not in the log yet.
      const bucket = bucketOf(c.power);
      if (bucket && month === now.toISOString().slice(0, 7)) {
        for (const { day, hours } of splitByDay(new Date(c.usage.lastAt), now)) {
          if (!day.startsWith(month)) continue;
          usage.push({
            hostId: row.id,
            day,
            hostName: row.name,
            accountId: c.accountId,
            provider: c.provider,
            region: c.region,
            size: usageSize(c),
            running: bucket === "running" ? hours : 0,
            stopped: bucket === "stopped" ? hours : 0,
            hibernated: bucket === "hibernated" ? hours : 0,
            snapshotGbHours: bucket === "hibernated" ? hours * (c.snapshot?.sizeGb ?? 0) : 0,
          });
        }
      }
      live.push({
        hostId: row.id,
        name: row.name,
        provider: c.provider,
        accountLabel: accountRows.find((a) => a.id === c.accountId)?.label ?? null,
        region: c.region,
        size: usageSize(c),
        power: c.power,
        snapshotGb: c.snapshot?.sizeGb ?? 0,
        servers: serverRows
          .filter((s) => s.hostId === row.id)
          .map((s) => ({ id: s.id, name: s.name })),
        lastMonth: c.lastMonth,
      });
    }
    // Rows for the same host and day (log + not yet logged) are added up.
    const merged = new Map<string, UsageRow>();
    for (const r of usage) {
      const k = `${r.hostId}/${r.day}`;
      const m = merged.get(k);
      merged.set(
        k,
        m
          ? {
              ...m,
              running: m.running + r.running,
              stopped: m.stopped + r.stopped,
              hibernated: m.hibernated + r.hibernated,
              snapshotGbHours: m.snapshotGbHours + r.snapshotGbHours,
            }
          : r,
      );
    }
    const months = [...new Set([now.toISOString().slice(0, 7), ...monthRows.map((m) => m.month)])]
      .sort()
      .reverse();
    return summarizeCosts(month, [...merged.values()], prevRows, live, months, now);
  }

  // --- what is in the accounts, and cleaning it up ---------------------------------------------

  /** Everything cubehold made in each connected account, and other things that cost money. */
  async scan(accountIds?: string[]): Promise<{ at: string; accounts: AccountScan[] }> {
    this.#requireVault();
    const accounts = (await this.accounts()).filter(
      (a) => !accountIds || accountIds.includes(a.id),
    );
    const hosts = await this.#cloudRows();
    const out = await Promise.all(
      accounts.map(async (a): Promise<AccountScan> => {
        const base = {
          accountId: a.id,
          label: a.label,
          provider: a.provider,
          providerLabel: a.providerLabel,
          currency: BILLING[a.provider].currency,
        };
        try {
          const items = await (await this.#provider(a.id)).inventory();
          const mine = hosts.filter((h) => cloudOf(h)?.accountId === a.id);
          return { ...base, error: null, items: items.map((r) => linkItem(r, mine)) };
        } catch (err) {
          return { ...base, error: errMessage(err), items: [] };
        }
      }),
    );
    return { at: nowIso(), accounts: out };
  }

  /** Delete one thing no host in the panel uses (a leftover, or something the user made). */
  async deleteResource(accountId: string, kind: ResourceKind, id: string) {
    this.#requireVault();
    await this.#accountRow(accountId);
    const hosts = (await this.#cloudRows()).filter((h) => cloudOf(h)?.accountId === accountId);
    const owner = hosts.find((h) => linkItem({ kind, id, tag: null } as CloudResource, [h]).inUse);
    if (owner) {
      throw new ServerError(
        "BAD_STATE",
        `This belongs to ${owner.name}. Delete that host instead, or use Clean up.`,
      );
    }
    const p = await this.#provider(accountId);
    await p.deleteResource({ kind, id });
    return { deleted: true };
  }

  cleanupStatus() {
    return this.#cleanup?.view ?? null;
  }

  /**
   * Delete everything cubehold made in the chosen accounts: its cloud hosts
   * with the servers on them, and anything it left behind. Runs in the
   * background; cleanupStatus() shows the progress.
   */
  async startCleanup(input: CloudCleanupInput): Promise<{ started: true }> {
    this.#requireVault();
    if (this.#cleanup?.view.state === "running") {
      throw new ServerError("BAD_STATE", "A clean-up is already running.");
    }
    for (const id of input.accountIds) await this.#accountRow(id);
    const hosts = (await this.#cloudRows()).filter((h) =>
      input.accountIds.includes(cloudOf(h)?.accountId ?? ""),
    );
    const busy = hosts.filter((h) => this.hostAdmin.busy(h.id));
    if (busy.length > 0) {
      throw new ServerError(
        "BAD_STATE",
        `Wait for ${busy.map((h) => h.name).join(", ")} to finish what it is doing, then clean up.`,
      );
    }
    const job = new Job("cloud-cleanup", "remove", [
      ["find", "Look at what is in the accounts"],
      ["vms", "Delete the VMs"],
      ["storage", "Delete snapshots and disks"],
      ["network", "Delete firewalls, SSH keys and tags"],
      ["panel", "Remove the cloud hosts and their servers from the panel"],
      ["others", "Delete the other things you picked"],
      ["check", "Check that nothing is left"],
      ["accounts", "Disconnect the accounts"],
    ]);
    this.#cleanup = job;
    for (const h of hosts) {
      this.#deleting.add(h.id);
      const t = this.#idle.get(h.id);
      if (t) clearTimeout(t);
      this.#idle.delete(h.id);
      this.#pendingStart.delete(h.id);
    }
    void this.#runCleanup(job, input, hosts)
      .then(
        (problems) => job.finish(problems.length ? new Error(problems.join(" ")) : null),
        (err) => job.finish(err),
      )
      .finally(() => {
        for (const h of hosts) this.#deleting.delete(h.id);
      });
    return { started: true };
  }

  async #runCleanup(job: Job, input: CloudCleanupInput, hosts: HostRow[]): Promise<string[]> {
    const problems: string[] = [];
    // Per account: what to delete, by kind.
    const plan = new Map<string, Map<ResourceKind, Map<string, string>>>();
    const want = (accountId: string, kind: ResourceKind, id: string | null, name: string) => {
      if (!id || id === "inline") return;
      const acct = plan.get(accountId) ?? new Map<ResourceKind, Map<string, string>>();
      plan.set(accountId, acct);
      const ids = acct.get(kind) ?? new Map<string, string>();
      acct.set(kind, ids);
      ids.set(id, name);
    };
    const failedHosts = new Set<string>();
    const hostOf = new Map<string, string>(); // "account/kind/id" -> host id
    for (const h of hosts) {
      const c = cloudOf(h) as CloudMeta;
      this.hostAdmin.pause(h.id);
      const own = (kind: ResourceKind, id: string | null) => {
        if (!id || id === "inline") return;
        want(c.accountId, kind, id, `${h.name}: ${kind}`);
        hostOf.set(`${c.accountId}/${kind}/${id}`, h.id);
      };
      own("vm", c.vmId);
      own("snapshot", c.snapshot?.imageId ?? null);
      own("firewall", c.firewallId);
      own("ssh-key", c.sshKeyId);
    }

    await job.soft("find", async () => {
      const scan = await this.scan(input.accountIds);
      let found = 0;
      for (const a of scan.accounts) {
        if (a.error) {
          problems.push(`${a.label}: ${a.error}`);
          job.line(`!! ${a.label}: ${a.error}`);
          continue;
        }
        for (const r of a.items.filter((x) => x.ours)) {
          found++;
          want(a.accountId, r.kind, r.id, `${r.name} (${r.kind})`);
          if (r.hostId) hostOf.set(`${a.accountId}/${r.kind}/${r.id}`, r.hostId);
        }
      }
      return `${found} thing(s) made by cubehold`;
    });

    const providers = new Map<string, CloudProvider>();
    const providerOf = async (accountId: string) => {
      let p = providers.get(accountId);
      if (!p) {
        p = await this.#provider(accountId);
        providers.set(accountId, p);
      }
      return p;
    };
    const run = async (
      kinds: ResourceKind[],
      after?: (p: CloudProvider, id: string) => Promise<void>,
    ) => {
      let done = 0;
      const tasks: Array<Promise<void>> = [];
      for (const [accountId, acct] of plan) {
        for (const kind of DELETE_ORDER.filter((k) => kinds.includes(k))) {
          for (const [id, name] of acct.get(kind) ?? []) {
            tasks.push(
              (async () => {
                const p = await providerOf(accountId);
                try {
                  await deleteWithRetry(p, kind, id);
                  if (after) await after(p, id);
                  done++;
                  job.line(`Deleted ${name}`);
                } catch (err) {
                  const host = hostOf.get(`${accountId}/${kind}/${id}`);
                  if (host) failedHosts.add(host);
                  problems.push(`Could not delete ${name}: ${errMessage(err)}`);
                  job.line(`!! ${name}: ${errMessage(err)}`);
                }
              })(),
            );
          }
          // Kinds go one after another (a VM holds its firewall); things of one kind together.
          await Promise.all(tasks.splice(0));
        }
      }
      return done;
    };

    await job.soft("vms", async () => {
      const n = await run(["vm"], async (p, id) => {
        const deadline = Date.now() + 5 * 60_000;
        while (await p.getVm(id)) {
          if (Date.now() > deadline) throw new Error("still being deleted after 5 minutes");
          await sleep(5_000);
        }
      });
      return n ? `${n} deleted` : "None";
    });
    await job.soft("storage", async () => {
      const n = await run(["volume", "snapshot"]);
      return n ? `${n} deleted` : "None";
    });
    await job.soft("network", async () => {
      const n = await run(["ip", "firewall", "ssh-key", "tag"]);
      return n ? `${n} deleted` : "None";
    });

    await job.soft("panel", async () => {
      const gone: string[] = [];
      let serverCount = 0;
      for (const h of hosts) {
        if (failedHosts.has(h.id)) {
          await this.#setCloud(h.id, {
            lastError: "The clean-up could not delete everything; see the clean-up log.",
          }).catch(() => {});
          continue;
        }
        const rows = await this.db
          .select({ id: serversTable.id })
          .from(serversTable)
          .where(eq(serversTable.hostId, h.id));
        for (const s of rows) await this.servers.forget(s.id);
        serverCount += rows.length;
        // Count up to now in the usage log before the host goes.
        await this.#setCloud(h.id, {}).catch(() => {});
        await this.hostAdmin.forget(h.id);
        gone.push(h.name);
      }
      if (failedHosts.size > 0) {
        job.line(`Kept in the panel because something failed: ${failedHosts.size} host(s)`);
      }
      return gone.length
        ? `${gone.join(", ")} removed, with ${serverCount} server(s)`
        : "No cloud hosts in the panel";
    });

    if (input.others.length === 0) job.skip("others", "None picked");
    else
      await job.soft("others", async () => {
        let n = 0;
        for (const o of input.others) {
          if (!input.accountIds.includes(o.accountId)) continue;
          try {
            await deleteWithRetry(await providerOf(o.accountId), o.kind, o.id);
            n++;
            job.line(`Deleted ${o.kind} ${o.id}`);
          } catch (err) {
            problems.push(`Could not delete ${o.kind} ${o.id}: ${errMessage(err)}`);
            job.line(`!! ${o.kind} ${o.id}: ${errMessage(err)}`);
          }
        }
        return `${n} of ${input.others.length} deleted`;
      });

    await job.soft("check", async () => {
      // Providers take a moment to forget deleted things.
      await sleep(3_000);
      const scan = await this.scan(input.accountIds);
      const left = scan.accounts.flatMap((a) =>
        a.items.filter((r) => r.ours && r.kind !== "tag").map((r) => `${r.name} (${a.label})`),
      );
      const others = scan.accounts.flatMap((a) =>
        a.items.filter((r) => !r.ours && (r.monthly ?? 1) > 0),
      );
      if (others.length > 0) {
        job.line(
          `Not made by cubehold and left alone: ${others.map((r) => `${r.name} (${r.kind})`).join(", ")}`,
        );
      }
      if (left.length > 0) throw new Error(`Still there: ${left.join(", ")}`);
      return others.length
        ? `Nothing of cubehold's is left; ${others.length} other thing(s) still cost money`
        : "Nothing is left";
    });

    if (!input.disconnect) job.skip("accounts", "Kept");
    else
      await job.soft("accounts", async () => {
        const kept: string[] = [];
        for (const id of input.accountIds) {
          await this.removeAccount(id).catch(() => kept.push(id));
        }
        return kept.length ? `${kept.length} kept: hosts still use them` : "Disconnected";
      });
    return problems;
  }

  // --- views ---------------------------------------------------------------------------------------

  async #view(row: HostRow): Promise<CloudView> {
    const c = cloudOf(row) as CloudMeta;
    const info = PROVIDERS[c.provider];
    const { usage } = advance(c, new Date());
    const cost = costOf(c.provider, c.size, { ...usage, snapshotGb: c.snapshot?.sizeGb ?? 0 });
    const acct = await this.db
      .select({ label: credentials.label })
      .from(credentials)
      .where(eq(credentials.id, c.accountId))
      .get();
    const stateMap: Partial<Record<PowerState, CloudHostState>> = {
      creating: "creating",
      starting: "vm-starting",
      stopping: "vm-stopping",
      stopped: "vm-stopped",
      hibernating: "hibernating",
      hibernated: "hibernated",
      restoring: "restoring",
      missing: "vm-missing",
    };
    return {
      state: c.power === "creating" && metaOf(row).setupAt ? null : (stateMap[c.power] ?? null),
      error: c.power === "running" ? null : c.lastError,
      provider: c.provider,
      providerLabel: info.label,
      accountLabel: acct?.label ?? null,
      region: c.region,
      size: {
        id: c.size.id,
        label: c.size.label,
        vcpus: c.size.vcpus,
        memoryMb: c.size.memoryMb,
        diskGb: c.size.diskGb,
        arch: c.size.arch,
        burstable: c.size.burstable,
        noMonthlyCap: c.size.noMonthlyCap || !(c.size.priceMonthly > 0),
      },
      price: {
        hourly: c.size.priceHourly,
        monthly: c.size.priceMonthly,
        currency: c.size.currency,
        estimate: c.size.priceSource === "estimate",
      },
      power: c.power,
      powerSince: c.powerSince,
      month: {
        ...cost,
        month: usage.month,
        hours: {
          running: Math.round(usage.running * 10) / 10,
          stopped: Math.round(usage.stopped * 10) / 10,
          hibernated: Math.round(usage.hibernated * 10) / 10,
        },
      },
      lastMonth: c.lastMonth,
      stopSavesMoney: info.stopSavesMoney,
      snapshots: info.snapshots,
      snapshotGb: c.snapshot?.sizeGb ?? null,
      snapshotPerGbMonth: BILLING[c.provider].snapshotPerGbMonth,
      idleModes: info.snapshots ? ["keep", "hibernate"] : ["keep", "stop"],
    };
  }

  // --- helpers ---------------------------------------------------------------------------------------

  async #waitVm(p: CloudProvider, id: string, want: VmStatus, timeoutMs: number): Promise<CloudVm> {
    const deadline = Date.now() + timeoutMs;
    let last: CloudVm | null = null;
    while (Date.now() < deadline) {
      last = await p.getVm(id);
      if (!last) throw new Error("The VM disappeared at the provider");
      if (last.status === want && (want !== "running" || last.ipv4)) return last;
      await sleep(want === "running" ? 3_000 : 5_000);
    }
    throw new Error(
      `The VM is still ${last?.status ?? "unknown"} after ${Math.round(timeoutMs / 60_000)} minutes`,
    );
  }

  async #waitGone(p: CloudProvider, id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await p.getVm(id))) return;
      await sleep(5_000);
    }
    throw new Error("The VM is still being deleted");
  }

  /**
   * Wait until SSH answers with the panel's key. A new VM's host key is
   * learned here (it did not exist before); a restored one should keep its old key.
   */
  async #waitSsh(
    hostId: string,
    address: string,
    user: string,
    expect: string | null,
    job: Job,
  ): Promise<string> {
    const privateKey = await this.hostAdmin.privateKey(hostId);
    const deadline = Date.now() + 6 * 60_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const s = await SshSession.connect(
          { host: address, port: 22, username: user },
          { privateKey },
          { expectFingerprint: expect, readyTimeoutMs: 15_000 },
        );
        const fp = s.hostKey;
        s.close();
        await this.hostAdmin.patchMeta(hostId, { hostKey: fp });
        return `${fp.type} ${fp.fingerprint}`;
      } catch (err) {
        if (err instanceof SshError && err.code === "hostkey" && expect) {
          job.line("The VM came back with a new SSH host key; trusting the new one.");
          expect = null;
          continue;
        }
        lastErr = errMessage(err);
        await sleep(5_000);
      }
    }
    throw new Error(`SSH did not come up on ${address}: ${lastErr}`);
  }

  async #provider(accountId: string): Promise<CloudProvider> {
    this.#requireVault();
    const row = await this.#accountRow(accountId);
    const stored = decryptJson<StoredAccount>(
      this.vault.key(),
      row.encrypted,
      `credential:${row.id}`,
    );
    return createProvider(row.provider, stored.cred, this.deps);
  }

  async #accountRow(accountId: string) {
    const row = await this.db.select().from(credentials).where(eq(credentials.id, accountId)).get();
    if (!row || !accountId.startsWith("cloud-"))
      throw new ServerError("NOT_FOUND", "Cloud account not found");
    return { ...row, provider: row.provider as ProviderId };
  }

  async #cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.#catalog.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data as T;
    try {
      const data = await fn();
      this.#catalog.set(key, { at: Date.now(), data });
      return data;
    } catch (err) {
      if (err instanceof CloudError) throw new ServerError("BAD_STATE", err.message);
      throw err;
    }
  }

  #requireVault(): void {
    if (!this.vault.isUnlocked()) {
      throw new ServerError("BAD_STATE", "Log in again to unlock the credential store first.");
    }
  }

  async #cloudRows(): Promise<HostRow[]> {
    return this.db.select().from(hostsTable).where(eq(hostsTable.kind, "cloud"));
  }

  async #hostRow(hostId: string): Promise<HostRow | null> {
    return (await this.db.select().from(hostsTable).where(eq(hostsTable.id, hostId)).get()) ?? null;
  }

  async #requireRow(hostId: string): Promise<HostRow> {
    const row = await this.#hostRow(hostId);
    if (!row) throw new ServerError("NOT_FOUND", "Host not found");
    return row;
  }

  async #patchRow(hostId: string, values: Partial<HostRow>): Promise<void> {
    await this.db
      .update(hostsTable)
      .set({ ...values, updatedAt: nowIso() })
      .where(eq(hostsTable.id, hostId));
  }

  /** Change the cloud state of a host; writes for one host run one at a time. */
  #setCloud(hostId: string, patch: Partial<CloudMeta>, tick = true): Promise<void> {
    const previous = this.#writes.get(hostId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const row = await this.#hostRow(hostId);
        if (!row?.cloud) return;
        let cloud = { ...row.cloud };
        if (tick) {
          const now = new Date();
          await this.#log(row, cloud, now).catch((err) =>
            console.warn(`[cloud] usage log for ${hostId}:`, errMessage(err)),
          );
          cloud = { ...cloud, ...advance(cloud, now) };
        }
        await this.db
          .update(hostsTable)
          .set({ cloud: { ...cloud, ...patch }, updatedAt: nowIso() })
          .where(eq(hostsTable.id, hostId));
        if (patch.power && patch.power !== row.cloud.power) {
          this.events.emit("power", hostId, patch.power);
        }
      });
    this.#writes.set(hostId, next);
    return next;
  }

  async #setPower(hostId: string, power: PowerState): Promise<void> {
    await this.#setCloud(hostId, { power, powerSince: nowIso() });
  }
}

function metaOf(row: HostRow | null | undefined): HostMeta {
  return (row?.meta ?? {}) as HostMeta;
}

function cloudOf(row: HostRow): CloudMeta | null {
  return row.kind === "cloud" ? (row.cloud ?? null) : null;
}

function freshUsage(now: string): UsageMonth {
  return { month: now.slice(0, 7), running: 0, stopped: 0, hibernated: 0, lastAt: now };
}

/** This month's hours, including the time since the last update, split by power state. */
export function advance(
  c: Pick<CloudMeta, "usage" | "power" | "lastMonth" | "provider" | "size" | "snapshot">,
  now: Date,
): { usage: UsageMonth; lastMonth: CloudMeta["lastMonth"] } {
  const iso = now.toISOString();
  let usage = { ...c.usage };
  let lastMonth = c.lastMonth;
  const month = iso.slice(0, 7);
  if (usage.month !== month) {
    const total = costOf(c.provider, c.size, {
      ...usage,
      snapshotGb: c.snapshot?.sizeGb ?? 0,
    }).total;
    lastMonth = { month: usage.month, total };
    // Count only this month's part of the gap.
    usage = { month, running: 0, stopped: 0, hibernated: 0, lastAt: `${month}-01T00:00:00.000Z` };
  }
  const hours = Math.max(0, (now.getTime() - Date.parse(usage.lastAt)) / 3_600_000);
  const bucket: keyof Pick<UsageMonth, "running" | "stopped" | "hibernated"> =
    c.power === "stopped" || c.power === "hibernating"
      ? "stopped"
      : c.power === "hibernated"
        ? "hibernated"
        : c.power === "missing"
          ? "hibernated"
          : "running";
  if (c.power !== "missing") usage[bucket] += hours;
  usage.lastAt = iso;
  return { usage, lastMonth };
}

/**
 * Idle settings for a new server on a cloud VM: stop when nobody plays, then
 * take the VM down. A stopped VM still costs in full except on AWS, so
 * elsewhere it is deleted and kept as a snapshot.
 */
export function savingAutomation(provider: ProviderId): Partial<ServerAutomation> {
  return {
    idleStopMinutes: CLOUD_IDLE_STOP_MINUTES,
    vmIdle: PROVIDERS[provider].snapshots ? "hibernate" : "stop",
  };
}

function usageSize(c: CloudMeta): CloudUsageSize {
  return {
    id: c.size.id,
    label: c.size.label,
    priceHourly: c.size.priceHourly,
    priceMonthly: c.size.priceMonthly,
    noMonthlyCap: c.size.noMonthlyCap || !(c.size.priceMonthly > 0),
    diskGb: c.size.diskGb,
    currency: c.size.currency,
  };
}

/** Which panel host a resource belongs to, and whether that host still uses it. */
function linkItem(r: CloudResource, hosts: HostRow[]): ScanItem {
  for (const h of hosts) {
    const c = cloudOf(h);
    if (!c) continue;
    const current: Partial<Record<ResourceKind, string | null>> = {
      vm: c.vmId,
      firewall: c.firewallId,
      "ssh-key": c.sshKeyId,
      snapshot: c.snapshot?.imageId ?? null,
      tag: c.tag,
    };
    if (current[r.kind] === r.id) return { ...r, hostId: h.id, hostName: h.name, inUse: true };
  }
  const owner = r.tag ? hosts.find((h) => cloudOf(h)?.tag === r.tag) : undefined;
  return { ...r, hostId: owner?.id ?? null, hostName: owner?.name ?? null, inUse: false };
}

/** Delete, retrying a few times: AWS keeps a security group busy until its instance is gone. */
async function deleteWithRetry(p: CloudProvider, kind: ResourceKind, id: string): Promise<void> {
  const tries = kind === "firewall" || kind === "volume" ? 6 : 2;
  for (let i = 1; ; i++) {
    try {
      return await p.deleteResource({ kind, id });
    } catch (err) {
      if (i >= tries || (err instanceof CloudError && err.code === "permission")) throw err;
      await sleep(10_000);
    }
  }
}

function vmName(name: string, tag: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "minecraft"}-${tag.slice(-6)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
