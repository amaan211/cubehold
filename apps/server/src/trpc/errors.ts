import { AgentUnavailableError } from "@cubehold/agent";
import { TRPCError } from "@trpc/server";
import { HostUnavailableError } from "../hosts/manager.js";
import { ServerError } from "../servers/service.js";

export function mapError(err: unknown): never {
  if (err instanceof AgentUnavailableError || err instanceof HostUnavailableError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  if (err instanceof ServerError) {
    const code =
      err.code === "NOT_FOUND"
        ? "NOT_FOUND"
        : err.code === "CONFLICT"
          ? "CONFLICT"
          : err.code === "VALIDATION"
            ? "BAD_REQUEST"
            : "PRECONDITION_FAILED";
    throw new TRPCError({ code, message: err.message, cause: err.details });
  }
  if (err instanceof Error && !(err instanceof TRPCError)) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message, cause: err });
  }
  throw err;
}

/** Turn service errors into tRPC errors with the right code. */
export const wrap =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      mapError(err);
    }
  };
