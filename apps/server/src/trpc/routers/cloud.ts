import { AWS_POLICY } from "@cubehold/providers";
import {
  addCloudAccountInput,
  cloudAccountInput,
  cloudPowerInput,
  cloudSizesInput,
  createCloudHostInput,
} from "@cubehold/shared";
import { z } from "zod";
import { errMessage, ServerError } from "../../servers/service.js";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

/** Provider and network failures are answers for the user, not server errors. */
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

export const cloudRouter = router({
  /** Supported providers, the steps to make a token, and the AWS policy to paste. */
  providers: protectedProcedure.query(({ ctx }) => ({
    providers: ctx.services.cloud.providers(),
    awsPolicy: JSON.stringify(AWS_POLICY, null, 2),
  })),

  accounts: protectedProcedure.query(wrap(({ ctx }) => ctx.services.cloud.accounts())),

  addAccount: protectedProcedure
    .input(addCloudAccountInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.cloud.addAccount(input)))),

  removeAccount: protectedProcedure
    .input(cloudAccountInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.cloud.removeAccount(input.accountId))),

  regions: protectedProcedure
    .input(cloudAccountInput)
    .query(wrap(soft(({ ctx, input }) => ctx.services.cloud.regions(input.accountId)))),

  sizes: protectedProcedure
    .input(cloudSizesInput)
    .query(wrap(soft(({ ctx, input }) => ctx.services.cloud.sizes(input.accountId, input.region)))),

  /** Create a VM and set it up as a host; progress shows as the host's setup job. */
  createHost: protectedProcedure
    .input(createCloudHostInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.cloud.createHost(input)))),

  power: protectedProcedure
    .input(cloudPowerInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.cloud.power(input.hostId, input.action)))),

  /** Delete the VM and everything the panel made for it at the provider. */
  removeHost: protectedProcedure
    .input(z.object({ hostId: z.string().min(1) }))
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.cloud.removeHost(input.hostId)))),
});
