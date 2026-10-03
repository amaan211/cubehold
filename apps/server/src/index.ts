import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LOCAL_HOST_ID } from "@cubehold/shared";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { eq } from "drizzle-orm";
import Fastify, { LogController } from "fastify";
import { AssetService } from "./assets/service.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { CloudService } from "./cloud/service.js";
import { config } from "./config.js";
import { createDb, initDb, schema } from "./db/index.js";
import { VERSION, webDir } from "./dist.js";
import { HostManager } from "./hosts/manager.js";
import { HostService } from "./hosts/service.js";
import { registerFileRoutes } from "./http/files.js";
import { registerWebApp } from "./http/web.js";
import { BedrockService } from "./network/bedrock.js";
import { PlayitService } from "./network/playit.js";
import { NetworkService } from "./network/service.js";
import { TailscaleService } from "./network/tailscale.js";
import { TunnelService } from "./network/tunnels.js";
import { NotificationService } from "./notify/service.js";
import { RealtimeBus } from "./realtime/bus.js";
import { registerWebSocket } from "./realtime/ws.js";
import { SecurityService } from "./security/audit.js";
import { KeyVault } from "./security/crypto.js";
import { AddonService } from "./servers/addons.js";
import { BackupService } from "./servers/backups.js";
import { FileService } from "./servers/files.js";
import { ModpackService } from "./servers/modpacks.js";
import { ServerMover } from "./servers/move.js";
import { PlayerService } from "./servers/players.js";
import { ScheduleService } from "./servers/schedules.js";
import { ServerService } from "./servers/service.js";
import { Tasks } from "./servers/tasks.js";
import { createContextFactory } from "./trpc/context.js";
import { type AppRouter, appRouter } from "./trpc/router.js";

