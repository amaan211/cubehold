import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentApi,
  AgentEvent,
  AgentPolicy,
  AgentSnapshot,
  InstallStep,
  LaunchRequest,
  RemoteAgent,
} from "@cubehold/agent";
import {
  analyzeCrash,
  applyProperties,
  authProperties,
  BEDROCK_BASE_PORT,
  buildJavaArgs,
  classifyEntry,
  coerceValue,
  compareVersionsIn,
  errorLines,
  fallbackJavaMajor,
  GC_LOG_FILE,
  geyserArgs,
  listVersions,
  log4jMitigation,
  PROPERTY_SPECS,
  parseProperties,
  propertiesToMap,
  rconProperties,
  resolveDownload,
  serializeProperties,
  tpsCommandFor,
  unexplainedExit,
  validateValues,
  worldFolderNames,
} from "@cubehold/mc";
import {
  type BackupCategory,
  type ConsoleLine,
  type CreateServerInput,
  DEFAULT_AUTOMATION,
  type DeleteServerInput,
  type DowngradeWorldAction,
  estimateProcessMemoryMb,
  HOST_RESERVE_MB,
  LOCAL_HOST_ID,
  type PropertyValue,
  type Server,
  type ServerAutomation,
  type ServerStatus,
  type UpdateServerInput,
  type VersionSnapshot,
} from "@cubehold/shared";
import { eq } from "drizzle-orm";
import { newId } from "../auth/session.js";
import type { Config } from "../config.js";
import { type Db, schema } from "../db/index.js";
import type { CrashRecord } from "../db/schema.js";
import type { HostLayout, HostManager } from "../hosts/manager.js";
import type { RealtimeBus } from "../realtime/bus.js";
import {
  DestinationError,
  defaultExportDestination,
  dirSize,
  exportName,
  validateExportDestination,
} from "./storage.js";
import type { Tasks } from "./tasks.js";

const { servers } = schema;
export type ServerRow = typeof servers.$inferSelect;
type ServerMeta = NonNullable<ServerRow["meta"]>;

type InstallReporter = (step: InstallStep, message: string, percent: number | null) => void;

/**
 * Extra install work for a new server (a modpack's mods and configs), run
 * after the server software is in place and while it is still "installing".
 * If it fails, pressing Start runs the whole install again.
 */
export type AfterInstall = (ctx: {
  row: ServerRow;
  agent: RemoteAgent;
  report: InstallReporter;
}) => Promise<void>;

