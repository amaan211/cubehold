import { serverIdInput, setNotificationsInput, testNotificationInput } from "@cubehold/shared";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

/** Discord notifications per server. */
export const notificationsRouter = router({
  get: protectedProcedure
    .input(serverIdInput)
    .query(
      wrap(async ({ ctx, input }) =>
        ctx.services.notifications.get(await ctx.services.servers.row(input.serverId)),
      ),
    ),

  set: protectedProcedure.input(setNotificationsInput).mutation(
    wrap(({ ctx, input }) =>
      ctx.services.notifications.set(input.serverId, {
        discordWebhook: input.discordWebhook,
        events: input.events,
      }),
    ),
  ),

  /** Post a sample message; fails with Discord's answer when the webhook does not work. */
  test: protectedProcedure
    .input(testNotificationInput)
    .mutation(
      wrap(({ ctx, input }) =>
        ctx.services.notifications.test(input.serverId, input.discordWebhook),
      ),
    ),
});
