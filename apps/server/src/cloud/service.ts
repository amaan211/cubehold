import { EventEmitter } from "node:events";
import {
  BILLING,
  CloudError,
  type CloudProvider,
  type CloudRegion,
  type CloudSize,
  type CloudVm,
  costOf,
  createProvider,
  hostTag,
  type IdleMode,
  monthlyEstimate,
  PROVIDERS,
  type ProviderCredential,
  type ProviderDeps,
  type ProviderId,
  type VmStatus,
} from "@cubehold/providers";
import type { AddCloudAccountInput, CreateCloudHostInput, ServerStatus } from "@cubehold/shared";
import { eq, like } from "drizzle-orm";
import { newId } from "../auth/session.js";
import { type Db, schema } from "../db/index.js";
import type { HostManager } from "../hosts/manager.js";
import type { HostMeta, HostService, Job } from "../hosts/service.js";
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
import type { CloudHostState, CloudMeta, CloudView, PowerState, UsageMonth } from "./types.js";

const { hosts: hostsTable, servers: serversTable, credentials } = schema;
type HostRow = typeof hostsTable.$inferSelect;

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
    void this.#monitor();
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
    if (!host || !c || c.power !== "running") return;
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
          ? "The VM is saved as a snapshot; restoring it first (usually 2 to 5 minutes)."
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
      if (this.hostAdmin.busy(row.id)) continue;
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

  /** Add the time since the last tick to this month's usage. */
  async #tick(hostId: string): Promise<void> {
    const row = await this.#hostRow(hostId);
    const c = row && cloudOf(row);
    if (!c) return;
    const { usage, lastMonth } = advance(c, new Date());
    await this.#setCloud(hostId, { usage, lastMonth }, false);
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
        if (tick) cloud = { ...cloud, ...advance(cloud, new Date()) };
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
