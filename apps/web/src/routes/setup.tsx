import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Blocks } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(context.trpc.auth.status.queryOptions());
    if (!status.needsSetup) throw redirect({ to: status.authenticated ? "/" : "/login" });
  },
  component: Setup,
});

function Setup() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const setup = useMutation(
    trpc.auth.setup.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries();
        await navigate({ to: "/" });
      },
    }),
  );

  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Blocks className="size-5" />
          </span>
          <CardTitle className="mt-2 text-lg">Create your owner account</CardTitle>
          <CardDescription>
            This password also unlocks the encrypted store for your cloud credentials. There is no
            reset, so keep it safe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (mismatch) return;
              setup.mutate({ username, password });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">At least 10 characters.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                aria-invalid={mismatch}
              />
              {mismatch && <p className="text-xs text-destructive">Passwords do not match.</p>}
            </div>
            {setup.error && (
              <p className="text-sm text-destructive" role="alert">
                {errorMessage(setup.error)}
              </p>
            )}
            <Button
              type="submit"
              disabled={setup.isPending || !username || password.length < 10 || mismatch}
            >
              {setup.isPending ? "Creating…" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
