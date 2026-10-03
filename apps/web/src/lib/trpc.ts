import type { AppRouter } from "@cubehold/server/router";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createTRPCContext, createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (count, err) => {
        // Never retry auth failures; they won't fix themselves.
        if (err instanceof TRPCClientError && err.data?.code === "UNAUTHORIZED") return false;
        return count < 2;
      },
    },
  },
});

export const trpcClient = createTRPCClient<AppRouter>({
  // Batched GETs carry every input in the URL; split them before servers reject it (HTTP 414).
  links: [httpBatchLink({ url: "/trpc", maxURLLength: 2000 })],
});

/** Proxy usable outside React (router loaders). */
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient,
});

/** Hooks for use inside React components. */
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export function errorMessage(err: unknown): string {
  if (err instanceof TRPCClientError) {
    const fieldErrors = err.data?.fieldErrors as Record<string, string[]> | undefined;
    if (fieldErrors) {
      const first = Object.values(fieldErrors).flat()[0];
      if (first) return first;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}
