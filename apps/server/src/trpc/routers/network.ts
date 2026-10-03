import {
  funnelInput,
  hardenInput,
  hostIdInput,
  playitCreateInput,
  reachabilityInput,
  securityFixInput,
  serverIdInput,
  setBedrockInput,
  setUpnpInput,
  shareInput,
  tunnelProviderInput,
  tunnelTokenInput,
} from "@cubehold/shared";
import { z } from "zod";
import { errMessage, ServerError } from "../../servers/service.js";
import { wrap } from "../errors.js";
import { protectedProcedure, router } from "../trpc.js";

/** Service errors without a ServerError type still deserve a clear, non-500 answer. */
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

export const networkRouter = router({
  /** A host's addresses, router, port forwards and (for this machine) playit.gg. */
  host: protectedProcedure
    .input(hostIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.network.host(input.hostId, input.refresh))),
  /** How players reach one server, with the last reachability tests. */
  server: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.network.server(input.serverId))),
  setUpnp: protectedProcedure
    .input(setUpnpInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.network.setUpnp(input.serverId, input.enabled)),
    ),
  test: protectedProcedure
    .input(reachabilityInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.network.test(input.serverId, input.via)))),
  fixFirewall: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.network.fixFirewall(input.serverId))),

  playitStatus: protectedProcedure.query(wrap(({ ctx }) => ctx.services.playit.status())),
  playitLink: protectedProcedure.mutation(
    wrap(soft(({ ctx }) => ctx.services.playit.startClaim())),
  ),
  playitCancel: protectedProcedure.mutation(
    wrap(async ({ ctx }) => {
      ctx.services.playit.cancelClaim();
      return { ok: true };
    }),
  ),
  playitUnlink: protectedProcedure.mutation(
    wrap(async ({ ctx }) => {
      await ctx.services.playit.unlink();
      return { ok: true };
    }),
  ),
  /** Ask playit.gg to create this server's tunnel (it may only allow that on its website). */
  playitCreateTunnel: protectedProcedure.input(playitCreateInput).mutation(
    wrap(
      soft(async ({ ctx, input }) => {
        const row = await ctx.services.servers.row(input.serverId);
        const bedrockPort =
          input.kind === "bedrock" ? await ctx.services.servers.bedrockPort(row, false) : null;
        if (input.kind === "bedrock" && !bedrockPort) {
          throw new ServerError("BAD_STATE", "Turn on Bedrock players first");
        }
        return ctx.services.playit.createTunnel({
          name: `${row.name}${input.kind === "bedrock" ? " Bedrock" : ""}`,
          type: input.kind === "bedrock" ? "minecraft-bedrock" : "minecraft-java",
          localPort: bedrockPort ?? row.port,
        });
      }),
    ),
  ),

  ngrokSetToken: protectedProcedure
    .input(tunnelTokenInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.tunnels.ngrokSetToken(input.token))),
  ngrokShare: protectedProcedure
    .input(shareInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.tunnels.ngrokShare(input.serverId, input.enabled)),
    ),
  cloudflaredSetToken: protectedProcedure
    .input(tunnelTokenInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.tunnels.cloudflaredSetToken(input.token))),
  tunnelClear: protectedProcedure.input(tunnelProviderInput).mutation(
    wrap(async ({ ctx, input }) => {
      await ctx.services.tunnels.clear(input.provider);
      return { ok: true };
    }),
  ),
  tunnelRestart: protectedProcedure.input(tunnelProviderInput).mutation(
    wrap(async ({ ctx, input }) => {
      await ctx.services.tunnels.restart(input.provider);
      return { ok: true };
    }),
  ),

  tailscaleLogin: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.tailscale.login(input.serverId)))),
  tailscaleInstall: protectedProcedure
    .input(serverIdInput)
    .mutation(wrap(soft(({ ctx, input }) => ctx.services.tailscale.install(input.serverId)))),
  tailscaleFunnel: protectedProcedure
    .input(funnelInput)
    .mutation(
      wrap(soft(({ ctx, input }) => ctx.services.tailscale.setFunnel(input.serverId, input.port))),
    ),

  /** Start playit again (after an error, or once the secret can be read). */
  playitRestart: protectedProcedure.mutation(
    wrap(async ({ ctx }) => {
      await ctx.services.playit.reconcile();
      return ctx.services.playit.status();
    }),
  ),
});

export const bedrockRouter = router({
  status: protectedProcedure
    .input(serverIdInput)
    .query(wrap(({ ctx, input }) => ctx.services.bedrock.status(input.serverId))),
  set: protectedProcedure
    .input(setBedrockInput)
    .mutation(
      wrap(({ ctx, input }) =>
        input.enabled
          ? ctx.services.bedrock.enable(input.serverId)
          : ctx.services.bedrock.disable(input.serverId).then(() => ({ port: null, notes: [] })),
      ),
    ),
});

export const securityRouter = router({
  report: protectedProcedure
    .input(serverIdInput.extend({ fresh: z.boolean().optional() }))
    .query(
      wrap(({ ctx, input }) => ctx.services.security.report(input.serverId, input.fresh ?? false)),
    ),
  fix: protectedProcedure
    .input(securityFixInput)
    .mutation(wrap(({ ctx, input }) => ctx.services.security.fix(input.serverId, input.checkId))),
  harden: protectedProcedure
    .input(hardenInput)
    .mutation(
      wrap(({ ctx, input }) => ctx.services.security.harden(input.serverId, input.plugins)),
    ),
});