async function main() {
  // The data folder holds the database and the agent's token: private to this account (Unix).
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  for (const dir of [config.serversDir, config.backupsDir, config.javaDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = createDb();
  await initDb(db);
  await purgeExpiredSessions(db);

  // Ensure the "local" host row exists: the machine running the panel.
  const existingLocal = await db
    .select({ id: schema.hosts.id })
    .from(schema.hosts)
    .where(eq(schema.hosts.id, LOCAL_HOST_ID))
    .get();
  if (!existingLocal) {
    await db.insert(schema.hosts).values({
      id: LOCAL_HOST_ID,
      name: os.hostname(),
      kind: "local",
      status: "online",
      publicIp: null,
    });
  } else {
    await db
      .update(schema.hosts)
      .set({ status: "online" })
      .where(eq(schema.hosts.id, LOCAL_HOST_ID));
  }

  const vault = new KeyVault(
    config.CUBEHOLD_MASTER_KEY ? Buffer.from(config.CUBEHOLD_MASTER_KEY, "hex") : undefined,
  );

  const bus = new RealtimeBus();
  const hosts = new HostManager();
  await hosts.init({
    dataDir: config.DATA_DIR,
    mode: config.CUBEHOLD_AGENT,
    agentHost: config.CUBEHOLD_AGENT_HOST,
    log: {
      info: (m) => console.log(`[agent] ${m}`),
      warn: (m) => console.warn(`[agent] ${m}`),
    },
  });
  const tasks = new Tasks(bus);
  const serverService = new ServerService(db, hosts, bus, config, tasks);
  // Listeners first: reconcile reports who is online and what is stopped.
  const players = new PlayerService(db, serverService, bus);
  const backups = new BackupService(db, serverService, bus, tasks);
  const schedules = new ScheduleService(db, serverService, backups, bus);
  const files = new FileService(serverService, tasks);
  const addons = new AddonService(serverService, tasks, path.join(config.DATA_DIR, "tmp"));
  const assets = new AssetService(config.assetsDir);
  const modpacks = new ModpackService(serverService, path.join(config.DATA_DIR, "tmp"));
  // Textures are shared per Minecraft version, like Java runtimes: drop versions nobody runs.
  const gcAssets = async () => {
    const rows = await db.select({ v: schema.servers.mcVersion }).from(schema.servers);
    await assets
      .gc(new Set(rows.map((r) => r.v)))
      .catch((err) => console.warn("asset cleanup failed", err));
  };
  serverService.events.on("removed", () => void gcAssets());
  serverService.events.on("versionChanged", () => void gcAssets());
  const playit = new PlayitService(db, hosts, vault, config.DATA_DIR);
  const tunnels = new TunnelService(db, serverService, hosts, vault, config.DATA_DIR);
  const tailscale = new TailscaleService(serverService);
  const hostAdmin = new HostService(db, hosts, serverService, vault);
  const mover = new ServerMover(db, serverService, hosts, tasks, bus);
  // Tests only: a module that stands in for the providers' APIs (never in production).
  const cloudDeps =
    config.CUBEHOLD_FAKE_CLOUD && !config.isProduction
      ? await import(pathToFileURL(config.CUBEHOLD_FAKE_CLOUD).href).then((m) => m.deps())
      : {};
  const cloud = new CloudService(db, hosts, hostAdmin, serverService, vault, bus, cloudDeps);
  // Before hostAdmin.init: VMs that are off must not be dialled.
  cloud.install();
  const network = new NetworkService(
    db,
    serverService,
    hosts,
    hostAdmin,
    playit,
    tunnels,
    tailscale,
    bus,
    config,
  );
  const bedrock = new BedrockService(serverService, addons, network);
  const notifications = new NotificationService(db, serverService, bus, cloud);
  const security = new SecurityService(serverService, players, addons, network, hostAdmin, config);
  // Before reconcile, so it knows each server's state before agents report theirs.
  await notifications.init();
  await serverService.reconcile();
  // Remote hosts connect in the background; their servers reconcile when their agents answer.
  await hostAdmin.init();
  cloud.init();
  await backups.init();
  await schedules.init();
  await gcAssets();
  // Network setup talks to the router and playit.gg; never hold up the panel for it.
  void network.init().catch((err) => console.warn("network init failed", err));
  void playit.init().catch((err) => console.warn("playit init failed", err));
  void tunnels.init().catch((err) => console.warn("tunnel init failed", err));
  const services = {
    servers: serverService,
    players,
    files,
    backups,
    schedules,
    addons,
    assets,
    hosts,
    hostAdmin,
    mover,
    cloud,
    bus,
    network,
    playit,
    tunnels,
    tailscale,
    bedrock,
    security,
    notifications,
    modpacks,
  };

  const app = Fastify({
    logger: config.isDev
      ? { level: "info", transport: { target: "pino-pretty", options: { colorize: true } } }
      : { level: "info" },
    // The web app polls; one log line per request would bury everything else.
    logController: new LogController({ disableRequestLogging: !config.isDev }),
    trustProxy: false,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await registerWebSocket(app, { db, bus });
  await registerFileRoutes(app, { db, files, backups, assets, modpacks });

  app.get("/health", async () => ({ ok: true, version: VERSION }));

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: createContextFactory({ db, vault, services }),
      onError({ path, error }) {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          app.log.error({ err: error, path }, "tRPC internal error");
        }
      },
    } satisfies Parameters<typeof fastifyTRPCPlugin<AppRouter>>[1]["trpcOptions"],
  });

  // Release builds serve the web app themselves; in development Vite does.
  const web = webDir(config.CUBEHOLD_WEB_DIR);
  if (web) await registerWebApp(app, web);

  // Tighter rate limit on auth mutations to slow brute force attempts.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/trpc/auth.login") || req.url.startsWith("/trpc/auth.setup")) {
      const limiter = app.rateLimit({ max: 10, timeWindow: "1 minute" });
      await limiter.call(app, req, reply);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down; Minecraft servers keep running in the agent");
    schedules.dispose();
    cloud.dispose();
    hosts.dispose();
    await app.close();
    vault.lock();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // A long-lived panel must not die because one background job rejected.
  process.on("unhandledRejection", (err) => app.log.error({ err }, "unhandled rejection"));

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`cubehold ${VERSION}, data dir: ${config.DATA_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
