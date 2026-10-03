import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloudService } from "../cloud/service.js";
import { createDb, initDb, schema } from "../db/index.js";
import { RealtimeBus } from "../realtime/bus.js";
import type { ServerService } from "../servers/service.js";
import { DiscordSender, escapeMarkdown } from "./discord.js";
import { NotificationService } from "./service.js";

const WEBHOOK =
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123";

interface Post {
  url: string;
  body: { embeds: Array<{ title: string; description?: string }>; allowed_mentions: unknown };
}

function fakeDiscord(responses: number[] = []) {
  const posts: Post[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    const status = responses.shift() ?? 204;
    return new Response(status === 429 ? JSON.stringify({ retry_after: 0.01 }) : null, {
      status,
      headers: status === 429 ? { "content-type": "application/json" } : {},
    });
  };
  return { posts, fetchImpl };
}

describe("DiscordSender", () => {
  it("waits out rate limits and never pings", async () => {
    const d = fakeDiscord([429, 204]);
    await new DiscordSender(d.fetchImpl).send(WEBHOOK, { title: "hi", color: 1 });
    expect(d.posts).toHaveLength(2);
    expect(d.posts[1]?.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("says so when the webhook was deleted", async () => {
    const d = fakeDiscord([404]);
    await expect(
      new DiscordSender(d.fetchImpl).send(WEBHOOK, { title: "hi", color: 1 }),
    ).rejects.toThrow(/does not exist/);
  });

  it("escapes Markdown in player names", () => {
    expect(escapeMarkdown("Steve_the_1st *x*")).toBe("Steve\\_the\\_1st \\*x\\*");
  });
});

describe("NotificationService", () => {
  let dir: string;
  let db: ReturnType<typeof createDb>;
  const bus = new RealtimeBus();
  const serverEvents = new EventEmitter();
  const cloudEvents = new EventEmitter();
  const discord = fakeDiscord();
  let service: NotificationService;

  const settle = () => new Promise((r) => setTimeout(r, 50));
  const titles = () => discord.posts.map((p) => p.body.embeds[0]?.title);

  beforeAll(async () => {
    // One fixed folder: libsql keeps the file open until the process exits, so the
    // previous run's copy is cleared here rather than at the end.
    dir = path.join(os.tmpdir(), "cubehold-notify-test");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    db = createDb(path.join(dir, "test.db"));
    await initDb(db);
    await db
      .insert(schema.hosts)
      .values({ id: "local", name: "pc", kind: "local", status: "online" });
    const base = {
      hostId: "local",
      software: "paper",
      mcVersion: "1.21.11",
      javaVersion: 21,
      memoryMb: 2048,
      port: 25565,
      directory: dir,
      meta: {},
    };
    await db.insert(schema.servers).values([
      {
        ...base,
        id: "s1",
        name: "Survival",
        status: "stopped",
        settings: {
          notifications: { discordWebhook: WEBHOOK, events: ["status", "crash", "players"] },
        },
      },
      {
        ...base,
        id: "s2",
        name: "Creative",
        port: 25566,
        status: "running",
        settings: { notifications: { discordWebhook: WEBHOOK, events: ["status"] } },
      },
    ]);
    const servers = { events: serverEvents } as unknown as ServerService;
    const cloud = { events: cloudEvents } as unknown as CloudService;
    service = new NotificationService(db, servers, bus, cloud, discord.fetchImpl);
    await service.init();
  });

  afterAll(() => {
    db.$client.close();
    // Windows may hold the database file for a moment after closing.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  });

  it("does not repeat what was already true when the panel started", async () => {
    // What agents report right after a panel restart.
    bus.seed("s2", { status: "running", players: ["Alex"], console: [] });
    await settle();
    expect(discord.posts).toHaveLength(0);
  });

  it("reports a start", async () => {
    bus.setStatus("s1", "starting");
    bus.setStatus("s1", "running");
    await settle();
    expect(titles()).toEqual(["Survival is online"]);
  });

  it("reports joins and leaves, but not everyone leaving on a stop", async () => {
    bus.publish({ type: "players.changed", data: { serverId: "s1", at: 0, players: ["Steve_1"] } });
    await settle();
    bus.publish({ type: "players.changed", data: { serverId: "s1", at: 0, players: [] } });
    await settle();
    expect(titles().slice(1)).toEqual(["Steve\\_1 joined Survival", "Steve\\_1 left Survival"]);

    bus.publish({ type: "players.changed", data: { serverId: "s1", at: 0, players: ["Alex"] } });
    await settle();
    serverEvents.emit("idleStopped", "s1");
    bus.setStatus("s1", "stopping");
    bus.publish({ type: "players.changed", data: { serverId: "s1", at: 0, players: [] } });
    bus.setStatus("s1", "stopped");
    await settle();
    expect(titles().slice(3)).toEqual(["Alex joined Survival", "Survival stopped"]);
    expect(discord.posts.at(-1)?.body.embeds[0]?.description).toMatch(/Nobody was online/);
  });

  it("reports a crash with the analysis", async () => {
    await db
      .update(schema.servers)
      .set({
        meta: {
          crashes: [
            {
              at: new Date().toISOString(),
              code: 1,
              reason: "crash",
              report: null,
              restartInMs: 10_000,
              analysis: {
                cause: "oom",
                title: "Out of memory",
                hint: "Give it more memory.",
                suspects: [],
                exception: null,
              },
            },
          ],
        },
      })
      .where((await import("drizzle-orm")).eq(schema.servers.id, "s1"));
    bus.setStatus("s1", "starting");
    bus.setStatus("s1", "running");
    bus.setStatus("s1", "crashed");
    await settle();
    const last = discord.posts.at(-1)?.body.embeds[0];
    expect(last?.title).toBe("Survival crashed");
    expect(last?.description).toContain("Out of memory");
    expect(last?.description).toContain("Restarting in 10 s");
  });

  it("only sends the events a server asked for", async () => {
    const before = discord.posts.length;
    bus.publish({
      type: "players.changed",
      data: { serverId: "s2", at: 0, players: ["Alex", "Bob"] },
    });
    await settle();
    expect(discord.posts.length).toBe(before);
  });
});
