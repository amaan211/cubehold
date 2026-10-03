import { gunzipSync } from "node:zlib";
import {
  type BanEntry,
  banDate,
  countAdvancements,
  type IpBanEntry,
  isValidIp,
  isValidPlayerName,
  lookupPlayer,
  type NbtCompound,
  normalizePlayer,
  type OpEntry,
  offlineUuid,
  PLAYER_LIST_FILES,
  type PlayerState,
  parseDataReply,
  parseNbt,
  playerFileDirs,
  summarizeStats,
  type UsercacheEntry,
  usesPlayersFolder,
  type WhitelistEntry,
} from "@cubehold/mc";
import type {
  PlayerActionInput,
  PlayerCommand,
  PlayerDetails,
  PlayerStatsView,
} from "@cubehold/shared";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, schema } from "../db/index.js";
import type { RealtimeBus } from "../realtime/bus.js";
import { errMessage, nowIso, ServerError, type ServerRow, type ServerService } from "./service.js";

const { playerSessions } = schema;

export interface KnownPlayer {
  name: string;
  /** False when only the UUID is known (the server forgot the name); `name` is then the UUID. */
  named: boolean;
  uuid: string | null;
  online: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  /** From the game's own statistics when available, else from the panel's sessions. */
  playtimeMs: number;
  deaths: number | null;
  /** Times joined: the panel's sessions, or the game's leave count if higher. */
  sessions: number;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
}

/** What the game keeps per player on disk: last save time and statistics. */
interface GameRecord {
  uuid: string;
  savedAt: string | null;
  stats: PlayerStatsView | null;
}

const GAME_RECORDS_TTL_MS = 30_000;
/** Read live with /data get: each fits in the server's shortened output. */
const LIVE_FIELDS = [
  "Health",
  "AbsorptionAmount",
  "foodLevel",
  "foodSaturationLevel",
  "XpLevel",
  "XpP",
  "XpTotal",
  "playerGameType",
  "SelectedItemSlot",
  "Pos",
  "Dimension",
  "respawn",
  "SpawnX",
  "SpawnY",
  "SpawnZ",
  "SpawnDimension",
  "LastDeathLocation",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Online players, player history and the server's player lists (ops,
 * whitelist, bans). Changes go through commands while the server runs, so
 * the server stays the source of truth, and straight into the JSON files
 * while it is stopped.
 */