export class ServerError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_STATE" | "VALIDATION",
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export const ACTIVE: ServerStatus[] = ["starting", "running", "stopping"];
const SNAPSHOT_MANIFEST = "snapshot.json";
const MAX_SNAPSHOTS = 5;
const MAX_CRASHES = 20;
const RCON_BASE_PORT = 25575;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts ANSI colour codes
const ANSI = /\x1b\[[0-9;]*m/g;

const CATEGORY_LABELS: Record<BackupCategory, string> = {
  world: "Worlds",
  addons: "Plugins, mods and their configs",
  config: "Server settings and player lists",
  logs: "Logs and crash reports",
  snapshots: "Backups and world snapshots",
  other: "Other files",
};
const DEFAULT_EXPORT: BackupCategory[] = ["world", "addons", "config", "other"];

export interface DeletePlanCategory {
  id: BackupCategory;
  label: string;
  paths: string[];
  sizeBytes: number;
  files: number;
  selected: boolean;
}

/** Things other services react to without the agent wiring. */
interface ServiceEvents {
  players: [serverId: string, players: string[]];
  /** The server process ended (stopped, crashed or idle-stopped). */
  stopped: [serverId: string];
  removed: [serverId: string];
  /** The server now runs another Minecraft version. */
  versionChanged: [serverId: string];
  /** Name, port or other settings that affect networking changed. */
  changed: [serverId: string];
  created: [serverId: string];
  /** The server now lives on another host. */
  moved: [serverId: string, fromHostId: string, toHostId: string];
  /** The agent stopped the server because nobody played. */
  idleStopped: [serverId: string];
}

export class ServerService {
  /** Servers whose files are being changed (install or version change). */
  #installing = new Set<string>();
  #deleting = new Set<string>();
  /** Other exclusive jobs (restores), by server, with a label for error messages. */
  #busy = new Map<string, string>();
  /** Where "install" events from the agents go, by server, while a job runs. */
  #reporters = new Map<string, InstallReporter>();
  /** Install steps still owed to new servers (modpacks); kept until they succeed. */
  #afterInstall = new Map<string, AfterInstall>();
  #startGate: ((row: ServerRow) => Promise<boolean>) | null = null;
  #vmPowersDown: ((row: ServerRow) => Promise<boolean>) | null = null;
  readonly events = new EventEmitter<ServiceEvents>();

  constructor(
    private readonly db: Db,
    private readonly hosts: HostManager,
    private readonly bus: RealtimeBus,
    private readonly config: Config,
    private readonly tasks: Tasks,
  ) {
    hosts.onAgentEvent((_hostId, ev) => void this.#onAgentEvent(ev));
    // After an agent reconnects (panel restart, daemon restart, network blip), trust it over the DB.
    hosts.onAgentConnect((hostId) => {
      this.reconcile(hostId).catch((err) => console.error("reconcile failed", err));
    });
  }

  /**
   * Align the DB and the realtime bus with what the agents actually run.
   * Servers keep running across panel restarts, so this adopts them rather
   * than assuming everything stopped. Servers that were asleep when an agent
   * restarted get their wake-on-join listener back.
   */
  async reconcile(hostId?: string): Promise<void> {
    const rows = (await this.db.select().from(servers)).filter(
      (r) => !hostId || r.hostId === hostId,
    );
    for (const row of rows) {
      if (this.#installing.has(row.id) || this.#deleting.has(row.id)) continue;
      // A delete interrupted by a panel restart: files may be partly gone, so
      // make the server visible again and let the user retry the delete.
      if (row.meta?.deletingSince) await this.#setMeta(row.id, { deletingSince: null });
      let snap: AgentSnapshot | null = null;
      try {
        snap = await this.hosts.agentFor(row.hostId).snapshot(row.id, row.directory);
      } catch {
        snap = null;
      }
      if (!snap) {
        // Host unreachable (a VPS that is offline): keep the last known state
        // until its agent connects, which reconciles again.
        this.bus.seed(row.id, { status: row.status as ServerStatus, players: [], console: [] });
        continue;
      }
      const agent = this.hosts.agentFor(row.hostId);
      let status: ServerStatus = snap.status;
      if (
        snap &&
        status === "stopped" &&
        row.status === "sleeping" &&
        (await this.#policy(row)).wakeOnJoin
      ) {
        try {
          const { req } = await this.#launchRequest(row);
          await agent.sleep(req);
          status = await agent.status(row.id);
        } catch (err) {
          this.bus.system(row.id, `Could not resume sleeping: ${errMessage(err)}`);
        }
      }
      if (row.status !== status) await this.#setStatus(row.id, status);
      const console: ConsoleLine[] = snap.lines.map((l) => ({
        serverId: row.id,
        at: l.at,
        line: l.line,
        stream: l.stream,
      }));
      if (snap.source === "logfile" && console.length > 0) {
        console.unshift({
          serverId: row.id,
          at: console[0]?.at ?? Date.now(),
          line: "Showing the end of logs/latest.log from the last run.",
          stream: "system",
        });
      }
      this.bus.seed(row.id, { status, players: snap.players, console });
      if (!ACTIVE.includes(status)) this.events.emit("stopped", row.id);
      else this.events.emit("players", row.id, snap.players);
    }
    for (const id of hostId ? [hostId] : this.hosts.hostIds()) {
      if (this.hosts.isConnected(id)) await this.#gcJava(id);
    }
  }

  // --- Queries -------------------------------------------------------------

  async list(): Promise<Server[]> {
    return (await this.db.select().from(servers)).filter((r) => !r.meta?.deletingSince).map(toApi);
  }

  async get(serverId: string) {
    const row = await this.row(serverId);
    return {
      ...toApi(row),
      meta: row.meta,
      directory: row.directory,
      automation: automationOf(row),
      extraJvmArgs: row.settings?.extraJvmArgs ?? [],
      backupKeep: row.settings?.backupKeep ?? 10,
      rcon: row.settings?.rcon ? { port: row.settings.rcon.port } : null,
      estimatedProcessMb: estimateProcessMemoryMb(row.memoryMb),
      upnp: row.settings?.upnp === true,
      bedrockPort: row.settings?.bedrockPort ?? null,
    };
  }

  // --- Lifecycle -----------------------------------------------------------

  async create(
    input: CreateServerInput,
    extra: {
      /** Pin the Fabric/Forge/NeoForge version (a modpack's). */
      loaderVersion?: string;
      afterInstall?: AfterInstall;
      modpack?: { name: string; version: string };
    } = {},
  ): Promise<Server> {
    const agent = this.hosts.agentFor(input.hostId); // throws for unknown hosts
    await this.#assertPortAvailable(input.hostId, input.port, null);
    await this.#assertMemoryFits(agent, input.memoryMb);

    const id = newId();
    const layout = this.hosts.layout(input.hostId);
    const directory = layout.path.join(layout.serversDir, id);
    await this.db.insert(servers).values({
      id,
      hostId: input.hostId,
      name: input.name,
      software: input.software,
      mcVersion: input.mcVersion,
      javaVersion: 0,
      memoryMb: input.memoryMb,
      port: input.port,
      status: "installing",
      directory,
      settings: {
        onlineMode: input.onlineMode,
        automation: DEFAULT_AUTOMATION,
        ...(extra.loaderVersion ? { loaderVersion: extra.loaderVersion } : {}),
        ...(extra.modpack ? { modpack: extra.modpack } : {}),
      },
      meta: {},
    });
    if (extra.afterInstall) this.#afterInstall.set(id, extra.afterInstall);
    this.bus.setStatus(id, "installing");
    this.events.emit("created", id);
    // Failures are recorded on the row and streamed to the console; nothing to rethrow here.
    this.#install(id).catch(() => {});
    return toApi(await this.row(id));
  }

  /** Edit name, memory, port, JVM arguments, automation and backup retention. */
  async update(input: UpdateServerInput) {
    const row = await this.row(input.serverId);
    this.assertIdle(row);
    const agent = this.agentOf(row);
    const running = ACTIVE.includes(row.status as ServerStatus);
    const changes: Partial<ServerRow> = {};
    const settings = { ...(row.settings ?? {}) };
    const notes: string[] = [];

    if (input.name !== undefined && input.name !== row.name) changes.name = input.name;
    if (input.memoryMb !== undefined && input.memoryMb !== row.memoryMb) {
      await this.#assertMemoryFits(agent, input.memoryMb);
      changes.memoryMb = input.memoryMb;
      notes.push("memory");
    }
    if (input.port !== undefined && input.port !== row.port) {
      await this.#assertPortAvailable(row.hostId, input.port, row.id, !running);
      await this.#patchProperties(row, { "server-port": input.port });
      changes.port = input.port;
      notes.push("port");
    }
    if (input.extraJvmArgs !== undefined) {
      const bad = input.extraJvmArgs.find((a) => /^-Xm[sx]/i.test(a) || a === "-jar");
      if (bad) {
        throw new ServerError(
          "VALIDATION",
          `${bad} is set by the panel; change the memory setting instead`,
          { extraJvmArgs: "Managed by the panel" },
        );
      }
      settings.extraJvmArgs = input.extraJvmArgs;
      notes.push("JVM arguments");
    }
    if (input.automation) {
      settings.automation = { ...automationOf(row), ...input.automation };
    }
    if (input.backupKeep !== undefined) settings.backupKeep = input.backupKeep;

    await this.db
      .update(servers)
      .set({ ...changes, settings, updatedAt: nowIso() })
      .where(eq(servers.id, row.id));
    if (input.automation) {
      await agent.setPolicy(row.id, await this.#policy({ ...row, settings }));
    }
    if (running && notes.length > 0) {
      this.bus.system(row.id, `Changed ${notes.join(", ")}; restart the server to apply.`);
    }
    if (changes.port !== undefined || changes.name !== undefined) {
      this.events.emit("changed", row.id);
    }
    return this.get(row.id);
  }

  async start(serverId: string): Promise<void> {
    const row = await this.row(serverId);
    this.assertIdle(row);
    if (ACTIVE.includes(row.status as ServerStatus))
      throw new ServerError("BAD_STATE", "Server is already running");
    // A cloud VM that is off boots first; the gate starts the server once it is up.
    if (this.#startGate && !(await this.#startGate(row))) return;

    const agent = this.agentOf(row);
    const jarFile = row.settings?.jarFile;
    const [jar] = jarFile ? await agent.stat(row.directory, [jarFile]) : [];
    if (!jarFile || !jar?.exists || this.#afterInstall.has(serverId)) {
      this.bus.system(
        serverId,
        this.#afterInstall.has(serverId)
          ? "The last install did not finish; installing again before start."
          : "Server files are missing; reinstalling before start.",
      );
      await this.#install(serverId);
      if (this.#afterInstall.has(serverId)) return;
      return this.start(serverId);
    }

    const { req, javaName } = await this.#launchRequest(row);
    this.bus.system(
      serverId,
      `Starting ${row.software} ${row.mcVersion} with Java ${row.javaVersion} (${javaName}), ${row.memoryMb} MB heap`,
    );
    await this.#setStatus(serverId, "starting", { lastStartedAt: nowIso() });
    try {
      await agent.start(req);
    } catch (err) {
      // Nothing started (e.g. the host dropped just now): do not leave it "starting".
      if ((await agent.status(serverId).catch(() => "stopped")) === "stopped") {
        await this.#setStatus(serverId, "stopped");
      }
      throw err;
    }
  }

  async stop(serverId: string): Promise<void> {
    const row = await this.row(serverId);
    const agent = this.agentOf(row);
    const status = await agent.status(serverId).catch(() => row.status as ServerStatus);
    if (status === "stopped") throw new ServerError("BAD_STATE", "Server is not running");
    // Also ends sleeping (wake-on-join) and cancels a pending crash restart.
    await agent.stop(serverId);
    if (status === "sleeping" || status === "crashed") await this.#setStatus(serverId, "stopped");
  }

  async kill(serverId: string): Promise<void> {
    const row = await this.row(serverId);
    await this.agentOf(row).kill(serverId);
  }

  async restart(serverId: string): Promise<void> {
    const row = await this.row(serverId);
    const agent = this.agentOf(row);
    if (ACTIVE.includes(row.status as ServerStatus) || row.status === "sleeping") {
      await agent.stop(serverId);
      // The exit event reaches the panel just before stop() returns and is still being saved.
      for (let i = 0; i < 50; i++) {
        const now = (await this.row(serverId)).status as ServerStatus;
        if (!ACTIVE.includes(now) && now !== "sleeping") break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await this.start(serverId);
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    const row = await this.row(serverId);
    if (row.status !== "running" && row.status !== "starting") {
      throw new ServerError("BAD_STATE", "Server is not running");
    }
    this.bus.publish({
      type: "console.line",
      data: { serverId, at: Date.now(), line: `> ${command}`, stream: "system" },
    });
    await this.agentOf(row).send(serverId, command);
  }

  /**
   * Chat message to everyone. Goes through the console so players see
   * "[Server]" rather than "[Rcon]".
   */
  async say(serverId: string, message: string): Promise<void> {
    await this.consoleCommand(serverId, `say ${message.replace(/[\r\n]+/g, " ")}`);
  }

  /** A command typed into the server console by the panel: no reply, not echoed. */
  async consoleCommand(serverId: string, command: string): Promise<void> {
    const row = await this.row(serverId);
    if (row.status !== "running") throw new ServerError("BAD_STATE", "Server is not running");
    await this.agentOf(row).send(serverId, command);
  }

  /**
   * Run a command and get its reply (RCON). Returns null when the server has
   * no RCON connection; the command still ran through the console.
   */
  async command(serverId: string, command: string): Promise<string | null> {
    const row = await this.row(serverId);
    if (row.status !== "running") throw new ServerError("BAD_STATE", "Server is not running");
    try {
      return await this.agentOf(row).command(serverId, command);
    } catch (err) {
      throw new ServerError("BAD_STATE", `The server did not answer: ${errMessage(err)}`);
    }
  }

  // --- server.properties ---------------------------------------------------

  async getProperties(serverId: string) {
    const row = await this.row(serverId);
    const map = await this.#readProperties(row);
    const values: Record<string, PropertyValue> = {};
    for (const spec of PROPERTY_SPECS) {
      const raw = map.get(spec.key);
      values[spec.key] = raw === undefined ? spec.default : coerceValue(spec.key, raw);
    }
    // Keep the list-view mirror honest if the file was edited by hand.
    const onlineMode = values["online-mode"] !== false;
    if ((row.settings?.onlineMode ?? true) !== onlineMode) {
      await this.#setSettings(serverId, { onlineMode });
    }
    const unknown: Record<string, string> = {};
    for (const [k, v] of map) {
      if (PROPERTY_SPECS.some((s) => s.key === k) || isManagedKey(k)) continue;
      unknown[k] = v;
    }
    return {
      specs: PROPERTY_SPECS,
      values,
      unknown,
      requiresRestart: ACTIVE.includes(row.status as ServerStatus),
    };
  }

  async updateProperties(serverId: string, values: Record<string, PropertyValue>) {
    const row = await this.row(serverId);
    this.assertIdle(row);
    const errors = validateValues(values);
    for (const key of Object.keys(values)) {
      if (isManagedKey(key)) errors[key] = "This setting is managed by the panel.";
    }
    if (Object.keys(errors).length)
      throw new ServerError("VALIDATION", "Some settings are invalid", errors);
    await this.#patchProperties(row, values);
    if (typeof values["online-mode"] === "boolean") {
      await this.#setSettings(serverId, { onlineMode: values["online-mode"] });
    }
    this.bus.system(
      serverId,
      `server.properties updated (${Object.keys(values).length} keys)${ACTIVE.includes(row.status as ServerStatus) ? "; restart to apply" : ""}`,
    );
    return this.getProperties(serverId);
  }

  /** Turn every Microsoft/Mojang authentication check on or off in one go. */
  async setAuthMode(serverId: string, onlineMode: boolean) {
    const result = await this.updateProperties(serverId, authProperties(onlineMode));
    this.bus.system(
      serverId,
      onlineMode
        ? "Online mode on: players need a Microsoft account."
        : "Offline mode on: Microsoft/Mojang authentication and chat signing are disabled.",
    );
    return result;
  }

  // --- Crashes -------------------------------------------------------------

  async crashes(serverId: string) {
    const row = await this.row(serverId);
    return [...(row.meta?.crashes ?? [])].reverse();
  }

  /** A crash report or JVM error log with its analysis. */
  async crashReport(serverId: string, file: string) {
    const row = await this.row(serverId);
    if (!/^(crash-reports\/[^/\\]+\.txt|hs_err_pid\d+\.log)$/.test(file)) {
      throw new ServerError("VALIDATION", "Not a crash report");
    }
    const text = await this.agentOf(row)
      .readFile(row.directory, file, 4 * 1024 * 1024)
      .catch((err) => {
        throw new ServerError("NOT_FOUND", `Could not read ${file}: ${errMessage(err)}`);
      });
    return { file, text, analysis: analyzeCrash(text) };
  }

  /** Every crash report on disk, newest first. */
  async crashReports(serverId: string) {
    const row = await this.row(serverId);
    const agent = this.agentOf(row);
    const reports = (await agent.listDir(row.directory, "crash-reports").catch(() => []))
      .filter((e) => e.kind === "file" && e.name.endsWith(".txt"))
      .map((e) => ({
        file: `crash-reports/${e.name}`,
        sizeBytes: e.sizeBytes,
        modifiedAt: e.modifiedAt,
      }));
    const hsErr = (await agent.listDir(row.directory, "").catch(() => []))
      .filter((e) => e.kind === "file" && /^hs_err_pid\d+\.log$/.test(e.name))
      .map((e) => ({ file: e.name, sizeBytes: e.sizeBytes, modifiedAt: e.modifiedAt }));
    return [...reports, ...hsErr].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  // --- Version changes -----------------------------------------------------

  async versionInfo(serverId: string) {
    const row = await this.row(serverId);
    return {
      software: row.software as Server["software"],
      mcVersion: row.mcVersion,
      javaVersion: row.javaVersion,
      snapshots: await this.#listSnapshots(row),
      history: row.meta?.versionHistory ?? [],
      lastError: row.meta?.versionChangeError ?? null,
    };
  }

  async previewVersionChange(serverId: string, mcVersion: string) {
    const row = await this.row(serverId);
    const software = row.software as Server["software"];
    const list = await listVersions(software);
    if (!list.some((v) => v.id === mcVersion)) {
      throw new ServerError("VALIDATION", `${software} has no version ${mcVersion}`);
    }
    const cmp = compareVersionsIn(list, mcVersion, row.mcVersion);
    const resolved = await resolveDownload(software, mcVersion);
    const toJava = resolved.javaMajor ?? fallbackJavaMajor(mcVersion);
    const snapshots = await this.#listSnapshots(row);
    const [java] = await this.agentOf(row)
      .stat(this.hosts.layout(row.hostId).javaDir, [String(toJava)])
      .catch(() => []);
    return {
      from: row.mcVersion,
      to: mcVersion,
      direction: cmp === 0 ? "same" : cmp > 0 ? "upgrade" : "downgrade",
      fromJava: row.javaVersion,
      toJava,
      javaDownloadNeeded: !java?.exists,
      restoreSnapshot: snapshots.find((s) => s.mcVersion === mcVersion) ?? null,
      running: ACTIVE.includes(row.status as ServerStatus),
    } as const;
  }

  /**
   * Switch the server to another Minecraft version in the background: stop it
   * if running, download the new jar and Java, snapshot the world, swap the
   * binaries, handle the world for downgrades, and start it again.
   */
  async changeVersion(serverId: string, mcVersion: string, worldAction?: DowngradeWorldAction) {
    const row = await this.row(serverId);
    this.assertIdle(row);
    const preview = await this.previewVersionChange(serverId, mcVersion);
    if (preview.direction === "same") {
      throw new ServerError("VALIDATION", `The server already runs ${mcVersion}`);
    }
    const action: DowngradeWorldAction | null =
      preview.direction === "downgrade"
        ? (worldAction ?? (preview.restoreSnapshot ? "restore" : "keep"))
        : null;
    if (action === "restore" && !preview.restoreSnapshot) {
      throw new ServerError("VALIDATION", `There is no saved world from ${mcVersion} to restore`);
    }
    this.#installing.add(serverId); // lock before returning so nothing else starts it
    this.#runVersionChange(row, mcVersion, action, preview.restoreSnapshot).catch((err) =>
      console.error("version change failed", err),
    );
    return { started: true };
  }

  async #runVersionChange(
    row: ServerRow,
    target: string,
    action: DowngradeWorldAction | null,
    restoreSnapshot: VersionSnapshot | null,
  ): Promise<void> {
    const serverId = row.id;
    const from = row.mcVersion;
    const agent = this.agentOf(row);
    const report = this.#reporter(serverId);
    let wasRunning = false;
    let committed = false;
    try {
      const current = await agent.status(serverId);
      wasRunning = ACTIVE.includes(current);
      if (wasRunning || current === "sleeping") {
        if (wasRunning) this.bus.system(serverId, "Stopping the server to change its version.");
        this.bus.setStatus(serverId, "stopping");
        await agent.stop(serverId);
      }
      await this.#setStatus(serverId, "installing", { versionChangeError: null });
      this.bus.system(serverId, `Changing ${row.software} from ${from} to ${target}.`);

      // Another Minecraft version needs another loader, so a modpack's pin no longer applies.
      const staged = await agent.stageBinaries({
        serverId,
        directory: row.directory,
        software: row.software as Server["software"],
        mcVersion: target,
      });

      report("configure", `Saving a snapshot of the world as it is on ${from}`, null);
      await this.#snapshotWorld(row, from);

      report("configure", "Replacing server files", null);
      await agent.commitBinaries(row.directory, staged, row.settings?.jarFile);
      committed = true;

      const history = [...(row.meta?.versionHistory ?? []), { from, to: target, at: nowIso() }];
      await this.db
        .update(servers)
        .set({
          mcVersion: target,
          javaVersion: staged.javaMajor,
          settings: {
            ...(row.settings ?? {}),
            jarFile: staged.jarFile,
            launch: staged.launch ?? "jar",
            loaderVersion: undefined,
            build: staged.build,
            recommendedJvmFlags: staged.recommendedJvmFlags,
          },
          meta: { ...(row.meta ?? {}), versionHistory: history.slice(-50) },
          updatedAt: nowIso(),
        })
        .where(eq(servers.id, serverId));

      if (action === "restore" && restoreSnapshot) {
        report("configure", `Restoring the world saved on ${target}`, null);
        await this.#restoreSnapshot(row, restoreSnapshot);
      } else if (action === "fresh") {
        report("configure", "Starting a fresh world (the old one is kept in a snapshot)", null);
        await agent.removePaths(row.directory, worldFolderNames(await this.levelName(row)));
      } else if (action === "keep") {
        this.bus.system(
          serverId,
          `Keeping the current world. It was saved by ${from}; Minecraft ${target} may refuse to load it or lose chunks. The snapshot taken just now can bring it back.`,
        );
      }

      report("done", `Now on ${target} with Java ${staged.javaMajor}`, 100);
      await this.#setStatus(serverId, "stopped");
    } catch (err) {
      const message = errMessage(err);
      await agent.discardStaging(row.directory).catch(() => {});
      this.bus.publish({
        type: "install.progress",
        data: { serverId, at: Date.now(), step: "failed", message, percent: null },
      });
      this.bus.system(
        serverId,
        committed
          ? `The server now runs ${target}, but a later step failed: ${message}`
          : `Version change failed: ${message}. The server is unchanged.`,
      );
      await this.#setStatus(serverId, "stopped", { versionChangeError: message });
      return;
    } finally {
      this.#installing.delete(serverId);
      this.#reporters.delete(serverId);
    }

    await this.#gcJava(row.hostId);
    this.events.emit("versionChanged", serverId);
    if (wasRunning) {
      await this.start(serverId).catch((err) =>
        this.bus.system(serverId, `Could not start after the version change: ${err.message}`),
      );
    }
  }

  /** Copy the world folders into a snapshot tagged with the version that saved them. */
  async #snapshotWorld(row: ServerRow, mcVersion: string): Promise<VersionSnapshot | null> {
    const agent = this.agentOf(row);
    const stats = await agent.stat(row.directory, worldFolderNames(await this.levelName(row)));
    const folders = stats.filter((s) => s.exists && s.kind === "dir").map((s) => s.path);
    if (folders.length === 0) return null; // no world generated yet

    const createdAt = nowIso();
    const id = `${createdAt.replace(/[:.]/g, "-")}_${mcVersion.replace(/[^\w.-]/g, "_")}`;
    const dir = this.hostPath(row).join(this.#snapshotsDir(row), id);
    const copied = await agent.copyInto(row.directory, folders, dir);
    const snap: VersionSnapshot = {
      id,
      mcVersion,
      software: row.software as Server["software"],
      createdAt,
      sizeBytes: copied.sizeBytes,
      folders,
    };
    await agent.writeFile(dir, SNAPSHOT_MANIFEST, JSON.stringify(snap, null, 2));

    // Retention: newest snapshot per version, at most MAX_SNAPSHOTS overall.
    const all = await this.#listSnapshots(row);
    const seen = new Set<string>();
    const keep: string[] = [];
    for (const s of all) {
      if (seen.has(s.mcVersion) || keep.length >= MAX_SNAPSHOTS) {
        await agent.removeDir(this.hostPath(row).join(this.#snapshotsDir(row), s.id));
        continue;
      }
      seen.add(s.mcVersion);
      keep.push(s.id);
    }
    return snap;
  }

  async #restoreSnapshot(row: ServerRow, snap: VersionSnapshot): Promise<void> {
    const agent = this.agentOf(row);
    await agent.removePaths(row.directory, worldFolderNames(await this.levelName(row)));
    await agent.copyInto(
      this.hostPath(row).join(this.#snapshotsDir(row), snap.id),
      snap.folders,
      row.directory,
    );
  }

  async #listSnapshots(row: ServerRow): Promise<VersionSnapshot[]> {
    const agent = this.agentOf(row);
    const base = this.#snapshotsDir(row);
    const entries = await agent.listDir(base, "").catch(() => []);
    const out: VersionSnapshot[] = [];
    for (const e of entries) {
      if (e.kind !== "dir") continue;
      try {
        out.push(
          JSON.parse(
            await agent.readFile(base, `${e.name}/${SNAPSHOT_MANIFEST}`),
          ) as VersionSnapshot,
        );
      } catch {
        // incomplete snapshot (interrupted copy); ignored and removed with the server
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- Deletion ------------------------------------------------------------

  /** Everything the delete dialog needs: what can be kept, and what will be freed. */
  async deletePlan(serverId: string) {
    const row = await this.row(serverId);
    const agent = this.agentOf(row);
    const levelName = await this.levelName(row);
    const entries = await agent.listDir(row.directory, "").catch(() => []);
    const stats = await agent.stat(
      row.directory,
      entries.map((e) => e.name),
    );
    const byCat = new Map<BackupCategory, DeletePlanCategory>();
    let serverFilesBytes = 0;
    for (const e of entries) {
      const st = stats.find((s) => s.path === e.name);
      const size = st?.sizeBytes ?? 0;
      serverFilesBytes += size;
      const cat = classifyEntry(e.name, e.kind, levelName);
      if (cat === "downloaded") continue;
      const c = byCat.get(cat) ?? {
        id: cat,
        label: CATEGORY_LABELS[cat],
        paths: [],
        sizeBytes: 0,
        files: 0,
        selected: DEFAULT_EXPORT.includes(cat),
      };
      c.paths.push(e.name);
      c.sizeBytes += size;
      c.files += st?.files ?? 0;
      byCat.set(cat, c);
    }
    const layout = this.hosts.layout(row.hostId);
    const [snapStat] = await agent.stat(layout.backupsDir, [row.id]);
    if (snapStat?.exists && snapStat.files > 0) {
      byCat.set("snapshots", {
        id: "snapshots",
        label: CATEGORY_LABELS.snapshots,
        paths: [],
        sizeBytes: snapStat.sizeBytes,
        files: snapStat.files,
        selected: false,
      });
    }

    const others = (await this.db.select().from(servers)).filter((r) => r.id !== row.id);
    // Java runtimes are shared by the servers of one host.
    const javaUsers = others.filter(
      (r) => r.hostId === row.hostId && r.javaVersion === row.javaVersion,
    ).length;
    const [javaStat] =
      row.javaVersion > 0 && javaUsers === 0
        ? await agent.stat(layout.javaDir, [String(row.javaVersion)]).catch(() => [])
        : [];
    const javaBytes = javaStat?.exists ? javaStat.sizeBytes : 0;
    const assetsDir = path.join(this.config.assetsDir, row.mcVersion);
    const assetUsers = others.filter((r) => r.mcVersion === row.mcVersion).length;
    const assets = fs.existsSync(assetsDir)
      ? {
          version: row.mcVersion,
          removed: assetUsers === 0,
          sizeBytes: assetUsers === 0 ? await dirSize(assetsDir) : 0,
        }
      : null;

    const order: BackupCategory[] = ["world", "addons", "config", "other", "logs", "snapshots"];
    return {
      name: row.name,
      running: ACTIVE.includes(row.status as ServerStatus) || this.#installing.has(row.id),
      categories: order.flatMap((id) => {
        const c = byCat.get(id);
        return c ? [c] : [];
      }),
      defaultDestination: this.#defaultExportDestination(row),
      /** Where an export ends up: this computer, or the remote host's disk. */
      exportsOnHost: row.hostId !== LOCAL_HOST_ID,
      freed: {
        serverFilesBytes,
        snapshotsBytes: snapStat?.exists ? snapStat.sizeBytes : 0,
        assets,
        java:
          row.javaVersion > 0
            ? {
                major: row.javaVersion,
                removed: javaUsers === 0,
                sizeBytes: javaBytes,
                usedBy: javaUsers,
              }
            : null,
      },
    };
  }

  /**
   * Delete a server and every file that belongs to it: the server folder,
   * backups, world snapshots from version changes, and any Java runtime no
   * other server needs. With `backup`, selected files are copied out first and
   * verified; if the copy fails nothing is deleted.
   */
  async remove(serverId: string, backup: DeleteServerInput["backup"]) {
    const row = await this.row(serverId);
    this.assertIdle(row);
    const agent = this.agentOf(row);
    const agentStatus = await agent.status(serverId);
    if (ACTIVE.includes(row.status as ServerStatus) || ACTIVE.includes(agentStatus))
      throw new ServerError("BAD_STATE", "Stop the server before deleting it");

    let destination: string | null = null;
    if (backup) {
      try {
        destination = this.#validateExportDestination(row, backup.destination);
      } catch (err) {
        if (err instanceof DestinationError) {
          throw new ServerError("VALIDATION", err.message, { destination: err.message });
        }
        throw err;
      }
    }

    this.#deleting.add(serverId);
    await this.#setMeta(serverId, { deletingSince: nowIso() });
    let exported: { path: string; files: number; sizeBytes: number } | null = null;
    try {
      // A sleeping server holds its port and a pending restart would bring it back.
      if (agentStatus === "sleeping" || agentStatus === "crashed") await agent.stop(serverId);
      if (backup && destination) {
        exported = await this.#export(row, backup.include, destination);
      }
      const plan = await this.deletePlan(serverId).catch(() => null);
      const hp = this.hostPath(row);
      await agent.removeDir(this.serverBackupsDir(row));
      await agent.removeDir(row.directory);
      const leftovers = [
        ...(await agent.stat(hp.dirname(row.directory), [hp.basename(row.directory)])),
        ...(await agent.stat(this.hosts.layout(row.hostId).backupsDir, [row.id])),
      ].filter((s) => s.exists);
      if (leftovers.length > 0) {
        throw new Error(
          `Some files could not be deleted: ${leftovers.map((l) => l.path).join(", ")}`,
        );
      }
      // Backups, schedules and player history rows go with it (ON DELETE CASCADE).
      await this.db.delete(servers).where(eq(servers.id, serverId));
      this.bus.forget(serverId);
      this.#deleting.delete(serverId);
      this.events.emit("removed", serverId);
      const removedJava = await this.#gcJava(row.hostId);
      return {
        exported,
        freedBytes:
          (plan?.freed.serverFilesBytes ?? 0) +
          (plan?.freed.snapshotsBytes ?? 0) +
          (plan?.freed.assets?.removed ? plan.freed.assets.sizeBytes : 0) +
          removedJava.reduce((n, j) => n + j.sizeBytes, 0),
        removedJava,
      };
    } catch (err) {
      await this.#setMeta(serverId, { deletingSince: null }).catch(() => {});
      const message = errMessage(err);
      throw new ServerError(
        "BAD_STATE",
        exported ? `Backed up to ${exported.path}, but deleting failed: ${message}` : message,
      );
    } finally {
      this.#deleting.delete(serverId);
    }
  }

  async #export(
    row: ServerRow,
    include: BackupCategory[],
    destination: string,
  ): Promise<{ path: string; files: number; sizeBytes: number }> {
    const agent = this.agentOf(row);
    const plan = await this.deletePlan(row.id);
    const chosen = plan.categories.filter((c) => include.includes(c.id));
    const paths = chosen.filter((c) => c.id !== "snapshots").flatMap((c) => c.paths);
    const expected = chosen.reduce((n, c) => n + c.files, 0);

    let files = 0;
    let sizeBytes = 0;
    const main = await agent.copyInto(row.directory, paths, destination);
    files += main.files;
    sizeBytes += main.sizeBytes;
    if (include.includes("snapshots")) {
      // Backup zips and version snapshots, as they are stored.
      const root = this.serverBackupsDir(row);
      const names = (await agent.listDir(root, "").catch(() => [])).map((e) => e.name);
      const copied = await agent.copyInto(
        root,
        names,
        this.hostPath(row).join(destination, "cubehold-backups"),
      );
      files += copied.files;
      sizeBytes += copied.sizeBytes;
    }
    if (files !== expected) {
      throw new Error(
        `Backup incomplete (${files} of ${expected} files copied). Nothing was deleted.`,
      );
    }
    await agent.writeFile(
      destination,
      "cubehold-export.txt",
      [
        `Exported by cubehold on ${new Date().toString()}`,
        `Server: ${row.name}`,
        `Software: ${row.software} ${row.mcVersion} (Java ${row.javaVersion})`,
        `Contents: ${chosen.map((c) => c.label).join("; ")}`,
        `Files: ${files}, ${sizeBytes} bytes`,
        "",
        "To run this world again, create a new server with the same software and version,",
        "stop it, and copy these folders into its server folder.",
        "",
      ].join("\n"),
    );
    return { path: destination, files, sizeBytes };
  }

  // --- Shared with the other server services ---------------------------------

  async row(serverId: string): Promise<ServerRow> {
    const row = await this.db.select().from(servers).where(eq(servers.id, serverId)).get();
    if (!row) throw new ServerError("NOT_FOUND", "Server not found");
    return row;
  }

  agentOf(row: ServerRow): AgentApi {
    return this.hosts.agentFor(row.hostId);
  }

  /** The agent connection, for streamed uploads and downloads. */
  remoteOf(row: ServerRow): RemoteAgent {
    return this.hosts.remoteFor(row.hostId);
  }

  /** Throw unless nothing exclusive (install, version change, delete, restore) is running. */
  assertIdle(row: ServerRow): void {
    if (this.#deleting.has(row.id) || row.meta?.deletingSince)
      throw new ServerError("BAD_STATE", "This server is being deleted");
    if (this.#installing.has(row.id))
      throw new ServerError(
        "BAD_STATE",
        "Wait for the current install or version change to finish",
      );
    const busy = this.#busy.get(row.id);
    if (busy) throw new ServerError("BAD_STATE", `Wait for ${busy} to finish`);
  }

  /** Run fn while holding the server's exclusive lock (other jobs get a clear error). */
  async exclusive<T>(serverId: string, label: string, fn: () => Promise<T>): Promise<T> {
    this.assertIdle(await this.row(serverId));
    this.#busy.set(serverId, label);
    try {
      return await fn();
    } finally {
      this.#busy.delete(serverId);
    }
  }

  isBusy(serverId: string): boolean {
    return (
      this.#installing.has(serverId) || this.#deleting.has(serverId) || this.#busy.has(serverId)
    );
  }

  async levelName(row: ServerRow): Promise<string> {
    try {
      return (await this.#readProperties(row)).get("level-name")?.trim() || "world";
    } catch {
      return "world";
    }
  }

  /** Backups and version snapshots of a server, on its host. */
  serverBackupsDir(row: Pick<ServerRow, "id" | "hostId">): string {
    const layout = this.hosts.layout(row.hostId);
    return layout.path.join(layout.backupsDir, row.id);
  }

  #defaultExportDestination(row: ServerRow): string {
    if (row.hostId === LOCAL_HOST_ID) return defaultExportDestination(row.name);
    const layout = this.hosts.layout(row.hostId);
    return layout.path.join(layout.exportsDir, exportName(row.name));
  }

  /**
   * Exports of local servers may go anywhere on this computer (checked on
   * disk). On a remote host they stay under its exports folder: the panel
   * cannot check or browse that disk the same way.
   */
  #validateExportDestination(row: ServerRow, destination: string): string {
    if (row.hostId === LOCAL_HOST_ID) {
      return validateExportDestination(destination, this.config.DATA_DIR);
    }
    const layout = this.hosts.layout(row.hostId);
    const p = layout.path;
    const resolved = p.resolve(destination.trim());
    if (!p.isAbsolute(destination.trim()) || !resolved.startsWith(`${layout.exportsDir}/`)) {
      throw new DestinationError(`On this host, exports go inside ${layout.exportsDir}`);
    }
    return resolved;
  }

  async setStatus(serverId: string, status: ServerStatus): Promise<void> {
    await this.#setStatus(serverId, status);
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Everything the agent needs to run the server: Java, flags, RCON (set up
   * in server.properties first), the GC log for heap readings, and the
   * automation policy.
   */
  async #launchRequest(row: ServerRow): Promise<{ req: LaunchRequest; javaName: string }> {
    // A runtime removed by hand (or a server moved here) is downloaded again first.
    let lastLogged = "";
    this.#reporters.set(row.id, (_step, message, percent) => {
      if ((percent === null || percent === 100) && message !== lastLogged) {
        lastLogged = message;
        this.bus.system(row.id, message);
      }
    });
    let java: { javaPath: string; releaseName: string | null };
    try {
      java = await this.agentOf(row).ensureJava(row.javaVersion, row.id);
    } finally {
      if (!this.#installing.has(row.id)) this.#reporters.delete(row.id);
    }
    const rcon = await this.#ensureRcon(row);
    const software = row.software as Server["software"];
    const jarFile = row.settings?.jarFile ?? "server.jar";
    const windowsHost = this.hosts.layout(row.hostId).path.sep === "\\";
    const args = buildJavaArgs({
      software,
      memoryMb: row.memoryMb,
      jarFile,
      ...(row.settings?.launch === "argsFile"
        ? { argsFile: `${jarFile}/${windowsHost ? "win" : "unix"}_args.txt` }
        : {}),
      recommendedJvmFlags: row.settings?.recommendedJvmFlags ?? null,
      extraJvmArgs: row.settings?.extraJvmArgs ?? [],
      javaMajor: row.javaVersion,
      managedArgs: [
        ...(await this.#log4jArgs(row)),
        ...geyserArgs(await this.bedrockPort(row, true)),
      ],
    });
    return {
      javaName: java.releaseName ?? java.javaPath,
      req: {
        serverId: row.id,
        directory: row.directory,
        javaPath: java.javaPath,
        args,
        software,
        memoryMb: row.memoryMb,
        mcVersion: row.mcVersion,
        port: row.port,
        rcon,
        tpsCommand: tpsCommandFor(software, row.mcVersion),
        gcLog: row.javaVersion >= 9 ? GC_LOG_FILE : null,
        policy: await this.#policy(row),
      },
    };
  }

  /**
   * Give the server an RCON port and a random password, and write them to
   * server.properties. The port is unique among this host's servers and
   * checked free; the password is 64 hex characters and never leaves the panel.
   */
  async #ensureRcon(row: ServerRow): Promise<{ port: number; password: string }> {
    const agent = this.agentOf(row);
    const siblings = await this.db
      .select({ id: servers.id, port: servers.port, settings: servers.settings })
      .from(servers)
      .where(eq(servers.hostId, row.hostId));
    const taken = new Set<number>();
    for (const s of siblings) {
      if (s.id === row.id) continue;
      taken.add(s.port);
      if (s.settings?.rcon) taken.add(s.settings.rcon.port);
    }
    taken.add(row.port);

    let rcon = row.settings?.rcon;
    const usable = async (port: number) =>
      !taken.has(port) && (await agent.busyPorts([port])).length === 0;
    if (!rcon || !(await usable(rcon.port))) {
      let port: number | null = null;
      for (let p = RCON_BASE_PORT; p < RCON_BASE_PORT + 2000; p++) {
        if (await usable(p)) {
          port = p;
          break;
        }
      }
      if (port === null) throw new ServerError("BAD_STATE", "No free port for RCON");
      rcon = { port, password: rcon?.password ?? randomBytes(32).toString("hex") };
      await this.#setSettings(row.id, { rcon });
    }
    await this.#patchProperties(row, rconProperties(rcon));
    return rcon;
  }

  /**
   * Mojang's log4j config for old vanilla and Fabric versions (Log4Shell),
   * downloaded into the server folder once, verified by its SHA-1.
   */
  async #log4jArgs(row: ServerRow): Promise<string[]> {
    const fix = log4jMitigation(row.software as Server["software"], row.mcVersion);
    if (!fix.file) return fix.args;
    const agent = this.agentOf(row);
    const [st] = await agent.stat(row.directory, [fix.file.name]);
    if (!st?.exists) {
      await agent.fetchUrl({
        url: fix.file.url,
        root: row.directory,
        relPath: fix.file.name,
        sha1: fix.file.sha1,
      });
      this.bus.system(
        row.id,
        `Added Mojang's Log4Shell fix (${fix.file.name}) for Minecraft ${row.mcVersion}.`,
      );
    }
    return fix.args;
  }

  /**
   * Geyser's Bedrock (UDP) port when Geyser is installed, unique among this
   * host's servers from 19132 up. With `allocate`, a server that has Geyser
   * but no port yet gets one.
   */
  async bedrockPort(row: ServerRow, allocate: boolean): Promise<number | null> {
    const folder = row.software === "fabric" ? "mods" : "plugins";
    const entries = await this.agentOf(row)
      .listDir(row.directory, folder)
      .catch(() => []);
    const hasGeyser = entries.some((e) => e.kind === "file" && /^geyser.*\.jar$/i.test(e.name));
    if (!hasGeyser) return null;
    const current = row.settings?.bedrockPort ?? null;
    if (current || !allocate) return current;
    const siblings = await this.db
      .select({ id: servers.id, settings: servers.settings })
      .from(servers)
      .where(eq(servers.hostId, row.hostId));
    const taken = new Set(
      siblings.filter((s) => s.id !== row.id).map((s) => s.settings?.bedrockPort ?? 0),
    );
    let port = BEDROCK_BASE_PORT;
    while (taken.has(port)) port++;
    await this.#setSettings(row.id, { bedrockPort: port });
    this.events.emit("changed", row.id);
    return port;
  }

  async #assertPortAvailable(
    hostId: string,
    port: number,
    selfId: string | null,
    checkHost = true,
  ): Promise<void> {
    const rows = await this.db
      .select({
        id: servers.id,
        name: servers.name,
        port: servers.port,
        settings: servers.settings,
      })
      .from(servers)
      .where(eq(servers.hostId, hostId));
    for (const r of rows) {
      if (r.id === selfId) continue;
      if (r.port === port || r.settings?.rcon?.port === port) {
        throw new ServerError(
          "CONFLICT",
          `Port ${port} is already used by "${r.name}" on this host`,
          { port: "In use by another server" },
        );
      }
    }
    if (checkHost && (await this.hosts.agentFor(hostId).busyPorts([port])).length > 0) {
      throw new ServerError(
        "CONFLICT",
        `Port ${port} is taken by another program on this machine`,
        { port: "In use by another program" },
      );
    }
  }

  async #assertMemoryFits(agent: AgentApi, heapMb: number): Promise<void> {
    const info = await agent.hostInfo();
    const needed = estimateProcessMemoryMb(heapMb);
    if (needed > info.totalMemMb - HOST_RESERVE_MB) {
      throw new ServerError(
        "VALIDATION",
        `A ${heapMb} MB heap needs about ${needed} MB in total with Java's own overhead; this host has ${info.totalMemMb} MB and ${HOST_RESERVE_MB} MB stays free for the system.`,
        { memoryMb: "Too much for this host" },
      );
    }
  }

  /**
   * Remove Java runtimes no server on a host needs any more. Runtimes are
   * shared per host, so one is only deleted when the last server using it is
   * gone, moved, or on another version. Skipped while an install or version
   * change runs on that host, since a runtime may be mid-download for it.
   */
  async #gcJava(hostId: string): Promise<Array<{ major: number; sizeBytes: number }>> {
    const rows = await this.db
      .select({ id: servers.id, javaVersion: servers.javaVersion })
      .from(servers)
      .where(eq(servers.hostId, hostId));
    if (rows.some((r) => this.#installing.has(r.id))) return [];
    const keep = [...new Set(rows.map((r) => r.javaVersion).filter((v) => v > 0))];
    try {
      const removed = await this.hosts.agentFor(hostId).gcJava(keep);
      for (const r of removed) {
        console.log(
          `[java] removed unused Java ${r.major} runtime on ${hostId} (${r.sizeBytes} bytes)`,
        );
      }
      return removed;
    } catch (err) {
      console.warn(`[java] could not clean up runtimes on ${hostId}:`, errMessage(err));
      return [];
    }
  }

  async #install(serverId: string): Promise<void> {
    if (this.#installing.has(serverId)) return;
    this.#installing.add(serverId);
    const row = await this.row(serverId);
    const agent = this.agentOf(row);
    await this.#setStatus(serverId, "installing", { installError: null });
    const report = this.#reporter(serverId);
    try {
      await agent.makeDir(row.directory, "");
      const staged = await agent.stageBinaries({
        serverId,
        directory: row.directory,
        software: row.software as Server["software"],
        mcVersion: row.mcVersion,
        ...(row.settings?.loaderVersion ? { loaderVersion: row.settings.loaderVersion } : {}),
      });
      await agent.commitBinaries(row.directory, staged, row.settings?.jarFile);
      report("configure", "Writing eula.txt and server.properties", null);
      await agent.writeInitialFiles({
        directory: row.directory,
        port: row.port,
        name: row.name,
        onlineMode: row.settings?.onlineMode ?? true,
      });
      const after = this.#afterInstall.get(serverId);
      if (after) {
        await after({ row, agent: this.hosts.remoteFor(row.hostId), report });
        this.#afterInstall.delete(serverId);
      }
      await this.db
        .update(servers)
        .set({
          javaVersion: staged.javaMajor,
          settings: {
            ...(row.settings ?? {}),
            jarFile: staged.jarFile,
            launch: staged.launch ?? "jar",
            build: staged.build,
            recommendedJvmFlags: staged.recommendedJvmFlags,
          },
          updatedAt: nowIso(),
        })
        .where(eq(servers.id, serverId));
      report("done", "Installation complete", 100);
      await this.#setStatus(serverId, "stopped");
    } catch (err) {
      const message = errMessage(err);
      await agent.discardStaging(row.directory).catch(() => {});
      this.bus.publish({
        type: "install.progress",
        data: { serverId, at: Date.now(), step: "failed", message, percent: null },
      });
      this.bus.system(serverId, `Installation failed: ${message}`);
      await this.#setStatus(serverId, "stopped", { installError: message });
      throw new ServerError("BAD_STATE", `Installation failed: ${message}`);
    } finally {
      this.#installing.delete(serverId);
      this.#reporters.delete(serverId);
      await this.#gcJava(row.hostId);
    }
  }

  /** Progress of an install or version change, also fed by the agent's "install" events. */
  #reporter(serverId: string): InstallReporter {
    let lastLogged = "";
    const report: InstallReporter = (step, message, percent) => {
      this.bus.publish({
        type: "install.progress",
        data: { serverId, at: Date.now(), step, message, percent },
      });
      // Progress messages repeat rapidly during downloads; only log milestones to the console.
      if ((percent === null || percent === 100) && message !== lastLogged) {
        lastLogged = message;
        this.bus.system(serverId, message);
      }
    };
    this.#reporters.set(serverId, report);
    return report;
  }

  async #onAgentEvent(ev: AgentEvent): Promise<void> {
    if (ev.type === "progress") {
      this.tasks.get(ev.taskId)?.bytes(ev.done, ev.total);
      return;
    }
    if (ev.type === "install") {
      this.#reporters.get(ev.serverId)?.(ev.step, ev.message, ev.percent);
      return;
    }
    // While files are being swapped or deleted, this service owns the status.
    const locked = this.#installing.has(ev.serverId) || this.#deleting.has(ev.serverId);
    switch (ev.type) {
      case "line":
        this.bus.publish({
          type: "console.line",
          data: { serverId: ev.serverId, at: ev.at, line: ev.line, stream: ev.stream },
        });
        break;
      case "status":
        if (!locked) await this.#setStatus(ev.serverId, ev.status);
        break;
      case "exit": {
        this.events.emit("stopped", ev.serverId);
        if (ev.stoppedBy === "idle") this.events.emit("idleStopped", ev.serverId);
        const meta: Partial<ServerMeta> = {
          lastExitCode: ev.code,
          lastExitReason: ev.reason,
          lastStoppedAt: nowIso(),
        };
        if (locked) {
          await this.#setMeta(ev.serverId, meta);
          break;
        }
        const crashed = !ev.expected && ev.code !== 0;
        if (crashed) {
          const record = await this.#crashRecord(ev);
          const row = await this.db
            .select({ meta: servers.meta })
            .from(servers)
            .where(eq(servers.id, ev.serverId))
            .get();
          meta.crashes = [...(row?.meta?.crashes ?? []), record].slice(-MAX_CRASHES);
          this.bus.system(
            ev.serverId,
            `Crash: ${record.analysis?.title ?? "stopped unexpectedly"}. ${record.analysis?.hint ?? ""}`.trim(),
          );
        } else {
          const hint = exitHint(ev.reason, ev.code);
          if (hint) this.bus.system(ev.serverId, hint);
        }
        await this.#setStatus(
          ev.serverId,
          ev.expected || ev.code === 0 ? "stopped" : "crashed",
          meta,
        );
        break;
      }
      case "players":
        this.bus.publish({
          type: "players.changed",
          data: { serverId: ev.serverId, at: ev.at, players: ev.players },
        });
        this.events.emit("players", ev.serverId, ev.players);
        break;
      case "metrics": {
        const row = await this.db
          .select({ memoryMb: servers.memoryMb })
          .from(servers)
          .where(eq(servers.id, ev.serverId))
          .get();
        this.bus.publish({
          type: "metrics.tick",
          data: {
            serverId: ev.serverId,
            at: ev.at,
            cpuPercent: Math.round(ev.cpuPercent * 10) / 10,
            memUsedMb: Math.round(ev.memRssMb),
            memMaxMb: row?.memoryMb ?? 0,
            heapUsedMb: ev.heapUsedMb,
            tps: ev.tps === null ? null : Math.round(ev.tps * 100) / 100,
            mspt: ev.mspt === null ? null : Math.round(ev.mspt * 100) / 100,
            playersOnline: this.bus.snapshot(ev.serverId).players.length,
          },
        });
        break;
      }
    }
  }

  /** Explain a crash from its report, or from the last console lines when there is none. */
  async #crashRecord(ev: Extract<AgentEvent, { type: "exit" }>): Promise<CrashRecord> {
    let text = "";
    if (ev.crashReport) {
      try {
        const row = await this.row(ev.serverId);
        text = await this.agentOf(row).readFile(row.directory, ev.crashReport, 4 * 1024 * 1024);
      } catch {
        text = "";
      }
    }
    if (!text) {
      const tail = this.bus
        .snapshot(ev.serverId)
        .console.slice(-200)
        .filter((l) => l.stream !== "system")
        .map((l) => l.line.replace(ANSI, ""));
      text = errorLines(tail).join("\n");
    }
    const a = text ? analyzeCrash(text) : unexplainedExit(ev.code);
    return {
      at: nowIso(),
      code: ev.code,
      reason: ev.reason,
      report: ev.crashReport,
      restartInMs: ev.restartInMs,
      analysis: {
        cause: a.cause,
        title: a.title,
        hint: a.hint,
        suspects: a.suspects,
        exception: a.exception,
      },
    };
  }

  /**
   * server.properties as text. Empty only when the file does not exist yet;
   * any other failure throws, so callers never mistake an error for an empty file.
   */
  async #readPropertiesText(row: ServerRow): Promise<string> {
    const agent = this.agentOf(row);
    const [st] = await agent.stat(row.directory, ["server.properties"]);
    if (!st?.exists) return "";
    try {
      return await agent.readFile(row.directory, "server.properties");
    } catch (err) {
      throw new ServerError("BAD_STATE", `Could not read server.properties: ${errMessage(err)}`);
    }
  }

  async #readProperties(row: ServerRow): Promise<Map<string, string>> {
    return propertiesToMap(parseProperties(await this.#readPropertiesText(row)));
  }

  /** Set keys in server.properties, keeping comments, order and every other key. */
  async #patchProperties(row: ServerRow, values: Record<string, PropertyValue>): Promise<void> {
    // Never rebuild the file from a failed read: that would drop every other setting.
    const text = await this.#readPropertiesText(row);
    const next = serializeProperties(applyProperties(parseProperties(text), values));
    if (next !== text) await this.agentOf(row).writeFile(row.directory, "server.properties", next);
  }

  #snapshotsDir(row: Pick<ServerRow, "id" | "hostId">): string {
    return this.hostPath(row).join(this.serverBackupsDir(row), "versions");
  }

  /** Path functions for the server's host (POSIX on a Linux VPS, whatever the panel runs on). */
  hostPath(row: Pick<ServerRow, "hostId">): HostLayout["path"] {
    return this.hosts.layout(row.hostId).path;
  }

  async #setStatus(
    serverId: string,
    status: ServerStatus,
    meta?: Partial<ServerMeta>,
  ): Promise<void> {
    const row = await this.db
      .select({ meta: servers.meta })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (!row) return;
    await this.db
      .update(servers)
      .set({
        status,
        meta: meta ? { ...(row.meta ?? {}), ...meta } : row.meta,
        updatedAt: nowIso(),
      })
      .where(eq(servers.id, serverId));
    this.bus.setStatus(serverId, status);
  }

  async #setMeta(serverId: string, meta: Partial<ServerMeta>): Promise<void> {
    const row = await this.db
      .select({ meta: servers.meta })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (!row) return;
    await this.db
      .update(servers)
      .set({ meta: { ...(row.meta ?? {}), ...meta }, updatedAt: nowIso() })
      .where(eq(servers.id, serverId));
  }

  /**
   * Cloud hosts: `gate` returns false when it is booting the VM and will call
   * start() again itself; `powersDown` tells whether the VM turns off when
   * the server idles, which rules out waiting for players on the port.
   */
  setCloudHooks(hooks: {
    gate: (row: ServerRow) => Promise<boolean>;
    powersDown: (row: ServerRow) => Promise<boolean>;
  }): void {
    this.#startGate = hooks.gate;
    this.#vmPowersDown = hooks.powersDown;
  }

  async #policy(row: ServerRow): Promise<AgentPolicy> {
    const a = automationOf(row);
    const down = a.vmIdle !== "keep" && (await this.#vmPowersDown?.(row)) === true;
    return policyOf(a, down);
  }

  /** Throws a CONFLICT when the port is used by another server on the host or by another program. */
  assertPortFree(hostId: string, port: number, selfId: string | null): Promise<void> {
    return this.#assertPortAvailable(hostId, port, selfId);
  }

  /** Throws a VALIDATION error when the heap (plus JVM overhead) does not fit the host. */
  async assertMemoryFitsHost(hostId: string, heapMb: number): Promise<void> {
    await this.#assertMemoryFits(this.hosts.agentFor(hostId), heapMb);
  }

  async patchProperties(row: ServerRow, values: Record<string, PropertyValue>): Promise<void> {
    await this.#patchProperties(row, values);
  }

  /** Remove Java runtimes no server on the host needs (after a server left it). */
  gcJava(hostId: string) {
    return this.#gcJava(hostId);
  }

  /** Merge panel-side settings (network flags and the like) into the server row. */
  updateSettings(serverId: string, settings: Partial<NonNullable<ServerRow["settings"]>>) {
    return this.#setSettings(serverId, settings);
  }

  async #setSettings(serverId: string, settings: Partial<NonNullable<ServerRow["settings"]>>) {
    const row = await this.db
      .select({ settings: servers.settings })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (!row) return;
    await this.db
      .update(servers)
      .set({ settings: { ...(row.settings ?? {}), ...settings }, updatedAt: nowIso() })
      .where(eq(servers.id, serverId));
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** RCON keys are written by the panel before every start; editing them would only break it. */
function isManagedKey(key: string): boolean {
  return key === "enable-rcon" || key.startsWith("rcon.") || key === "broadcast-rcon-to-ops";
}

function automationOf(row: ServerRow): ServerAutomation {
  return { ...DEFAULT_AUTOMATION, ...(row.settings?.automation ?? {}) };
}

/** What the agent does by itself. A VM that powers down when idle cannot wait for players. */
function policyOf(a: ServerAutomation, vmPowersDown: boolean): AgentPolicy {
  return {
    autoRestart: a.autoRestart,
    idleStopMinutes: a.idleStopMinutes,
    wakeOnJoin: a.idleStopMinutes > 0 && a.wakeOnJoin && !vmPowersDown,
  };
}

function exitHint(reason: string | null, code: number | null): string | null {
  switch (reason) {
    case "eula":
      return "The server refused to start because the EULA is not accepted. Check eula.txt.";
    case "port_in_use":
      return "The port is already in use. Stop whatever is listening on it or change the port in Settings.";
    case "outdated_java":
      return "The Java runtime is too old for this Minecraft version. Delete the runtime under data/java and start again to re-download.";
    default:
      return code && code !== 0 ? `Java exited with code ${code}.` : null;
  }
}

function toApi(row: ServerRow): Server {
  return {
    id: row.id,
    hostId: row.hostId,
    name: row.name,
    software: row.software as Server["software"],
    mcVersion: row.mcVersion,
    javaVersion: row.javaVersion,
    memoryMb: row.memoryMb,
    port: row.port,
    status: row.status as ServerStatus,
    onlineMode: row.settings?.onlineMode ?? true,
    createdAt: row.createdAt,
  };
}
