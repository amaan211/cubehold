import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Cloud, LogOut, Moon, Plus, Server, Settings, Sun } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { UnlockBanner } from "@/components/unlock-banner";
import { useTheme } from "@/lib/theme";
import { queryClient, useTRPC } from "@/lib/trpc";

const nav = [
  { to: "/", label: "Servers", icon: Server, exact: true },
  { to: "/hosts", label: "Hosts", icon: Cloud, exact: false },
  { to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { resolved, setTheme } = useTheme();
  const me = useQuery(trpc.auth.me.queryOptions());
  const logout = useMutation(
    trpc.auth.logout.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries();
        await navigate({ to: "/login" });
      },
    }),
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <Logo className="size-7" />
          <span className="text-sm font-semibold tracking-tight">cubehold</span>
        </div>

        <div className="px-3 pb-2">
          <Button asChild size="sm" className="w-full justify-start">
            <Link to="/servers/new">
              <Plus /> New server
            </Link>
          </Button>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          {nav.map(({ to, label, icon: Icon, exact }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact }}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              activeProps={{ className: "bg-muted text-foreground" }}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{me.data?.username ?? "…"}</p>
            <p className="text-xs text-muted-foreground">Owner</p>
          </div>
          <div className="flex shrink-0">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
            >
              {resolved === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Log out"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur md:hidden">
          <Logo className="size-7" />
          <span className="text-sm font-semibold">cubehold</span>
          <div className="ml-auto flex">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
            >
              {resolved === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Log out"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              <LogOut />
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 pb-24 md:p-8">
          <div className="mx-auto w-full max-w-6xl">
            <UnlockBanner />
            {children}
          </div>
        </main>
      </div>

      {/* Phones: the sections at the bottom, within reach of a thumb. */}
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {[
          ...nav.slice(0, 1),
          { to: "/servers/new", label: "New", icon: Plus, exact: true },
          ...nav.slice(1),
        ].map(({ to, label, icon: Icon, exact }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact }}
            className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"
            activeProps={{ className: "text-primary" }}
          >
            <Icon className="size-5" />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
