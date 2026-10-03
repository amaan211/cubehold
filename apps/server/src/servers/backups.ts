import type { AgentDownload } from "@cubehold/agent";
import { classifyEntry, worldFolderNames } from "@cubehold/mc";
import type { BackupInfo, BackupKind, BackupScope, ServerStatus } from "@cubehold/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { newId } from "../auth/session.js";
import { type Db, schema } from "../db/index.js";
import type { RealtimeBus } from "../realtime/bus.js";
import {
  ACTIVE,
  errMessage,
  nowIso,
  ServerError,
  type ServerRow,
  type ServerService,
} from "./service.js";
import type { Task, Tasks } from "./tasks.js";

const { backups } = schema;
type BackupRow = typeof backups.$inferSelect;

/** Never in a backup: the world lock is held by a running server and means nothing afterwards. */
const SKIP = ["session.lock"];
const AUTOMATIC: BackupKind[] = ["scheduled", "pre-restore"];

/**
 * Zip backups of a server, stored on its host under
 * data/backups/<server>/archives. A running server keeps running: saving is
 * paused (save-off), everything is flushed to disk (save-all flush), the
 * files are zipped, and saving is switched back on.
 */
export class BackupService {
  #running = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly bus: RealtimeBus,
    private readonly tasks: Tasks,
  ) {}

  /** Backups interrupted by a panel restart can never finish; mark them and drop partial zips. */
  async init(): Promise<void> {
    const stuck = await this.db.select().from(backups).where(eq(backups.state, "creating"));
    for (const b of stuck) {
      await this.db
        .update(backups)
        .set({
          state: "failed",
          error: "Interrupted: the panel stopped while this backup was running.",
        })
        .where(eq(backups.id, b.id));
      try {
        const row = await this.servers.row(b.serverId);
        const p = this.servers.hostPath(row);
        await this.servers
          .agentOf(row)
          .removePaths(p.dirname(b.path), [p.basename(b.path), `${p.basename(b.path)}.part`]);
      } catch {
        // server or file already gone
      }
    }
  }

  async list(
    serverId: string,
  ): Promise<{ backups: BackupInfo[]; totalBytes: number; keep: number }> {
    const row = await this.servers.row(serverId);
    const rows = await this.db
      .select()
      .from(backups)
      .where(eq(backups.serverId, serverId))
      .orderBy(desc(backups.createdAt));
    return {
      backups: rows.map(toInfo),
      totalBytes: rows.reduce((n, b) => n + (b.sizeBytes ?? 0), 0),
      keep: row.settings?.backupKeep ?? 10,
    };
  }

  /** Start a backup in the background; returns the row in state "creating". */
  async create(
    serverId: string,
    opts: { label?: string; scope: BackupScope; kind: BackupKind },
  ): Promise<BackupInfo> {
    const { info, done } = await this.#begin(serverId, opts);
    done.catch(() => {}); // failures are recorded on the row and reported as a task
    return info;
  }

  /** Back up and wait for it (schedules, safety backups before a restore). */
  async createAndWait(
    serverId: string,
    opts: { label?: string; scope: BackupScope; kind: BackupKind },
  ): Promise<BackupInfo> {
    const { done } = await this.#begin(serverId, opts);
    return done;
  }

  async remove(serverId: string, backupId: string): Promise<void> {
    const b = await this.#get(serverId, backupId);
    if (b.state === "creating")
      throw new ServerError("BAD_STATE", "This backup is still being written");
    await this.#delete(b);
  }

  /**
   * Replace the server's files with a backup, in the background. Stops the
   * server first, takes a safety backup of the current state unless told not
   * to, and starts the server again if it was running (or startAfter is set).
   */
  async restore(
    serverId: string,
    backupId: string,
    opts: { safetyBackup: boolean; startAfter: boolean },
  ): Promise<{ started: true }> {
    const b = await this.#get(serverId, backupId);
    if (b.state !== "ready")
      throw new ServerError("BAD_STATE", "Only finished backups can be restored");
    const row = await this.servers.row(serverId);
    this.servers.assertIdle(row);
    if (this.#running.has(serverId))
      throw new ServerError("BAD_STATE", "Wait for the running backup to finish");

    const label = b.label ?? formatWhen(b.createdAt);
    let restartAfter = opts.startAfter;
    const job = this.servers
      .exclusive(serverId, "the backup restore", () =>
        this.tasks.run(serverId, "restore", `Restoring ${label}`, async (task) => {
          const agent = this.servers.agentOf(row);
          const status = await agent.status(serverId);
          if (ACTIVE.includes(status)) restartAfter = true;
          if (ACTIVE.includes(status) || status === "sleeping" || status === "crashed") {
            task.progress(null, "Stopping the server");
            this.bus.system(serverId, "Stopping the server to restore a backup.");
            await agent.stop(serverId);
            await this.servers.setStatus(serverId, "stopped");
          }
          if (opts.safetyBackup) {
            task.progress(null, "Backing up the current files first");
            await this.createAndWait(serverId, {
              kind: "pre-restore",
              scope: b.scope as BackupScope,
              label: `Before restoring ${label}`,
            });
          }
          task.progress(null, "Removing current files");
          const levelName = await this.servers.levelName(row);
          const inZip = await agent.zipEntries(b.path);
          const current = await agent.listDir(row.directory, "");
          const replace = new Set(inZip);
          if (b.scope === "full") {
            for (const e of current) {
              const cat = classifyEntry(e.name, e.kind, levelName);
              if (cat !== "downloaded" && cat !== "logs") replace.add(e.name);
            }
          } else {
            for (const w of worldFolderNames(levelName)) replace.add(w);
          }
          await agent.removePaths(row.directory, [...replace]);
          task.progress(0, "Extracting");
          await agent.unzip(b.path, row.directory, { overwrite: true, taskId: task.id });
          this.bus.system(serverId, `Restored backup "${label}".`);
        }),
      )
      .then(async () => {
        if (restartAfter) await this.servers.start(serverId);
      })
      .catch((err) => this.bus.system(serverId, `Restore failed: ${errMessage(err)}`));
    void job;
    return { started: true };
  }

  async download(serverId: string, backupId: string): Promise<AgentDownload & { name: string }> {
    const b = await this.#get(serverId, backupId);
    if (b.state !== "ready") throw new ServerError("BAD_STATE", "This backup is not finished");
    const row = await this.servers.row(serverId);
    const p = this.servers.hostPath(row);
    const dl = await this.servers.remoteOf(row).download(p.dirname(b.path), p.basename(b.path));
    return { ...dl, name: `${slug(row.name)}_${p.basename(b.path)}` };
  }

  // --- internals -------------------------------------------------------------------

  async #begin(
    serverId: string,
    opts: { label?: string; scope: BackupScope; kind: BackupKind },
  ): Promise<{ info: BackupInfo; done: Promise<BackupInfo> }> {
    const row = await this.servers.row(serverId);
    if (row.status === "installing")
      throw new ServerError("BAD_STATE", "The server is being installed");
    if (this.#running.has(serverId))
      throw new ServerError("BAD_STATE", "A backup is already running");
    this.#running.add(serverId);

    const id = newId();
    const stamp = nowIso().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const file = this.servers
      .hostPath(row)
      .join(this.servers.serverBackupsDir(row), "archives", `${stamp}_${opts.kind}.zip`);
    await this.db.insert(backups).values({
      id,
      serverId,
      label: opts.label?.trim() || null,
      path: file,
      kind: opts.kind,
      scope: opts.scope,
      state: "creating",
      mcVersion: row.mcVersion,
    });
    const info = toInfo(await this.#get(serverId, id));
    const task = this.tasks.start(
      serverId,
      "backup",
      opts.label?.trim() ? `Backing up: ${opts.label.trim()}` : "Backing up",
    );
    const done = this.#run(row, file, opts.scope, task)
      .then(async (result) => {
        await this.db
          .update(backups)
          .set({ state: "ready", sizeBytes: result.zipBytes, fileCount: result.files })
          .where(eq(backups.id, id));
        task.done(`${result.files} files`);
        this.bus.system(
          serverId,
          `Backup finished: ${result.files} files, ${formatBytes(result.zipBytes)}.`,
        );
        await this.#prune(serverId).catch((err) => console.warn("backup retention failed", err));
        return toInfo(await this.#get(serverId, id));
      })
      .catch(async (err) => {
        const message = errMessage(err);
        await this.db
          .update(backups)
          .set({ state: "failed", error: message })
          .where(eq(backups.id, id));
        task.fail(message);
        this.bus.system(serverId, `Backup failed: ${message}`);
        throw new ServerError("BAD_STATE", `Backup failed: ${message}`);
      })
      .finally(() => this.#running.delete(serverId));
    return { info, done };
  }

  async #run(row: ServerRow, file: string, scope: BackupScope, task: Task) {
    const agent = this.servers.agentOf(row);
    const levelName = await this.servers.levelName(row);
    const entries = await agent.listDir(row.directory, "");
    const rels =
      scope === "world"
        ? entries
            .filter((e) => e.kind === "dir" && worldFolderNames(levelName).includes(e.name))
            .map((e) => e.name)
        : entries
            .filter((e) => {
              const cat = classifyEntry(e.name, e.kind, levelName);
              return cat !== "downloaded" && cat !== "logs";
            })
            .map((e) => e.name);
    if (rels.length === 0) {
      throw new Error(
        scope === "world"
          ? "There is no world yet; start the server once first"
          : "Nothing to back up",
      );
    }

    const live = (await agent.status(row.id)) === ("running" satisfies ServerStatus);
    if (live) {
      task.progress(null, "Saving the world");
      await agent.command(row.id, "save-off");
      const reply = await agent.command(row.id, "save-all flush");
      // Without RCON the reply comes through the console.
      if (reply === null) await this.bus.waitForLine(row.id, /Saved the (game|world)/i, 120_000);
    }
    try {
      task.progress(0, "Compressing");
      return await agent.zip(row.directory, rels, file, { skipNames: SKIP, taskId: task.id });
    } finally {
      if (live) await agent.command(row.id, "save-on").catch(() => {});
    }
  }

  /** Keep the newest N automatic backups; manual ones stay until deleted. */
  async #prune(serverId: string): Promise<void> {
    const row = await this.servers.row(serverId);
    const keep = row.settings?.backupKeep ?? 10;
    const auto = await this.db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serverId, serverId),
          eq(backups.state, "ready"),
          inArray(backups.kind, AUTOMATIC),
        ),
      )
      .orderBy(desc(backups.createdAt));
    for (const old of auto.slice(keep)) await this.#delete(old);
  }

  async #delete(b: BackupRow): Promise<void> {
    try {
      const row = await this.servers.row(b.serverId);
      const p = this.servers.hostPath(row);
      await this.servers.agentOf(row).removePaths(p.dirname(b.path), [p.basename(b.path)]);
    } catch (err) {
      if (!(err instanceof ServerError && err.code === "NOT_FOUND")) throw err;
    }
    await this.db.delete(backups).where(eq(backups.id, b.id));
  }

  async #get(serverId: string, backupId: string): Promise<BackupRow> {
    const b = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.serverId, serverId)))
      .get();
    if (!b) throw new ServerError("NOT_FOUND", "Backup not found");
    return b;
  }
}

function toInfo(b: BackupRow): BackupInfo {
  return {
    id: b.id,
    serverId: b.serverId,
    label: b.label,
    kind: b.kind as BackupKind,
    scope: b.scope as BackupScope,
    state: b.state as BackupInfo["state"],
    error: b.error,
    sizeBytes: b.sizeBytes,
    files: b.fileCount,
    mcVersion: b.mcVersion,
    createdAt: b.createdAt,
  };
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function slug(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}
