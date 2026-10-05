import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { RemoteAgent } from "@cubehold/agent";
import { DEFAULT_AUTOMATION, type ServerStatus } from "@cubehold/shared";
import { eq } from "drizzle-orm";
import { type Db, schema } from "../db/index.js";
import type { HostManager } from "../hosts/manager.js";
import type { RealtimeBus } from "../realtime/bus.js";
import { ACTIVE, errMessage, nowIso, ServerError, type ServerService } from "./service.js";
import type { Task, Tasks } from "./tasks.js";

const { servers, backups, hosts: hostsTable } = schema;

/** Share of the progress bar per phase of a move. */
const PHASES = { pack: [0, 25], copy: [25, 75], unpack: [75, 95] } as const;

/**
 * Moves a server to another host and keeps its identity: same id, so
 * schedules, player history, crash records and backups stay attached. The
 * files travel as zips streamed through the panel from one agent to the
 * other; the server only switches hosts once the copy is complete and
 * counted, and the old copy is deleted last.
 */
export class ServerMover {
  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly hosts: HostManager,
    private readonly tasks: Tasks,
    private readonly bus: RealtimeBus,
  ) {}

  async move(
    serverId: string,
    targetHostId: string,
    opts: { port?: number; includeBackups: boolean },
  ): Promise<{ started: true }> {
    const row = await this.servers.row(serverId);
    if (row.hostId === targetHostId) {
      throw new ServerError("VALIDATION", "The server is already on that host.");
    }
    const target = await this.db
      .select()
      .from(hostsTable)
      .where(eq(hostsTable.id, targetHostId))
      .get();
    if (!target) throw new ServerError("NOT_FOUND", "Host not found");
    if (!this.hosts.isConnected(targetHostId)) {
      throw new ServerError("BAD_STATE", `${target.name} is not connected.`);
    }
    if (!this.hosts.isConnected(row.hostId)) {
      throw new ServerError("BAD_STATE", "The server's current host is not connected.");
    }
    this.servers.assertIdle(row);
    const port = opts.port ?? row.port;
    await this.servers.assertPortFree(targetHostId, port, row.id);
    await this.servers.assertMemoryFitsHost(targetHostId, row.memoryMb);

    const job = this.servers
      .exclusive(serverId, "the move to another host", () =>
        this.tasks.run(serverId, "move", `Moving to ${target.name}`, (task) =>
          this.#run(serverId, targetHostId, target.name, port, opts.includeBackups, task),
        ),
      )
      .catch((err) => this.bus.system(serverId, `Move failed: ${errMessage(err)}`));
    void job;
    return { started: true };
  }

  async #run(
    serverId: string,
    toHost: string,
    toName: string,
    port: number,
    includeBackups: boolean,
    task: Task,
  ): Promise<void> {
    let row = await this.servers.row(serverId);
    const fromHost = row.hostId;
    const from = this.hosts.remoteFor(fromHost);
    const to = this.hosts.remoteFor(toHost);
    const src = this.hosts.layout(fromHost);
    const dst = this.hosts.layout(toHost);
    const status = await from.status(serverId).catch(() => row.status as ServerStatus);
    const wasRunning = ACTIVE.includes(status);
    if (wasRunning || status === "sleeping") {
      this.bus.system(serverId, `Stopping the server to move it to ${toName}.`);
      await from.stop(serverId);
    }
    this.bus.system(
      serverId,
      `Moving to ${toName}. The server stays here until the copy is complete.`,
    );

    const stamp = randomBytes(4).toString("hex");
    const srcBackups = this.servers.serverBackupsDir(row);
    const dstDir = dst.path.join(dst.serversDir, serverId);
    const dstBackups = dst.path.join(dst.backupsDir, serverId);
    const srcTmp = src.path.join(src.dataDir, "tmp");
    const dstTmp = dst.path.join(dst.dataDir, "tmp");
    const packs: Array<{ from: string; to: string; label: string }> = [
      { from: row.directory, to: dstDir, label: "server files" },
    ];
    const [backupStat] = await from.stat(src.backupsDir, [serverId]);
    if (includeBackups && backupStat?.exists && backupStat.files > 0) {
      packs.push({ from: srcBackups, to: dstBackups, label: "backups" });
    }
    const [taken] = await to.stat(dst.serversDir, [serverId]);
    if (taken?.exists) await to.removeDir(dstDir);

    const cleanups: Array<() => Promise<unknown>> = [];
    let switched = false;
    const saving = await this.servers.cloudAutomation(toHost);
    let savingNote = false;
    try {
      for (const [i, pack] of packs.entries()) {
        const zipName = `move-${serverId}-${stamp}-${i}.zip`;
        const srcZip = src.path.join(srcTmp, zipName);
        cleanups.push(() => from.removePaths(srcTmp, [zipName, `${zipName}.part`]));
        cleanups.push(() => to.removePaths(dstTmp, [zipName, `${zipName}.upload`]));

        const entries = (await from.listDir(pack.from, "")).map((e) => e.name);
        task.progress(PHASES.pack[0], `Packing the ${pack.label}`);
        const packed = await this.#withProgress(task, PHASES.pack, (taskId) =>
          from.zip(pack.from, entries, srcZip, { skipNames: ["session.lock"], taskId }),
        );

        task.progress(PHASES.copy[0], `Copying the ${pack.label} (${mb(packed.zipBytes)})`);
        await this.#copy(from, to, srcTmp, dstTmp, zipName, packed.zipBytes, task);

        task.progress(PHASES.unpack[0], `Unpacking the ${pack.label}`);
        await to.makeDir(pack.to, "");
        const unpacked = await this.#withProgress(task, PHASES.unpack, (taskId) =>
          to.unzip(dst.path.join(dstTmp, zipName), pack.to, { overwrite: true, taskId }),
        );
        if (unpacked.files !== packed.files) {
          throw new Error(
            `The copy of the ${pack.label} is incomplete (${unpacked.files} of ${packed.files} files).`,
          );
        }
        this.bus.system(serverId, `Copied the ${pack.label}: ${packed.files} files.`);
      }

      if (port !== row.port) {
        await this.servers.patchProperties(
          { ...row, hostId: toHost, directory: dstDir },
          {
            "server-port": port,
          },
        );
      }

      // Switch hosts. Backup rows follow their files (or go, when left behind).
      const backupRows = await this.db.select().from(backups).where(eq(backups.serverId, serverId));
      await this.db.transaction(async (tx) => {
        for (const b of backupRows) {
          if (packs.length > 1) {
            const rel = src.path.relative(srcBackups, b.path).split(src.path.sep);
            await tx
              .update(backups)
              .set({ path: dst.path.join(dstBackups, ...rel) })
              .where(eq(backups.id, b.id));
          } else {
            await tx.delete(backups).where(eq(backups.id, b.id));
          }
        }
        const settings = { ...(row.settings ?? {}) };
        // Router forwards and ngrok belong to the old host; the Bedrock port is picked anew.
        delete settings.upnp;
        delete settings.ngrok;
        settings.bedrockPort = null;
        // Onto a cloud VM, idle settings nobody changed become the money-saving ones.
        const automation = settings.automation;
        if (!automation || (automation.idleStopMinutes === 0 && automation.vmIdle === "keep")) {
          if (Object.keys(saving).length > 0) {
            settings.automation = { ...DEFAULT_AUTOMATION, ...automation, ...saving };
            savingNote = true;
          }
        }
        await tx
          .update(servers)
          .set({
            hostId: toHost,
            directory: dstDir,
            port,
            status: "stopped",
            settings,
            updatedAt: nowIso(),
          })
          .where(eq(servers.id, serverId));
      });
      switched = true;
      row = await this.servers.row(serverId);
      this.bus.setStatus(serverId, "stopped");
    } catch (err) {
      if (!switched) {
        await to.removeDir(dstDir).catch(() => {});
        if (packs.length > 1) await to.removeDir(dstBackups).catch(() => {});
      }
      for (const c of cleanups) await c().catch(() => {});
      await this.servers.setStatus(serverId, "stopped");
      throw err;
    }

    // The old copy goes last, once the server lives on the new host.
    for (const c of cleanups) await c().catch(() => {});
    await from
      .removeDir(srcBackups)
      .catch((err) =>
        this.bus.system(serverId, `Could not delete the old backups: ${errMessage(err)}`),
      );
    await from
      .removeDir(src.path.join(src.serversDir, serverId))
      .catch((err) =>
        this.bus.system(serverId, `Could not delete the old server folder: ${errMessage(err)}`),
      );
    this.servers.events.emit("moved", serverId, fromHost, toHost);
    this.servers.events.emit("changed", serverId);
    await this.servers.gcJava(fromHost);
    this.bus.system(serverId, `Moved to ${toName}.`);
    if (savingNote) {
      this.bus.system(
        serverId,
        "On a cloud VM the server now stops after 15 minutes with nobody online, and the VM goes down to save money. Change this in Settings → Automation.",
      );
    }
    task.progress(100, "Done");
    if (wasRunning) {
      await this.servers
        .start(serverId)
        .catch((err) =>
          this.bus.system(serverId, `Could not start on ${toName}: ${errMessage(err)}`),
        );
    }
  }

  /** Stream a zip from one agent to the other through the panel. */
  async #copy(
    from: RemoteAgent,
    to: RemoteAgent,
    srcDir: string,
    dstDir: string,
    name: string,
    size: number,
    task: Task,
  ): Promise<void> {
    const dl = await from.download(srcDir, name);
    const total = dl.sizeBytes ?? size;
    let done = 0;
    let last = 0;
    const counter = new PassThrough();
    counter.on("data", (chunk: Buffer) => {
      done += chunk.length;
      const now = Date.now();
      if (now - last > 500) {
        last = now;
        const [a, b] = PHASES.copy;
        task.progress(
          a + ((b - a) * done) / Math.max(1, total),
          `Copying (${mb(done)} of ${mb(total)})`,
        );
      }
    });
    dl.body.on("error", (err) => counter.destroy(err));
    dl.body.pipe(counter);
    const written = await to.upload(dstDir, name, counter, true);
    if (written !== total) {
      throw new Error(`The copy arrived incomplete (${written} of ${total} bytes).`);
    }
  }

  /** Run an agent job whose "progress" events fill one phase of the task's bar. */
  async #withProgress<T>(
    task: Task,
    [a, b]: readonly [number, number],
    fn: (taskId: string) => Promise<T>,
  ): Promise<T> {
    const relay = this.tasks.relay((done, total) => {
      if (total) task.progress(a + ((b - a) * done) / total);
    });
    try {
      return await fn(relay.id);
    } finally {
      relay.dispose();
    }
  }
}

function mb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
