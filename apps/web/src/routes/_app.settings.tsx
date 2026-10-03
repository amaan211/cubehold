import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListChecks, Monitor, Moon, Smartphone, Sun } from "lucide-react";
import { toast } from "sonner";
import { Address } from "@/components/network";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTheme } from "@/lib/theme";
import { queryClient, useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/_app/settings")({
  component: Settings,
});

function Settings() {
  const trpc = useTRPC();
  const { theme, setTheme } = useTheme();
  const overview = useQuery(trpc.system.overview.queryOptions());
  const info = useQuery(trpc.system.info.queryOptions());
  const onboarding = useQuery(trpc.onboarding.get.queryOptions());
  const showOnboarding = useMutation(
    trpc.onboarding.show.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.onboarding.get.queryKey() });
        toast.success("The getting started list is back on the Servers page");
      },
    }),
  );
  const listen = info.data?.listen;
  const loopbackOnly =
    !listen || listen.host === "127.0.0.1" || listen.host === "localhost" || listen.host === "::1";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Panel preferences and status.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Choose how the panel looks on this device.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          {(
            [
              ["light", Sun, "Light"],
              ["dark", Moon, "Dark"],
              ["system", Monitor, "System"],
            ] as const
          ).map(([value, Icon, label]) => (
            <Button
              key={value}
              variant={theme === value ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme(value)}
            >
              <Icon /> {label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4" /> Phone and other devices
          </CardTitle>
          <CardDescription>
            The panel works in a phone's browser, and can be added to the home screen as an app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {loopbackOnly ? (
            <>
              <p>
                Right now the panel only answers on this computer ({listen?.host ?? "127.0.0.1"}),
                which keeps it private. To open it from a phone:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  <span className="text-foreground">Same Wi-Fi:</span> set <code>HOST=0.0.0.0</code>{" "}
                  in <code>%LOCALAPPDATA%\cubehold\launcher.env</code> (Windows app) or the
                  service's environment, then restart the panel. Anyone on your network can then
                  reach the login page, over plain HTTP.
                </li>
                <li>
                  <span className="text-foreground">Anywhere, with HTTPS:</span> install Tailscale
                  on this computer and your phone and run{" "}
                  <code>tailscale serve {listen?.port ?? 4000}</code>. The phone opens the panel at
                  this computer's Tailscale name, and can install it as an app.
                </li>
              </ul>
            </>
          ) : (
            <>
              <p>Open one of these addresses on a device on the same network:</p>
              <ul className="space-y-1">
                {info.data?.lanAddresses.map((a) => (
                  <li key={a}>
                    <Address value={`http://${a}:${listen?.port}`} />
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                This is plain HTTP. Before opening it to the internet, put it behind a reverse proxy
                with HTTPS (or use Tailscale) and set <code>SECURE_COOKIES=true</code>.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {onboarding.data?.dismissed && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ListChecks className="size-4" /> Getting started
              </CardTitle>
              <CardDescription>The first-steps checklist is hidden.</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={showOnboarding.isPending}
              onClick={() => showOnboarding.mutate()}
            >
              Show it again
            </Button>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Credential store</CardTitle>
          <CardDescription>
            Cloud and hosting credentials are encrypted with a master key that is unlocked by your
            password at login.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          Status:{" "}
          <span className={overview.data?.vaultUnlocked ? "text-primary" : "text-destructive"}>
            {overview.data ? (overview.data.vaultUnlocked ? "unlocked" : "locked") : "…"}
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm text-muted-foreground">
          <p>cubehold {info.data?.version ?? ""}</p>
          <p>
            Running on {info.data?.hostname} · Node {info.data?.nodeVersion}
          </p>
          <p>
            <Link to="/servers/modpack" className="text-primary hover:underline">
              Install a modpack
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
