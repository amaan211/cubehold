import {
  addHostInput,
  hardenHostInput,
  hostIdInput,
  removeHostInput,
  renameHostInput,
  retryHostInput,
  sshLoginInput,
} from "@cubehold/shared";
import { z } from "zod";
import { errMessage, ServerError } from "../../servers/service.js";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

/** SSH and network failures are expected answers here, not server errors. */
const soft =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ServerError) throw err;
      throw new ServerError("BAD_STATE", errMessage(err));
    }
  };

export const hostsRouter = router({
  /** Every host with its connection state, machine facts and agent version. */
  list: protectedProcedure.query(wrap(({ ctx }) => ctx.services.hostAdmin.list())),

  /** Log in once with the user's details: host key, system facts, problems. */
  check: protectedProcedure
    .input(sshLoginInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.hostAdmin.check(input)))),

  add: protectedProcedure
    .input(addHostInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.hostAdmin.add(input)))),

  /** Progress of the setup, repair or update running (or last run) for a host. */
  job: protectedProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.hostAdmin.job(input.hostId)),

  retry: protectedProcedure.input(retryHostInput).mutation(
    wrap(
      soft(async ({ ctx, input }) => {
        await ctx.services.hostAdmin.retry(input.hostId, input.login);
        return { ok: true };
      }),
    ),
  ),

  reconnect: protectedProcedure.input(hostIdInput).mutation(
    wrap(
      soft(async ({ ctx, input }) => {
        await ctx.services.hostAdmin.reconnect(input.hostId);
        return { ok: true };
      }),
    ),
  ),

  /** Reinstall and restart the agent (or update it to the panel's version). */
  repair: protectedProcedure
    .input(z.object({ hostId: z.string().min(1), update: z.boolean().default(false) }))
    .mutation(
      wrap(
        soft(async ({ ctx, input }) => {
          await ctx.services.hostAdmin.repair(input.hostId, input.update ? "update" : "repair");
          return { ok: true };
        }),
      ),
    ),

  rename: protectedProcedure.input(renameHostInput).mutation(
    wrap(async ({ ctx, input }) => {
      await ctx.services.hostAdmin.rename(input.hostId, input.name);
      return { ok: true };
    }),
  ),

  remove: protectedProcedure
    .input(removeHostInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.hostAdmin.remove(input.hostId, input)))),

  /** Firewall, fail2ban, automatic updates and SSH login settings (read as root over SSH). */
  security: protectedProcedure
    .input(hostIdInput)
    .query(
      wrap(soft(({ ctx, input }) => ctx.services.hostAdmin.security(input.hostId, input.refresh))),
    ),

  harden: protectedProcedure
    .input(hardenHostInput)
    .mutation(
      wrap(soft(({ ctx, input }) => ctx.services.hostAdmin.harden(input.hostId, input.action))),
    ),
});
