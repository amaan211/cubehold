import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";

/** Pathless layout: everything under it requires a logged-in owner. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery(context.trpc.auth.status.queryOptions());
    if (status.needsSetup) throw redirect({ to: "/setup" });
    if (!status.authenticated) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    return { user: status.user };
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
