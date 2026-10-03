import {
  changeVersionInput,
  createServerInput,
  deleteServerInput,
  moveServerInput,
  sendCommandInput,
  serverIdInput,
  setAuthModeInput,
  updatePropertiesInput,
  updateServerInput,
} from "@cubehold/shared";
import { z } from "zod";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

export const serversRouter = router({
  list: protectedProcedure.query(({ ctx }) => ctx.services.servers.list()),

  get: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.servers.get(input.serverId))),

  create: protectedProcedure
    .input(createServerInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.create(input))),

  /** Name, memory, port, JVM arguments, automation, backup retention. */
  update: protectedProcedure
    .input(updateServerInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.update(input))),

  crashes: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.servers.crashes(input.serverId))),

  crashReports: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.servers.crashReports(input.serverId))),

  crashReport: protectedProcedure
    .input(serverIdInput.extend({ file: z.string().min(1).max(255) }))
    .query(wrap(({ ctx, input }) => ctx.services.servers.crashReport(input.serverId, input.file))),

  start: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.start(input.serverId))),

  stop: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.stop(input.serverId))),

  kill: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.kill(input.serverId))),

  restart: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.restart(input.serverId))),

  sendCommand: protectedProcedure
    .input(sendCommandInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.servers.sendCommand(input.serverId, input.command)),
    ),

  /** What a delete would export and free; drives the delete dialog. */
  deletePlan: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.servers.deletePlan(input.serverId))),

  remove: protectedProcedure
    .input(deleteServerInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.servers.remove(input.serverId, input.backup))),

  /** Move to another host with world, settings, history and (optionally) backups. Runs as a task. */
  move: protectedProcedure.input(moveServerInput).mutation(
    wrap(({ ctx, input }) =>
      ctx.services.mover.move(input.serverId, input.hostId, {
        port: input.port,
        includeBackups: input.includeBackups,
      }),
    ),
  ),

  setAuthMode: protectedProcedure
    .input(setAuthModeInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.servers.setAuthMode(input.serverId, input.onlineMode)),
    ),

  versionInfo: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.servers.versionInfo(input.serverId))),

  previewVersionChange: protectedProcedure
    .input(serverIdInput.extend({ mcVersion: z.string().min(1) }))
    .query(
      wrap(({ ctx, input }) =>
        ctx.services.servers.previewVersionChange(input.serverId, input.mcVersion),
      ),
    ),

  changeVersion: protectedProcedure
    .input(changeVersionInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.servers.changeVersion(input.serverId, input.mcVersion, input.worldAction),
      ),
    ),

  properties: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.servers.getProperties(input.serverId))),

  updateProperties: protectedProcedure
    .input(updatePropertiesInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.servers.updateProperties(input.serverId, input.values)),
    ),

  /** Recent console lines and metrics, for pages that do not hold a WebSocket. */
  snapshot: protectedProcedure
    .input(serverIdInput)
    .query(({ ctx, input }) => ctx.services.bus.snapshot(input.serverId)),
});