export class PlayerService {
  /** serverId → (name → open session row id). Loaded from the DB on first use. */
  #open = new Map<string, Map<string, number>>();
  /** Per-server queue so join/leave bookkeeping never interleaves. */
  #queue = new Map<string, Promise<void>>();
  #records = new Map<string, { at: number; data: Map<string, GameRecord> }>();
  #lastSave = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly bus: RealtimeBus,
  ) {
    servers.events.on("players", (id, players) =>
      this.#enqueue(id, () => this.#track(id, players)),
    );
    servers.events.on("stopped", (id) => this.#enqueue(id, () => this.#track(id, [])));
    servers.events.on("removed", (id) => {
      this.#open.delete(id);
      this.#records.delete(id);
    });
  }

  async overview(serverId: string) {
    const row = await this.servers.row(serverId);
    const agent = this.servers.agentOf(row);
    const read = async <T>(file: string): Promise<T[]> => {
      try {
        const parsed = JSON.parse(await agent.readFile(row.directory, file)) as unknown;
        return Array.isArray(parsed) ? (parsed as T[]) : [];
      } catch {
        return []; // not created yet
      }
    };
    const [ops, whitelist, bans, ipBans, usercache] = await Promise.all([
      read<OpEntry>(PLAYER_LIST_FILES.ops),
      read<WhitelistEntry>(PLAYER_LIST_FILES.whitelist),
      read<BanEntry>(PLAYER_LIST_FILES.bans),
      read<IpBanEntry>(PLAYER_LIST_FILES.ipBans),
      read<UsercacheEntry>(PLAYER_LIST_FILES.usercache),
    ]);
    const props = await this.servers.getProperties(serverId);
    const online = this.bus.snapshot(serverId).players;
    const running = this.bus.snapshot(serverId).status === "running";

    // History: the panel's session log, plus everyone the game has saved data for
    // (which also covers players from before the panel was tracking).
    const sessions = await this.db
      .select()
      .from(playerSessions)
      .where(eq(playerSessions.serverId, serverId));
    const now = Date.now();
    const byName = new Map<string, KnownPlayer>();
    const lower = (s: string) => s.toLowerCase();
    const entry = (name: string, named = true): KnownPlayer => {
      const key = lower(name);
      let p = byName.get(key);
      if (!p) {
        p = {
          name,
          named,
          uuid: named ? null : name,
          online: false,
          firstSeen: null,
          lastSeen: null,
          playtimeMs: 0,
          deaths: null,
          sessions: 0,
          op: false,
          whitelisted: false,
          banned: false,
        };
        byName.set(key, p);
      }
      return p;
    };
    for (const s of sessions) {
      const p = entry(s.name);
      p.sessions++;
      const end = s.leftAt ? Date.parse(s.leftAt) : now;
      p.playtimeMs += Math.max(0, end - Date.parse(s.joinedAt));
      if (!p.firstSeen || s.joinedAt < p.firstSeen) p.firstSeen = s.joinedAt;
      const last = s.leftAt ?? new Date(now).toISOString();
      if (!p.lastSeen || last > p.lastSeen) p.lastSeen = last;
    }
    for (const name of online) entry(name).online = true;
    const nameOf = new Map(usercache.map((u) => [u.uuid.toLowerCase(), u.name]));
    for (const rec of (await this.#gameRecords(row)).values()) {
      const name = nameOf.get(rec.uuid);
      const p = name ? entry(name) : entry(rec.uuid, false);
      p.uuid = rec.uuid;
      if (rec.stats) {
        p.playtimeMs = Math.max(p.playtimeMs, rec.stats.playTimeMs);
        p.deaths = rec.stats.deaths;
        p.sessions = Math.max(p.sessions, rec.stats.timesLeft + (p.online ? 1 : 0));
      }
      if (rec.savedAt && !p.online && (!p.lastSeen || rec.savedAt > p.lastSeen))
        p.lastSeen = rec.savedAt;
    }
    // usercache also holds names looked up for the whitelist or ops, so it only adds UUIDs.
    for (const u of usercache) {
      const p = byName.get(lower(u.name));
      if (p && !p.uuid) p.uuid = u.uuid;
    }
    const opSet = new Set(ops.map((o) => lower(o.name)));
    const wlSet = new Set(whitelist.map((w) => lower(w.name)));
    const banSet = new Set(bans.map((b) => lower(b.name)));
    for (const p of byName.values()) {
      p.op = opSet.has(lower(p.name));
      p.whitelisted = wlSet.has(lower(p.name));
      p.banned = banSet.has(lower(p.name));
    }
    const known = [...byName.values()].sort(
      (a, b) =>
        Number(b.online) - Number(a.online) || (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""),
    );

    return {
      running,
      online,
      onlineMode: props.values["online-mode"] !== false,
      whitelistEnabled: props.values["white-list"] === true,
      ops,
      whitelist,
      bans,
      ipBans,
      known,
    };
  }

  async action(input: PlayerActionInput): Promise<{ live: boolean; reply: string | null }> {
    const row = await this.servers.row(input.serverId);
    this.servers.assertIdle(row);
    const ipAction = input.action === "ban_ip" || input.action === "pardon_ip";
    if (ipAction ? !isValidIp(input.target) : !isValidPlayerName(input.target)) {
      throw new ServerError(
        "VALIDATION",
        ipAction
          ? "Not a valid IP address"
          : "Player names are 1-16 letters, digits or underscores",
        { target: "Invalid" },
      );
    }
    const reason = input.reason?.replace(/[\r\n]+/g, " ").trim() || undefined;
    const running = this.bus.snapshot(row.id).status === "running";

    if (running) {
      const reply = await this.servers.command(
        row.id,
        commandFor(input.action, input.target, reason),
      );
      if (reply !== null)
        this.bus.system(row.id, `[players] ${reply.replace(/§./g, "") || "done"}`);
      return { live: true, reply: reply?.replace(/§./g, "") ?? null };
    }
    if (input.action === "kick")
      throw new ServerError("BAD_STATE", `${input.target} is not online`);
    await this.#editLists(row, input.action, input.target, reason);
    return { live: false, reply: null };
  }

  /** Turn the whitelist on or off, live when running. */
  async setWhitelist(serverId: string, enabled: boolean): Promise<void> {
    const running = this.bus.snapshot(serverId).status === "running";
    if (running) {
      await this.servers.command(serverId, `whitelist ${enabled ? "on" : "off"}`);
      return;
    }
    await this.servers.updateProperties(serverId, { "white-list": enabled });
  }

  /**
   * Everything about one player: live from the running server when they are
   * online (`data get entity` over RCON), otherwise from the game's last save
   * of their data, plus the game's statistics and the panel's session log.
   * `who` is a name, or a UUID for players whose name the server forgot.
   */
  async details(
    serverId: string,
    who: string,
    opts: { fresh?: boolean } = {},
  ): Promise<PlayerDetails> {
    const row = await this.servers.row(serverId);
    const agent = this.servers.agentOf(row);
    const dirs = await this.#playerDirs(row);
    const lists = await this.#lists(row);
    const snap = this.bus.snapshot(serverId);
    const byUuid = UUID.test(who);
    const lower = who.toLowerCase();

    let name: string = who;
    let uuid: string | null = byUuid ? lower : null;
    const cached = lists.usercache.find((u) =>
      byUuid ? u.uuid.toLowerCase() === lower : u.name.toLowerCase() === lower,
    );
    if (cached) {
      name = byUuid ? cached.name : who;
      uuid = cached.uuid.toLowerCase();
    }
    const onlineName = snap.players.find((p) => p.toLowerCase() === name.toLowerCase());
    const online = Boolean(onlineName) && snap.status === "running";
    if (onlineName) name = onlineName;

    if (!uuid && !byUuid) {
      const props = await this.servers.getProperties(serverId);
      uuid =
        props.values["online-mode"] === false
          ? offlineUuid(name)
          : ((await lookupPlayer(name).catch(() => null))?.uuid ?? null);
    }

    // Inventories only exist in full in the saved file (the server shortens
    // long /data output), so have the server save players first when online.
    const savedFrom = Date.now();
    const saved = online && (await this.#saveNow(serverId, opts.fresh ? 5_000 : 30_000));
    let nbt: NbtCompound | null = null;
    let source: PlayerDetails["source"] = "none";
    let savedAt: string | null = null;
    if (uuid) {
      // Paper may finish writing player files just after save-all answers; give it a moment.
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const file = await agent.readBinary(row.directory, `${dirs.data}/${uuid}.dat`);
          nbt = parseNbt(gunzipSync(Buffer.from(file.data, "base64")));
          source = "saved";
          savedAt = file.modifiedAt;
          if (!saved || Date.parse(file.modifiedAt) >= savedFrom - 1_000) break;
        } catch {
          nbt = null;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // Health, hunger, XP and position are small enough to read live.
    if (online) {
      const live = await this.#liveFields(serverId, name);
      if (Object.keys(live).length > 0) {
        nbt = { ...(nbt ?? {}), ...live };
        source = "live";
      }
    }
    const state: PlayerState | null = nbt ? normalizePlayer(nbt) : null;
    if (!uuid && state?.uuid) uuid = state.uuid;
    if (byUuid && state?.lastKnownName) name = state.lastKnownName;

    let stats: PlayerStatsView | null = null;
    let advancements: number | null = null;
    if (uuid) {
      const [statsFile, advFile] = await agent.readFiles(row.directory, [
        `${dirs.stats}/${uuid}.json`,
        `${dirs.advancements}/${uuid}.json`,
      ]);
      stats = parseJson(statsFile?.content, summarizeStats);
      advancements = parseJson(advFile?.content, countAdvancements);
    }

    const sessions = await this.db
      .select()
      .from(playerSessions)
      .where(and(eq(playerSessions.serverId, serverId), eq(playerSessions.name, name)));
    const same = (a: string) => a.toLowerCase() === name.toLowerCase();
    const ban = lists.bans.find((b) => same(b.name));
    const status = {
      op: lists.ops.some((o) => same(o.name)),
      whitelisted: lists.whitelist.some((w) => same(w.name)),
      banned: Boolean(ban),
      banReason: ban?.reason ?? null,
    };
    if (
      !state &&
      !stats &&
      sessions.length === 0 &&
      !status.op &&
      !status.whitelisted &&
      !status.banned
    ) {
      throw new ServerError("NOT_FOUND", `${who} has never joined this server`);
    }

    return {
      name,
      uuid,
      online,
      source,
      savedAt,
      gameMode: state?.gameMode ?? null,
      health: state?.health ?? null,
      maxHealth: state?.maxHealth ?? 20,
      absorption: state?.absorption ?? 0,
      food: state?.food ?? null,
      saturation: state?.saturation ?? null,
      xpLevel: state?.xpLevel ?? null,
      xpProgress: state?.xpProgress ?? null,
      xpTotal: state?.xpTotal ?? null,
      position: state?.position ?? null,
      respawn: state?.respawn ?? null,
      lastDeath: state?.lastDeath ?? null,
      inventory: state?.inventory ?? null,
      enderChest: state?.enderChest ?? null,
      stats,
      advancements,
      status,
      sessions: {
        count: sessions.length,
        firstSeen: sessions.reduce<string | null>(
          (m, s) => (!m || s.joinedAt < m ? s.joinedAt : m),
          null,
        ),
        lastSeen: online
          ? nowIso()
          : sessions.reduce<string | null>(
              (m, s) => (s.leftAt && (!m || s.leftAt > m) ? s.leftAt : m),
              null,
            ),
      },
      mcVersion: row.mcVersion,
    };
  }

  /** Run an in-game action on an online player; returns the server's reply. */
  async command(input: {
    serverId: string;
    name: string;
    command: PlayerCommand;
  }): Promise<{ reply: string | null }> {
    const { serverId, name, command: c } = input;
    const snap = this.bus.snapshot(serverId);
    if (snap.status !== "running") throw new ServerError("BAD_STATE", "The server is not running");
    const player = snap.players.find((p) => p.toLowerCase() === name.toLowerCase());
    if (!player) throw new ServerError("BAD_STATE", `${name} is not online`);

    if (c.type === "message") {
      // Through the console, so it reads "Server whispers to you".
      await this.servers.consoleCommand(
        serverId,
        `tell ${player} ${c.text.replace(/[\r\n]+/g, " ")}`,
      );
      return { reply: `Message sent to ${player}` };
    }
    const cmd = (() => {
      switch (c.type) {
        case "kill":
          return `kill ${player}`;
        case "heal":
          return `effect give ${player} minecraft:instant_health 1 10 true`;
        case "feed":
          return `effect give ${player} minecraft:saturation 1 20 true`;
        case "starve":
          return `effect give ${player} minecraft:hunger 30 255 true`;
        case "clear":
          return `clear ${player}`;
        case "gamemode":
          return `gamemode ${c.mode} ${player}`;
        case "teleport": {
          const at = `${c.x} ${c.y} ${c.z}`;
          return c.dimension
            ? `execute in ${c.dimension} run tp ${player} ${at}`
            : `tp ${player} ${at}`;
        }
        case "teleportToPlayer":
          return `tp ${player} ${c.target}`;
        case "give":
          return `give ${player} ${c.item} ${c.count}`;
      }
    })();
    const reply = await this.servers.command(serverId, cmd);
    // The inventory changed: let the next read save again instead of waiting out the throttle.
    if (c.type === "give" || c.type === "clear" || c.type === "kill")
      this.#lastSave.delete(serverId);
    const text = reply?.replace(/§./g, "").trim() || null;
    this.bus.system(serverId, `[players] /${cmd}${text ? ` → ${text}` : ""}`);
    return { reply: text };
  }

  /**
   * `save-all` writes every online player's file (and queues world chunks).
   * Throttled per server so an open player page does not keep the server busy.
   */
  async #saveNow(serverId: string, minIntervalMs: number): Promise<boolean> {
    const last = this.#lastSave.get(serverId) ?? 0;
    if (Date.now() - last < minIntervalMs) return false;
    this.#lastSave.set(serverId, Date.now());
    try {
      await this.servers.command(serverId, "save-all");
      return true;
    } catch {
      return false; // the saved file is still worth showing
    }
  }

  /** Small fields read straight from the running server. */
  async #liveFields(serverId: string, name: string): Promise<NbtCompound> {
    const out: NbtCompound = {};
    for (const key of LIVE_FIELDS) {
      try {
        const reply = await this.servers.command(serverId, `data get entity ${name} ${key}`);
        const value = reply ? parseDataReply(reply) : undefined;
        if (value !== undefined) out[key] = value;
      } catch {
        break; // RCON gone; use what we have
      }
    }
    return out;
  }

  /** The server's player lists; missing files are empty lists. */
  async #lists(row: ServerRow) {
    const agent = this.servers.agentOf(row);
    const read = async <T>(file: string): Promise<T[]> => {
      try {
        const parsed = JSON.parse(await agent.readFile(row.directory, file)) as unknown;
        return Array.isArray(parsed) ? (parsed as T[]) : [];
      } catch {
        return [];
      }
    };
    const [ops, whitelist, bans, usercache] = await Promise.all([
      read<OpEntry>(PLAYER_LIST_FILES.ops),
      read<WhitelistEntry>(PLAYER_LIST_FILES.whitelist),
      read<BanEntry>(PLAYER_LIST_FILES.bans),
      read<UsercacheEntry>(PLAYER_LIST_FILES.usercache),
    ]);
    return { ops, whitelist, bans, usercache };
  }

  /**
   * Where this world keeps player files: under players/ since Minecraft 26.1,
   * in the old folders before. Goes by what is on disk (a world keeps the old
   * layout until 26.1+ first loads it), then by the version.
   */
  async #playerDirs(row: ServerRow) {
    const level = await this.servers.levelName(row);
    const [modern, legacy] = await this.servers
      .agentOf(row)
      .stat(row.directory, [`${level}/players/data`, `${level}/playerdata`])
      .catch(() => []);
    const layout = modern?.exists
      ? "players"
      : legacy?.exists
        ? "legacy"
        : usesPlayersFolder(row.mcVersion)
          ? "players"
          : "legacy";
    return playerFileDirs(level, layout);
  }

  /** Every player the game has saved data for, with their statistics. Cached briefly. */
  async #gameRecords(row: ServerRow): Promise<Map<string, GameRecord>> {
    const hit = this.#records.get(row.id);
    if (hit && Date.now() - hit.at < GAME_RECORDS_TTL_MS) return hit.data;
    const agent = this.servers.agentOf(row);
    const dirs = await this.#playerDirs(row);
    const out = new Map<string, GameRecord>();
    const files = await agent.listDir(row.directory, dirs.data).catch(() => []);
    for (const f of files) {
      const m = /^([0-9a-f-]{36})\.dat$/i.exec(f.name);
      if (m)
        out.set((m[1] as string).toLowerCase(), {
          uuid: (m[1] as string).toLowerCase(),
          savedAt: f.modifiedAt,
          stats: null,
        });
    }
    if (out.size > 0) {
      const stats = await agent
        .readFiles(
          row.directory,
          [...out.keys()].map((u) => `${dirs.stats}/${u}.json`),
        )
        .catch(() => []);
      for (const s of stats) {
        const uuid = /([0-9a-f-]{36})\.json$/i.exec(s.path)?.[1]?.toLowerCase();
        const rec = uuid ? out.get(uuid) : undefined;
        if (rec) rec.stats = parseJson(s.content, summarizeStats);
      }
    }
    this.#records.set(row.id, { at: Date.now(), data: out });
    return out;
  }

  /** Edit the JSON lists of a stopped server; the server reads them at start. */
  async #editLists(
    row: ServerRow,
    action: PlayerActionInput["action"],
    target: string,
    reason: string | undefined,
  ): Promise<void> {
    const agent = this.servers.agentOf(row);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const edit = async <T>(file: string, fn: (list: T[]) => T[]) => {
      let list: T[] = [];
      try {
        const parsed = JSON.parse(await agent.readFile(row.directory, file)) as unknown;
        if (Array.isArray(parsed)) list = parsed as T[];
      } catch {
        list = [];
      }
      await agent.writeFile(row.directory, file, `${JSON.stringify(fn(list), null, 2)}\n`);
    };
    const identity = async () => {
      const props = await this.servers.getProperties(row.id);
      if (props.values["online-mode"] === false) return { uuid: offlineUuid(target), name: target };
      let found: { uuid: string; name: string } | null;
      try {
        found = await lookupPlayer(target);
      } catch (err) {
        throw new ServerError(
          "BAD_STATE",
          `Could not look up ${target} at Mojang (${errMessage(err)}). Start the server and try again.`,
        );
      }
      if (!found)
        throw new ServerError("VALIDATION", `There is no Minecraft account named ${target}`);
      return found;
    };

    switch (action) {
      case "op": {
        const who = await identity();
        const props = await this.servers.getProperties(row.id);
        const level = Number(props.values["op-permission-level"]) || 4;
        await edit<OpEntry>(PLAYER_LIST_FILES.ops, (l) => [
          ...l.filter((o) => !same(o.name, who.name)),
          { uuid: who.uuid, name: who.name, level, bypassesPlayerLimit: false },
        ]);
        break;
      }
      case "deop":
        await edit<OpEntry>(PLAYER_LIST_FILES.ops, (l) => l.filter((o) => !same(o.name, target)));
        break;
      case "whitelist_add": {
        const who = await identity();
        await edit<WhitelistEntry>(PLAYER_LIST_FILES.whitelist, (l) => [
          ...l.filter((w) => !same(w.name, who.name)),
          { uuid: who.uuid, name: who.name },
        ]);
        break;
      }
      case "whitelist_remove":
        await edit<WhitelistEntry>(PLAYER_LIST_FILES.whitelist, (l) =>
          l.filter((w) => !same(w.name, target)),
        );
        break;
      case "ban": {
        const who = await identity();
        await edit<BanEntry>(PLAYER_LIST_FILES.bans, (l) => [
          ...l.filter((b) => !same(b.name, who.name)),
          {
            uuid: who.uuid,
            name: who.name,
            created: banDate(),
            source: "cubehold",
            expires: "forever",
            reason: reason ?? "Banned by an operator.",
          },
        ]);
        break;
      }
      case "pardon":
        await edit<BanEntry>(PLAYER_LIST_FILES.bans, (l) => l.filter((b) => !same(b.name, target)));
        break;
      case "ban_ip":
        await edit<IpBanEntry>(PLAYER_LIST_FILES.ipBans, (l) => [
          ...l.filter((b) => b.ip !== target),
          {
            ip: target,
            created: banDate(),
            source: "cubehold",
            expires: "forever",
            reason: reason ?? "Banned by an operator.",
          },
        ]);
        break;
      case "pardon_ip":
        await edit<IpBanEntry>(PLAYER_LIST_FILES.ipBans, (l) => l.filter((b) => b.ip !== target));
        break;
      case "kick":
        break;
    }
    this.bus.system(row.id, `[players] ${describe(action, target)} (saved to the server's files)`);
  }

  // --- session history ---------------------------------------------------------

  #enqueue(serverId: string, job: () => Promise<void>): void {
    const prev = this.#queue.get(serverId) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => console.error("player tracking failed", err));
    this.#queue.set(serverId, next);
  }

  async #openSessions(serverId: string): Promise<Map<string, number>> {
    let open = this.#open.get(serverId);
    if (!open) {
      // Sessions left open by a previous panel run are resolved by the next #track call.
      const rows = await this.db
        .select({ id: playerSessions.id, name: playerSessions.name })
        .from(playerSessions)
        .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));
      open = new Map(rows.map((r) => [r.name, r.id]));
      this.#open.set(serverId, open);
    }
    return open;
  }

  async #track(serverId: string, players: string[]): Promise<void> {
    const open = await this.#openSessions(serverId);
    const now = nowIso();
    const current = new Set(players);
    for (const [name, id] of open) {
      if (current.has(name)) continue;
      await this.db.update(playerSessions).set({ leftAt: now }).where(eq(playerSessions.id, id));
      open.delete(name);
      this.#records.delete(serverId); // the game saves their data and stats on leave
    }
    for (const name of current) {
      if (open.has(name)) continue;
      const exists = await this.db
        .select({ id: schema.servers.id })
        .from(schema.servers)
        .where(eq(schema.servers.id, serverId))
        .get();
      if (!exists) return; // server deleted meanwhile
      const [inserted] = await this.db
        .insert(playerSessions)
        .values({ serverId, name, joinedAt: now })
        .returning({ id: playerSessions.id });
      if (inserted) open.set(name, inserted.id);
    }
  }
}

