import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { trpc } from "@/lib/trpc";

export interface RouterContext {
  queryClient: QueryClient;
  trpc: typeof trpc;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <div className="grid min-h-dvh place-items-center p-8 text-center">
      <div>
        <p className="text-6xl font-semibold tracking-tight">404</p>
        <p className="mt-2 text-muted-foreground">That page does not exist.</p>
      </div>
    </div>
  ),
});
