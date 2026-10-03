import { type AuthStatus, loginInput, SESSION_COOKIE, setupOwnerInput } from "@cubehold/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AuthError, login, ownerExists, setupOwner } from "../../auth/service.js";
import { createSession, destroySession } from "../../auth/session.js";
import { config } from "../../config.js";
import type { Context } from "../context.js";
import { protectedProcedure, publicProcedure, router } from "../trpc.js";

async function issueSession(ctx: Context, userId: string) {
  const { token, expiresAt } = await createSession(ctx.db, userId, {
    userAgent: ctx.req.headers["user-agent"],
    ip: ctx.req.ip,
  });
  ctx.res.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.SECURE_COOKIES,
    expires: expiresAt,
  });
}

function mapAuthError(err: unknown): never {
  if (err instanceof AuthError) {
    const code =
      err.code === "BAD_CREDENTIALS"
        ? "UNAUTHORIZED"
        : err.code === "ALREADY_SETUP"
          ? "CONFLICT"
          : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

export const authRouter = router({
  status: publicProcedure.query(async ({ ctx }): Promise<AuthStatus> => {
    const setup = await ownerExists(ctx.db);
    return {
      needsSetup: !setup,
      authenticated: ctx.user !== null,
      user: ctx.user,
    };
  }),

  setup: publicProcedure.input(setupOwnerInput).mutation(async ({ ctx, input }) => {
    try {
      const user = await setupOwner(ctx.db, ctx.vault, input);
      await issueSession(ctx, user.id);
      return user;
    } catch (err) {
      mapAuthError(err);
    }
  }),

  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    try {
      const user = await login(ctx.db, ctx.vault, input);
      await issueSession(ctx, user.id);
      return user;
    } catch (err) {
      mapAuthError(err);
    }
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) await destroySession(ctx.db, ctx.sessionToken);
    ctx.res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }),

  me: protectedProcedure.query(({ ctx }) => ctx.user),

  /**
   * Unlock the credential store with the password, keeping the session. After
   * a panel restart the session survives but the key does not; remote hosts
   * and tunnels wait for this.
   */
  unlock: protectedProcedure
    .input(z.object({ password: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
      try {
        await login(ctx.db, ctx.vault, { username: ctx.user.username, password: input.password });
        return { unlocked: ctx.vault.isUnlocked() };
      } catch (err) {
        mapAuthError(err);
      }
    }),
});
