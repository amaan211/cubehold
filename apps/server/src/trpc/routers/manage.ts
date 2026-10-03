import {
  addonFileInput,
  addonInstallInput,
  addonRemoveInput,
  addonSearchInput,
  addonToggleInput,
  archivePathsInput,
  backupIdInput,
  createBackupInput,
  createScheduleInput,
  deletePathsInput,
  extractArchiveInput,
  filePathInput,
  itemIconsInput,
  playerActionInput,
  playerCommandInput,
  playerDetailsInput,
  previewCronInput,
  renamePathInput,
  restoreBackupInput,
  scheduleIdInput,
  serverIdInput,
  setWhitelistInput,
  updateScheduleInput,
  writeFileInput,
} from "@cubehold/shared";
import { z } from "zod";
import { ServerError } from "../../servers/service.js";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

export const playersRouter = router({
  overview: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.players.overview(input.serverId))),
  action: protectedProcedure
    .input(playerActionInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.players.action(input))),
  setWhitelist: protectedProcedure
    .input(setWhitelistInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.players.setWhitelist(input.serverId, input.enabled)),
    ),
  /** Health, inventory, ender chest, locations and statistics of one player. */
  details: protectedProcedure
    .input(playerDetailsInput)
    .query(
      wrap(({ ctx, input }) =>
        ctx.services.players.details(input.serverId, input.name, { fresh: input.fresh }),
      ),
    ),
  command: protectedProcedure
    .input(playerCommandInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.players.command(input))),
});

export const assetsRouter = router({
  /** How to draw items (and their English names) for one Minecraft version. */
  icons: protectedProcedure.input(itemIconsInput).query(
    wrap(async ({ ctx, input }) => {
      try {
        return await ctx.services.assets.icons(input.mcVersion, input.ids);
      } catch (err) {
        throw new ServerError("BAD_STATE", err instanceof Error ? err.message : String(err));
      }
    }),
  ),
  catalog: protectedProcedure
    .input(z.object({ mcVersion: z.string().min(1).max(64) }))
    .query(wrap(({ ctx, input }) => ctx.services.assets.catalog(input.mcVersion))),
});

export const filesRouter = router({
  list: protectedProcedure
    .input(filePathInput)
    .query(wrap(({ ctx, input }) => ctx.services.files.list(input.serverId, input.path))),
  read: protectedProcedure
    .input(filePathInput)
    .query(wrap(({ ctx, input }) => ctx.services.files.read(input.serverId, input.path))),
  write: protectedProcedure
    .input(writeFileInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.files.write(input.serverId, input.path, input.content)),
    ),
  mkdir: protectedProcedure
    .input(filePathInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.files.mkdir(input.serverId, input.path))),
  rename: protectedProcedure
    .input(renamePathInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.files.rename(input.serverId, input.from, input.to)),
    ),
  remove: protectedProcedure
    .input(deletePathsInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.files.remove(input.serverId, input.paths))),
  archive: protectedProcedure
    .input(archivePathsInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.files.archive(input.serverId, input.dir, input.names, input.archiveName),
      ),
    ),
  extract: protectedProcedure
    .input(extractArchiveInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.files.extract(input.serverId, input.path, input.into)),
    ),
});

export const backupsRouter = router({
  list: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.backups.list(input.serverId))),
  create: protectedProcedure.input(createBackupInput).mutation(
    wrap(({ ctx, input }) =>
      ctx.services.backups.create(input.serverId, {
        label: input.label,
        scope: input.scope,
        kind: "manual",
      }),
    ),
  ),
  remove: protectedProcedure
    .input(backupIdInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.backups.remove(input.serverId, input.backupId)),
    ),
  restore: protectedProcedure.input(restoreBackupInput).mutation(
    wrap(({ ctx, input }) =>
      ctx.services.backups.restore(input.serverId, input.backupId, {
        safetyBackup: input.safetyBackup,
        startAfter: input.startAfter,
      }),
    ),
  ),
});

const scheduleFields = (input: z.infer<typeof createScheduleInput>) => ({
  name: input.name,
  cron: input.cron,
  action: input.action,
  payload: input.payload,
  warnSeconds: input.warnSeconds,
  enabled: input.enabled,
});

export const schedulesRouter = router({
  list: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.schedules.list(input.serverId))),
  preview: protectedProcedure
    .input(previewCronInput)
    .query(({ ctx, input }) => ctx.services.schedules.preview(input.cron)),
  create: protectedProcedure
    .input(createScheduleInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.schedules.create(input.serverId, scheduleFields(input)),
      ),
    ),
  update: protectedProcedure
    .input(updateScheduleInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.schedules.update(input.serverId, input.scheduleId, scheduleFields(input)),
      ),
    ),
  remove: protectedProcedure
    .input(scheduleIdInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.schedules.remove(input.serverId, input.scheduleId)),
    ),
  runNow: protectedProcedure
    .input(scheduleIdInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.schedules.runNow(input.serverId, input.scheduleId)),
    ),
});

export const addonsRouter = router({
  info: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.addons.info(input.serverId))),
  search: protectedProcedure
    .input(addonSearchInput)
    .query(
      wrap(({ ctx, input }) =>
        ctx.services.addons.search(input.serverId, input.source, input.query, input.offset),
      ),
    ),
  installed: protectedProcedure
    .input(serverIdInput.extend({ checkUpdates: z.boolean().default(true) }))
    .query(
      wrap(({ ctx, input }) => ctx.services.addons.installed(input.serverId, input.checkUpdates)),
    ),
  install: protectedProcedure
    .input(addonInstallInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.addons.install(
          input.serverId,
          input.source,
          input.projectId,
          input.withDependencies,
        ),
      ),
    ),
  update: protectedProcedure
    .input(addonFileInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.addons.update(input.serverId, input.file))),
  remove: protectedProcedure
    .input(addonRemoveInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.addons.remove(input.serverId, input.file, input.deleteConfig),
      ),
    ),
  toggle: protectedProcedure
    .input(addonToggleInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.addons.toggle(input.serverId, input.file, input.enabled),
      ),
    ),
});
