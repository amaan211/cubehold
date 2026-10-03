import {
  installModpackInput,
  modpackSearchInput,
  modpackVersionsInput,
  prepareModpackInput,
} from "@cubehold/shared";
import { z } from "zod";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

/** Modrinth modpacks: browse, prepare (download and read), install as a new server. */
export const modpacksRouter = router({
  search: protectedProcedure
    .input(modpackSearchInput)
    .query(wrap(({ ctx, input }) => ctx.services.modpacks.search(input.query, input.offset))),

  versions: protectedProcedure
    .input(modpackVersionsInput)
    .query(wrap(({ ctx, input }) => ctx.services.modpacks.versions(input.projectId))),

  /** Download a version from Modrinth and read it; uploads go through /api/modpacks/upload. */
  prepare: protectedProcedure
    .input(prepareModpackInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.modpacks.fromModrinth(input.versionId, input.iconUrl)),
    ),

  preview: protectedProcedure
    .input(z.object({ packId: z.string().min(1).max(64) }))
    .query(wrap(async ({ ctx, input }) => ctx.services.modpacks.preview(input.packId))),

  install: protectedProcedure
    .input(installModpackInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.modpacks.install(input))),
});
