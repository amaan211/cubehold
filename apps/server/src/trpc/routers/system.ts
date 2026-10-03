import os from "node:os";
import { LOCAL_HOST_ID } from "@cubehold/shared";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { schema } from "../../db/index.js";
import { VERSION } from "../../dist.js";
import { protectedProcedure, router } from "../trpc.js";

const { hosts, servers } = schema;

export const systemRouter = router({
  /** Basic facts about the machine running the panel (the "local" host). */
  info: protectedProcedure.query(() => ({
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    nodeVersion: process.version,
    uptimeSec: Math.round(os.uptime()),
    vaultUnlocked: true,
    version: VERSION,
    /** Where the panel listens, so the web app can say how other devices reach it. */
    listen: { host: config.HOST, port: config.PORT },
    lanAddresses: Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => a?.address as string),
  })),

  /** Summary counts for the dashboard shell. */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const hostRows = await ctx.db.select().from(hosts);
    const serverRows = await ctx.db.select().from(servers);
    const local = hostRows.find((h) => h.id === LOCAL_HOST_ID) ?? null;
    return {
      hosts: hostRows.length,
      servers: serverRows.length,
      running: serverRows.filter((s) => s.status === "running").length,
      localHost: local ? { id: local.id, name: local.name, status: local.status } : null,
      vaultUnlocked: ctx.vault.isUnlocked(),
    };
  }),

  hosts: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.db.select().from(hosts)).map((h) => ({
      id: h.id,
      name: h.name,
      kind: h.kind,
      provider: h.provider,
      status: h.status,
      publicIp: h.publicIp,
      createdAt: h.createdAt,
    })),
  ),

  servers: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.db.select().from(servers)).map((s) => ({
      id: s.id,
      hostId: s.hostId,
      name: s.name,
      software: s.software,
      mcVersion: s.mcVersion,
      javaVersion: s.javaVersion,
      memoryMb: s.memoryMb,
      port: s.port,
      status: s.status,
      createdAt: s.createdAt,
    })),
  ),

  /** Used by the dashboard to render the local host card even before any server exists. */
  localHost: protectedProcedure.query(async ({ ctx }) => {
    return (await ctx.db.select().from(hosts).where(eq(hosts.id, LOCAL_HOST_ID)).get()) ?? null;
  }),
});
