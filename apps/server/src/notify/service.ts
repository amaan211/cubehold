import {
  DEFAULT_NOTIFY_EVENTS,
  type NotifyEvent,
  type RealtimeEvent,
  type ServerNotifications,
  type ServerStatus,
} from "@cubehold/shared";
import { eq } from "drizzle-orm";
import type { CloudService } from "../cloud/service.js";
import type { PowerState } from "../cloud/types.js";
import { type Db, schema } from "../db/index.js";
import type { RealtimeBus } from "../realtime/bus.js";
import { ServerError, type ServerService } from "../servers/service.js";
import {
  COLORS,
  type DiscordEmbed,
  DiscordSender,
  escapeMarkdown,
  type FetchLike,
} from "./discord.js";

type ServerRow = typeof schema.servers.$inferSelect;

/** A server reported as online when the panel starts is not news. */
const BASELINE_MS = 60_000;

/**
 * Discord notifications through a per-server webhook: starts and stops,
 * crashes, joins and leaves, backups, and power changes of the cloud VM the
 * server runs on. Only transitions the panel sees happen are reported, so a
 * panel restart does not repeat the state of every server.
 */
export class NotificationService {
  readonly #sender: DiscordSender;
  #status = new Map<string, ServerStatus>();
  #players = new Map<string, string[]>();
  #idleStopped = new Set<string>();
  #lastError = new Map<string, string>();
  /** Each server's events are handled one after another, so messages keep their order. */
  #chains = new Map<string, Promise<void>>();
  #startedAt = Date.now();

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly bus: RealtimeBus,
    private readonly cloud: CloudService,
    fetchImpl?: FetchLike,
  ) {
    this.#sender = new DiscordSender(fetchImpl);
  }

  async init(): Promise<void> {
    const rows = await this.db
      .select({ id: schema.servers.id, status: schema.servers.status })
      .from(schema.servers);
    for (const r of rows) {
      const status = r.status as ServerStatus;
      this.#status.set(r.id, status);
      // Servers that are down have nobody online; running ones report their list first.
      if (!ACTIVE.has(status)) this.#players.set(r.id, []);
    }
    this.bus.on("event", (ev) => {
      if (
        ev.type !== "status.changed" &&
        ev.type !== "players.changed" &&
        ev.type !== "task.progress"
      ) {
        return;
      }
      const id = ev.data.serverId;
      const next = (this.#chains.get(id) ?? Promise.resolve())
        .then(() => this.#onEvent(ev))
        .catch((err) => console.warn("notification failed", err));
      this.#chains.set(id, next);
      void next.finally(() => {
        if (this.#chains.get(id) === next) this.#chains.delete(id);
      });
    });
    this.servers.events.on("idleStopped", (id) => this.#idleStopped.add(id));
    this.servers.events.on("removed", (id) => {
      this.#status.delete(id);
      this.#players.delete(id);
    });
    this.cloud.events.on("power", (hostId, power) => {
      void this.#onPower(hostId, power).catch((err) => console.warn("notification failed", err));
    });
  }

  get(row: ServerRow): ServerNotifications & { lastError: string | null } {
    const n = row.settings?.notifications;
    return {
      discordWebhook: n?.discordWebhook ?? null,
      events: n?.events ?? DEFAULT_NOTIFY_EVENTS,
      lastError: this.#lastError.get(row.id) ?? null,
    };
  }

  async set(serverId: string, value: ServerNotifications): Promise<void> {
    await this.servers.row(serverId);
    await this.servers.updateSettings(serverId, { notifications: value });
    this.#lastError.delete(serverId);
  }

  /** A sample message to the given webhook, or the saved one. Throws with Discord's answer. */
  async test(serverId: string, webhook?: string): Promise<void> {
    const row = await this.servers.row(serverId);
    const url = webhook ?? row.settings?.notifications?.discordWebhook;
    if (!url) throw new ServerError("BAD_STATE", "Add a Discord webhook first.");
    try {
      await this.#sender.send(url, {
        ...this.#embed(row, `${escapeMarkdown(row.name)}: test message`, COLORS.blue),
        description: "cubehold will post here when this server starts, stops, crashes, and more.",
      });
    } catch (err) {
      throw new ServerError("VALIDATION", err instanceof Error ? err.message : String(err));
    }
    this.#lastError.delete(serverId);
  }

  async #onEvent(ev: RealtimeEvent): Promise<void> {
    const id = ev.data.serverId;
    switch (ev.type) {
      case "status.changed":
        return this.#onStatus(id, ev.data.status);
      case "players.changed":
        return this.#onPlayers(id, ev.data.players);
      case "task.progress": {
        const t = ev.data;
        if (t.kind !== "backup" || t.state === "running") return;
        if (t.state === "done") {
          return this.#notify(id, "backup", (row) => ({
            ...this.#embed(row, `${escapeMarkdown(row.name)}: backup finished`, COLORS.blue),
            ...(t.message ? { description: escapeMarkdown(t.message) } : {}),
          }));
        }
        return this.#notify(id, "backupFailed", (row) => ({
          ...this.#embed(row, `${escapeMarkdown(row.name)}: backup failed`, COLORS.red),
          description: escapeMarkdown(t.message ?? "The backup did not finish."),
        }));
      }
      default:
        return;
    }
  }

  async #onStatus(id: string, next: ServerStatus): Promise<void> {
    const prev = this.#status.get(id);
    this.#status.set(id, next);
    if (!ACTIVE.has(next)) this.#players.set(id, []);
    if (prev === next || prev === undefined || prev === "installing") return;

    if (next === "running" && prev !== "stopping") {
      return this.#notify(id, "status", async (row) => {
        const address = await this.#address(row);
        return {
          ...this.#embed(row, `${escapeMarkdown(row.name)} is online`, COLORS.green),
          ...(address ? { description: `Join at \`${address}\`` } : {}),
        };
      });
    }
    if (next === "stopped" && (prev === "running" || prev === "stopping" || prev === "starting")) {
      const idle = this.#idleStopped.delete(id);
      return this.#notify(id, "status", (row) => ({
        ...this.#embed(row, `${escapeMarkdown(row.name)} stopped`, COLORS.gray),
        ...(idle ? { description: "Nobody was online, so it stopped to save resources." } : {}),
      }));
    }
    if (next === "sleeping") {
      this.#idleStopped.delete(id);
      return this.#notify(id, "status", (row) => ({
        ...this.#embed(row, `${escapeMarkdown(row.name)} is sleeping`, COLORS.amber),
        description: "Nobody was online. It starts again when a player joins.",
      }));
    }
    if (next === "crashed") {
      return this.#notify(id, "crash", (row) => {
        const crash = row.meta?.crashes?.at(-1);
        const lines = [
          crash?.analysis
            ? `**${escapeMarkdown(crash.analysis.title)}**`
            : "It stopped unexpectedly.",
          crash?.analysis?.hint ? escapeMarkdown(crash.analysis.hint) : null,
          crash?.restartInMs ? `Restarting in ${Math.round(crash.restartInMs / 1000)} s.` : null,
        ].filter(Boolean);
        return {
          ...this.#embed(row, `${escapeMarkdown(row.name)} crashed`, COLORS.red),
          description: lines.join("\n"),
        };
      });
    }
  }

  async #onPlayers(id: string, now: string[]): Promise<void> {
    const before = this.#players.get(id);
    this.#players.set(id, now);
    // The first list after the panel starts is who was already online.
    if (before === undefined && Date.now() - this.#startedAt < BASELINE_MS) return;
    const prev = new Set(before ?? []);
    const next = new Set(now);
    const joined = now.filter((p) => !prev.has(p));
    // Everyone "leaves" when a server stops; the stop message says enough.
    const left = this.#status.get(id) === "running" ? [...prev].filter((p) => !next.has(p)) : [];
    if (joined.length > 0) {
      await this.#notify(id, "players", (row) => ({
        ...this.#embed(row, `${names(joined)} joined ${escapeMarkdown(row.name)}`, COLORS.green),
        description: `${now.length} online`,
      }));
    }
    if (left.length > 0) {
      await this.#notify(id, "players", (row) => ({
        ...this.#embed(row, `${names(left)} left ${escapeMarkdown(row.name)}`, COLORS.gray),
        description: `${now.length} online`,
      }));
    }
  }

  async #onPower(hostId: string, power: PowerState): Promise<void> {
    const text = POWER_TEXT[power];
    if (!text) return;
    const host = await this.db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId)).get();
    if (!host) return;
    const rows = await this.db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.hostId, hostId));
    // One message per webhook, even when several servers on the VM share it.
    const sent = new Set<string>();
    for (const row of rows) {
      const url = this.#webhookFor(row, "vm");
      if (!url || sent.has(url)) continue;
      sent.add(url);
      const address = power === "running" && host.publicIp ? host.publicIp : null;
      await this.#deliver(row, url, {
        ...this.#embed(row, `VM ${escapeMarkdown(host.name)} ${text.title}`, text.color),
        description: [text.detail, address ? `Address: \`${address}\`` : null]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  async #notify(
    serverId: string,
    event: NotifyEvent,
    build: (row: ServerRow) => DiscordEmbed | Promise<DiscordEmbed>,
  ): Promise<void> {
    const row = await this.db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.id, serverId))
      .get();
    if (!row) return;
    const url = this.#webhookFor(row, event);
    if (!url) return;
    await this.#deliver(row, url, await build(row));
  }

  #webhookFor(row: ServerRow, event: NotifyEvent): string | null {
    const n = row.settings?.notifications;
    if (!n?.discordWebhook) return null;
    return n.events.includes(event) ? n.discordWebhook : null;
  }

  async #deliver(row: ServerRow, url: string, embed: DiscordEmbed): Promise<void> {
    try {
      await this.#sender.send(url, embed);
      this.#lastError.delete(row.id);
    } catch (err) {
      // Shown on the notifications card; nothing else depends on Discord.
      this.#lastError.set(row.id, err instanceof Error ? err.message : String(err));
    }
  }

  #embed(row: ServerRow, title: string, color: number): DiscordEmbed {
    return {
      title,
      color,
      timestamp: new Date().toISOString(),
      footer: { text: `${row.software} ${row.mcVersion} · cubehold` },
    };
  }

  /** The address players use, when the host has a public one (VPS and cloud hosts). */
  async #address(row: ServerRow): Promise<string | null> {
    const host = await this.db
      .select({ publicIp: schema.hosts.publicIp, kind: schema.hosts.kind })
      .from(schema.hosts)
      .where(eq(schema.hosts.id, row.hostId))
      .get();
    if (!host?.publicIp || host.kind === "local") return null;
    return row.port === 25565 ? host.publicIp : `${host.publicIp}:${row.port}`;
  }
}

const ACTIVE = new Set<ServerStatus>(["starting", "running", "stopping"]);

const POWER_TEXT: Partial<Record<PowerState, { title: string; detail: string; color: number }>> = {
  running: { title: "is running", detail: "Its servers can start now.", color: COLORS.green },
  stopped: {
    title: "is off",
    detail: "Press Start on a server to boot it again.",
    color: COLORS.gray,
  },
  hibernated: {
    title: "was saved and deleted",
    detail: "Only its snapshot is billed now. Press Start on a server to restore it.",
    color: COLORS.gray,
  },
  missing: {
    title: "is missing",
    detail: "The cloud provider no longer lists it. Check your provider's console.",
    color: COLORS.amber,
  },
};

function names(list: string[]): string {
  const escaped = list.map(escapeMarkdown);
  if (escaped.length <= 3) return escaped.join(", ");
  return `${escaped.slice(0, 3).join(", ")} and ${escaped.length - 3} more`;
}
