import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        fieldErrors:
          error.cause instanceof ZodError ? error.cause.flatten().fieldErrors : undefined,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

const requireAuth = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please log in" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireAuth);