function parseJson<T>(text: string | null | undefined, fn: (json: unknown) => T): T | null {
  if (!text) return null;
  try {
    return fn(JSON.parse(text));
  } catch {
    return null;
  }
}

function commandFor(action: PlayerActionInput["action"], target: string, reason?: string): string {
  const r = reason ? ` ${reason}` : "";
  switch (action) {
    case "kick":
      return `kick ${target}${r}`;
    case "ban":
      return `ban ${target}${r}`;
    case "pardon":
      return `pardon ${target}`;
    case "op":
      return `op ${target}`;
    case "deop":
      return `deop ${target}`;
    case "whitelist_add":
      return `whitelist add ${target}`;
    case "whitelist_remove":
      return `whitelist remove ${target}`;
    case "ban_ip":
      return `ban-ip ${target}${r}`;
    case "pardon_ip":
      return `pardon-ip ${target}`;
  }
}

function describe(action: PlayerActionInput["action"], target: string): string {
  const verbs: Record<PlayerActionInput["action"], string> = {
    kick: "Kicked",
    ban: "Banned",
    pardon: "Unbanned",
    op: "Made operator:",
    deop: "Removed operator:",
    whitelist_add: "Whitelisted",
    whitelist_remove: "Removed from whitelist:",
    ban_ip: "Banned IP",
    pardon_ip: "Unbanned IP",
  };
  return `${verbs[action]} ${target}`;
}
